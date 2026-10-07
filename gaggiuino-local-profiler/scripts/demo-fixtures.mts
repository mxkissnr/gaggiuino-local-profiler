#!/usr/bin/env node
// Records a static snapshot of every API response the SPA needs, so a later
// slice (S2) can serve the demo from GitHub Pages with a service worker
// instead of the Go backend (#1193). This slice only writes the recorder; it
// touches neither the SPA, the service worker, the Vite config nor workflows.
//
// Two recording phases feed one manifest:
//   A. SPA-driven — boots the real throwaway server from scripts/e2e-harness.mts,
//      restores the sanitized demo backup (gaggiuino-local-profiler/demo/
//      glp-demo-backup.zip, overridable via GLP_DEMO_BACKUP), places a few
//      pending orders, then drives headless Chromium through every view at
//      desktop and phone width. Playwright's response hook captures every
//      /api/ response the SPA makes.
//   B. Spec-driven — parses go/internal/system/openapi.yaml and fetches each
//      GET operation the SPA did not already request in phase A, expanding
//      {id}-style path params from the list responses already recorded.
//
// Output lands in gaggiuino-local-profiler/demo/fixtures/ (git-ignored):
// a manifest.json plus one file per response. Before writing anything every
// text response is scanned for leaked PII (IP literals, e-mail addresses,
// long hex blobs); a hit aborts the run with a non-zero exit.
//
// Run from gaggiuino-local-profiler/: `npm run demo:fixtures`
// (needs `npx playwright install chromium` once, same as screenshots.mts).

import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import type { Page, Response } from 'playwright';
import { appRoot, bootServer, restoreBackup, stopServer } from './e2e-harness.mts';

// Cache-buster query keys the SPA may append to force a fresh fetch; a static
// snapshot must key by the real resource, so both are dropped from fixtureKey.
const CACHE_BUSTER_PARAMS = new Set(['t', '_']);

// Per-request ceiling for phase B. Some machine-facing endpoints block until
// the machine answers, which never happens in the throwaway instance.
const REQUEST_TIMEOUT_MS = 15000;

// Cap the ids a single {id} path is expanded to, so a large restored backup
// cannot turn phase B into hundreds of requests — the shot-card endpoint is
// rate-limited to 30/min (#999) and the list is unbounded.
const MAX_IDS_PER_PATH = 20;

// Path templates exempt from that cap: the JSON shot detail is small and the
// demo needs every shot, while the ~220 KB binary card/image endpoints stay capped.
const UNCAPPED_PARAM_PATHS = new Set(['/api/shots/{id}']);

// OpenAPI GET operations deliberately not fetched in phase B, each with the
// reason it cannot or must not be replayed as a static fixture.
const OPENAPI_GET_SKIP = new Map([
    ['/api/token',                   'secret — the static demo must never ship a real token'],
    ['/api/events',                  'SSE stream — the response never completes'],
    ['/api/backup',                  'downloads a full backup zip'],
    ['/api/debug/machine',           'diagnostic — raw machine status, not demo content'],
    ['/api/debug/export-db',         'downloads the SQLite database'],
    ['/api/import/url',              'requires an external product URL (fetches a third-party page)'],
    ['/api/library/scan/{barcode}',  'external barcode lookup; no barcode to expand from'],
    ['/api/orders/mine',             'requires the HA user id of the caller'],
]);

/**
 * Normalises a request into the manifest key `"<METHOD> <path>?<sorted query>"`.
 * Query params are sorted so ordering differences do not split one resource
 * across two fixtures, and the cache-buster params above are dropped.
 */
export function fixtureKey(method: string, urlString: string): string {
    const url = new URL(urlString, 'http://fixture.invalid');
    const params = [...url.searchParams.entries()]
        .filter(([name]) => !CACHE_BUSTER_PARAMS.has(name))
        .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
    const query = params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
    return `${String(method).toUpperCase()} ${url.pathname}${query ? `?${query}` : ''}`;
}

// FNV-1a (32-bit) — a short, dependency-free, deterministic suffix that keeps
// distinct keys apart even when their slugged names collide.
function fnv1aHex(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * Builds a filesystem-safe fixture name from a manifest key and a bare
 * extension: a slugged key (ASCII letters/digits/hyphens only) plus the short
 * hash suffix, so distinct keys always map to distinct files.
 */
export function fixtureFileName(key: string, ext: string): string {
    const safeExt = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const slug = String(key)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/g, '');
    return `${slug || 'fixture'}-${fnv1aHex(String(key))}.${safeExt}`;
}

const CONTENT_TYPE_EXT = new Map([
    ['application/json', 'json'],
    ['application/zip', 'zip'],
    ['application/octet-stream', 'bin'],
    ['application/pdf', 'pdf'],
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/jpg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
    ['image/svg+xml', 'svg'],
    ['text/plain', 'txt'],
    ['text/html', 'html'],
    ['text/css', 'css'],
    ['text/csv', 'csv'],
]);

/** Maps a Content-Type (with or without parameters) to a bare extension. */
export function extForContentType(contentType: string | null | undefined): string {
    const base = (String(contentType || '').split(';')[0] ?? '').trim().toLowerCase();
    const known = CONTENT_TYPE_EXT.get(base);
    if (known) return known;
    if (base.startsWith('image/')) return base.slice('image/'.length).replace(/[^a-z0-9]/g, '') || 'img';
    if (base.startsWith('text/')) return base.slice('text/'.length).replace(/[^a-z0-9+]/g, '') || 'txt';
    return 'bin';
}

// The only IP literals the throwaway harness legitimately emits: loopback and
// the fake LAN machine seed() adds / the demo backup carries.
const ALLOWED_IPV4 = new Set(['127.0.0.1', '192.168.1.50']);

// Sanitized demo data replaces identifiers with runs of a/b.
const PLACEHOLDER_HEX = ['a'.repeat(32), 'b'.repeat(32)];

const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HEX_RE = /\b[0-9a-f]{32,}\b/gi;

/**
 * Returns the PII-looking strings found in `text`: IPv4 literals other than
 * the allowed harness addresses or the 127.0.0.0/8 loopback range, any e-mail
 * address, and any 32+ char hex run that is neither one of the sanitized
 * placeholders nor part of an extra allowed value (e.g. the harness API
 * token). Empty means clean.
 */
export function findLeaks(text: string, extraAllowed: readonly string[] = []): string[] {
    const source = String(text ?? '');
    const allowed = [...PLACEHOLDER_HEX, ...extraAllowed].filter(Boolean).map(String);
    const hits = new Set<string>();
    for (const match of source.matchAll(IPV4_RE)) {
        const hit = match[0];
        if (ALLOWED_IPV4.has(hit) || hit.startsWith('127.')) continue;
        hits.add(hit);
    }
    for (const match of source.matchAll(EMAIL_RE)) hits.add(match[0]);
    for (const match of source.matchAll(HEX_RE)) {
        const hit = match[0];
        if (allowed.some(value => value.includes(hit))) continue;
        hits.add(hit);
    }
    return [...hits];
}

/**
 * Minimal, dependency-free scan of openapi.yaml for its GET operation paths.
 * The file is machine-maintained with one path per `  /...:` line and one
 * `    get:` per operation, so a line-based read is enough and avoids pulling
 * a YAML parser in as a dependency.
 */
export function parseOpenApiGetPaths(yamlText: string): string[] {
    const paths: string[] = [];
    let current: string | null = null;
    for (const rawLine of String(yamlText ?? '').split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        const pathMatch = /^ {2}(\/[^:]*):\s*$/.exec(line);
        if (pathMatch) {
            current = pathMatch[1] ?? null;
            continue;
        }
        if (current && /^ {4}get:\s*$/.test(line)) paths.push(current);
    }
    return paths;
}

// ── Recorder state ───────────────────────────────────────────────────────

// manifest key -> { status, contentType, body: Buffer }; last write wins so the
// desktop/phone passes and phase A/phase B converge on one fixture per key.
interface RecordedEntry {
    status: number;
    contentType: string;
    body: Buffer;
}

const recorded = new Map<string, RecordedEntry>();

function recordResponse(method: string, urlString: string, status: number, contentType: string, body: Buffer): void {
    if (!body || body.length === 0) return;
    recorded.set(fixtureKey(method, urlString), {
        status,
        contentType: contentType || '',
        body: Buffer.from(body),
    });
}

function isTextContentType(contentType: string): boolean {
    const base = (String(contentType || '').split(';')[0] ?? '').trim().toLowerCase();
    if (!base) return false;
    return base.startsWith('text/') || base.includes('json') || base.includes('xml')
        || base.includes('javascript') || base.includes('svg');
}

function recordedGet(pathname: string): RecordedEntry | null {
    for (const [key, entry] of recorded) {
        if (!key.startsWith(`GET ${pathname}`)) continue;
        const rest = key.slice(`GET ${pathname}`.length);
        if (rest === '' || rest.startsWith('?')) return entry;
    }
    return null;
}

// Every recorded response for a bare GET path across its query variants. The
// paged `/api/shots?limit=...&cursor=...` walk records one entry per page, and
// each page carries a disjoint slice of the shot ids, so expandIds() needs them
// all rather than just the first match.
function recordedGetAll(pathname: string): RecordedEntry[] {
    const entries: RecordedEntry[] = [];
    for (const [key, entry] of recorded) {
        if (!key.startsWith(`GET ${pathname}`)) continue;
        const rest = key.slice(`GET ${pathname}`.length);
        if (rest === '' || rest.startsWith('?')) entries.push(entry);
    }
    return entries;
}

// ── Phase A: SPA-driven ──────────────────────────────────────────────────

interface PageProfile {
    name: string;
    viewport: { width: number; height: number };
    isMobile?: boolean;
    hasTouch?: boolean;
}

const PAGE_PROFILES: readonly PageProfile[] = [
    { name: 'desktop', viewport: { width: 1440, height: 900 } },
    { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

/* eslint-disable no-undef -- the callbacks below run inside the Chromium tab
   via Playwright, where `document` is a real global; ESLint lints this file
   with Node globals only. Same pattern as scripts/screenshots.mts. */

// Clicks through the DOM directly (not page.click) so the topbar buttons work
// at phone width too, where CSS hides them: the SPA attaches their handlers
// regardless of visibility.
function clickInPage(page: Page, selector: string): Promise<boolean> {
    return page.evaluate(sel => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) return false;
        el.click();
        return true;
    }, selector);
}

interface View {
    name: string;
    nav: string;
    ready?: () => boolean;
    after?: (page: Page) => Promise<void>;
}

const VIEWS: readonly View[] = [
    {
        name: 'shots',
        nav: '#btnShots',
        ready: () => document.querySelectorAll('[id^="wrapper-"]').length > 0,
        after: async page => {
            // The first three shot-detail views pull the per-shot endpoints
            // (detail, image) that the list response alone does not.
            const ids = await page.$$eval(
                '[id^="wrapper-"]',
                els => els.slice(0, 3).map(el => el.id.slice('wrapper-'.length)),
            );
            for (const id of ids) {
                await clickInPage(page, `#wrapper-${id}`);
                await page.waitForTimeout(500);
            }
        },
    },
    {
        name: 'library',
        nav: '#btnLibrary',
        // #1330: the shelf renders .lib-shelf-tile (grid) / .lib-shelf-row
        // (list); it no longer emits .lib-item (that class survives only in
        // the detail sheet).
        ready: () => document.querySelectorAll('#beanListUI .lib-shelf-tile, #beanListUI .lib-shelf-row').length > 0,
        after: async page => {
            // Best-effort: the flavor-wheel image is only fetched when its
            // modal opens. #1330 moved the wheel button off the shelf into the
            // bean's detail sheet (and only a flavored bean has one), so open
            // the first bean whose card carries it, then its wheel.
            const flavoredId = await page.evaluate(() => {
                const tiles = [...document.querySelectorAll<HTMLElement>('#beanListUI .lib-shelf-tile, #beanListUI .lib-shelf-row')];
                for (const tile of tiles) {
                    tile.click();
                    if (document.querySelector('#beanSheet [data-action="open-flavor-wheel"]')) return tile.dataset.id ?? null;
                    document.querySelector<HTMLElement>('#beanSheet [data-action="close-bean-sheet"]')?.click();
                }
                return null;
            });
            if (flavoredId) {
                await page.waitForSelector('#beanSheet [data-action="open-flavor-wheel"]', { state: 'visible', timeout: 5000 }).catch(() => {});
                if (await clickInPage(page, '#beanSheet [data-action="open-flavor-wheel"]')) {
                    await page.waitForSelector('#flavorWheelModal', { state: 'visible', timeout: 5000 }).catch(() => {});
                    await clickInPage(page, '#flavorWheelModal .fw-close, #flavorWheelModal [data-action="close-flavor-wheel"]');
                }
                await clickInPage(page, '#beanSheet .lib-sheet-close');
                // The close slides the sheet out before removing it; wait it out
                // so the next view's nav click is not blocked. Best-effort.
                await page.waitForSelector('#beanSheet .lib-sheet', { state: 'hidden', timeout: 2000 }).catch(() => {});
            }
        },
    },
    {
        name: 'analytics',
        nav: '#btnAnalytics',
        ready: () => !!document.querySelector('#analytics-view'),
        after: async page => {
            await page.locator('#worldMapWrap').scrollIntoViewIfNeeded().catch(() => {});
        },
    },
    {
        name: 'maintenance',
        nav: '#btnMaintenance',
        ready: () => document.querySelectorAll('#maintSummary .maint-tile').length > 0,
    },
    {
        name: 'dialin',
        nav: '#btnDialin',
        ready: () => {
            const grid = document.getElementById('dialinGrid');
            return !!grid && grid.children.length > 0;
        },
    },
    {
        name: 'live',
        nav: '#btnLive',
        ready: () => {
            const badge = document.getElementById('live-status-badge');
            return !!badge && !badge.classList.contains('connecting');
        },
    },
    {
        name: 'orders',
        nav: '#btnOrders',
        ready: () => !!document.getElementById('ordersEnabledLabel')?.textContent,
    },
    {
        name: 'settings',
        // #1514: still by id — the button left .topbar-nav-scroll but kept
        // #btnSettings, and clickInPage() clicks it regardless of visibility.
        nav: '#btnSettings',
        ready: () => document.querySelectorAll('#machinesList .machine-row').length >= 1,
    },
];

async function visitAllViews(page: Page): Promise<void> {
    for (const view of VIEWS) {
        if (!(await clickInPage(page, view.nav))) {
            console.warn(`demo-fixtures: nav ${view.nav} (${view.name}) not found`);
            continue;
        }
        if (view.ready) {
            await page.waitForFunction(view.ready, undefined, { timeout: 15000 }).catch((err: unknown) => {
                console.warn(`demo-fixtures: ${view.name} not ready: ${(err as Error).message}`);
            });
        }
        if (view.after) {
            await view.after(page).catch((err: unknown) => console.warn(`demo-fixtures: ${view.name} follow-up failed: ${(err as Error).message}`));
        }
    }
}

function attachRecorder(page: Page): Promise<void>[] {
    const pending: Promise<void>[] = [];
    page.on('response', (response: Response) => {
        let pathname: string;
        try {
            pathname = new URL(response.url()).pathname;
        } catch {
            return;
        }
        if (!pathname.startsWith('/api/')) return;
        if (pathname === '/api/token') return;
        const contentType = (response.headers()['content-type'] || '').toLowerCase();
        if (contentType.includes('text/event-stream')) return;
        const method = response.request().method();
        pending.push((async () => {
            try {
                recordResponse(method, response.url(), response.status(), contentType, await response.body());
            } catch (err) {
                console.warn(`demo-fixtures: unreadable response ${method} ${pathname}: ${(err as Error).message}`);
            }
        })());
    });
    return pending;
}

async function recordPhaseA(baseUrl: string): Promise<void> {
    const browser = await chromium.launch();
    try {
        for (const profile of PAGE_PROFILES) {
            const context = await browser.newContext({
                viewport: profile.viewport,
                isMobile: !!profile.isMobile,
                hasTouch: !!profile.hasTouch,
                locale: 'en-US',
                timezoneId: 'Europe/Berlin',
            });
            await context.addInitScript(() => {
                try { localStorage.setItem('glp_lang', 'en'); } catch { /* ignore */ }
            });
            const page = await context.newPage();
            const pending = attachRecorder(page);
            try {
                await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                // The SPA is loaded once the English nav label rendered; the
                // two style overrides mirror screenshots.mts and smoke.test.mts.
                await page.waitForFunction(
                    () => !!document.querySelector('[data-i18n="nav_analytics"]'),
                    undefined, { timeout: 15000 },
                ).catch(() => {});
                await page.addStyleTag({ content: '#glpUpdateBanner{display:none!important}' });
                await page.addStyleTag({ content: '#btnLive{display:flex!important}' });
                await visitAllViews(page);
            } catch (err) {
                console.warn(`demo-fixtures: ${profile.name} pass aborted: ${(err as Error).message}`);
            }
            await Promise.allSettled(pending);
            await context.close();
        }
    } finally {
        await browser.close();
    }
}

/* eslint-enable no-undef */

// ── Phase B: spec-driven ─────────────────────────────────────────────────

// Ids a {id} path param is expanded from; JSON list responses carry strings or
// numbers, and anything else is dropped rather than stringified.
type FixtureId = string | number;

// Which recorded list response supplies the ids for each {id} path, and where
// those ids sit in its body.
interface IdSource {
    listPath: string;
    pick: (body: unknown) => FixtureId[];
}

type IdKind = 'shots' | 'shotDump' | 'beans' | 'grinders' | 'baskets' | 'puckScreens' | 'profiles';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function idsIn(value: unknown): FixtureId[] {
    return Array.isArray(value)
        ? value
            .map(item => (item as { id?: unknown }).id)
            .filter((id): id is FixtureId => typeof id === 'string' || typeof id === 'number')
        : [];
}

/**
 * Shot ids in one recorded list body, newest first. A `/api/shots` page is
 * `{ shots: [...] }` already ordered newest-first, while the `/shots.json`
 * dump is a bare array ordered timestamp-ASC, so the dump is reversed to keep
 * the caller's newest-first invariant.
 */
export function shotIdsInListBody(body: unknown): FixtureId[] {
    if (Array.isArray(body)) return idsIn(body).reverse();
    return idsIn(asRecord(body)?.['shots']);
}

/**
 * Merges the shot ids from several recorded list bodies into one newest-first
 * list, dropping duplicates so a shot spread across pages (or present in both
 * the paged list and the dump) is expanded once. The first occurrence wins, so
 * the newest page's ordering is preserved.
 */
export function mergeShotIds(bodies: readonly unknown[]): FixtureId[] {
    const ids: FixtureId[] = [];
    const seen = new Set<string>();
    for (const body of bodies) {
        for (const id of shotIdsInListBody(body)) {
            const key = `${typeof id}:${id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            ids.push(id);
        }
    }
    return ids;
}

const ID_SOURCES: Record<IdKind, IdSource> = {
    shots:      { listPath: '/api/shots',            pick: body => idsIn(asRecord(body)?.['shots']) },
    shotDump:   { listPath: '/shots.json',           pick: body => idsIn(body) },
    beans:      { listPath: '/api/library',          pick: body => idsIn(asRecord(body)?.['beans']) },
    grinders:   { listPath: '/api/library',          pick: body => idsIn(asRecord(body)?.['grinders']) },
    baskets:    { listPath: '/api/library',          pick: body => idsIn(asRecord(body)?.['baskets']) },
    puckScreens:{ listPath: '/api/library',          pick: body => idsIn(asRecord(body)?.['puckScreens']) },
    profiles:   { listPath: '/api/machine/profiles', pick: body => idsIn(asRecord(body)?.['optionsRaw']) },
};

interface ParamPathSource {
    match: RegExp;
    kind: IdKind;
}

const PARAM_PATH_SOURCES: readonly ParamPathSource[] = [
    { match: /^\/api\/shots\/\{id\}$/, kind: 'shots' },
    { match: /^\/api\/shots\/\{id\}\/card$/, kind: 'shots' },
    { match: /^\/api\/shots\/\{id\}\/image$/, kind: 'shots' },
    { match: /^\/api\/library\/bean\/\{id\}\/image$/, kind: 'beans' },
    { match: /^\/api\/library\/grinder\/\{id\}\/image$/, kind: 'grinders' },
    { match: /^\/api\/library\/basket\/\{id\}\/image$/, kind: 'baskets' },
    { match: /^\/api\/library\/puckscreen\/\{id\}\/image$/, kind: 'puckScreens' },
    { match: /^\/api\/machine\/profile\/\{id\}$/, kind: 'profiles' },
];

// Query-string variants of a bare GET path that the SPA requests but the
// OpenAPI path scan alone would miss, even though OpenAPI models the query as
// optional (#1497). The SPA already builds the query in
// public-src/api/system.ts, and demo/sw/sw-core.ts deliberately looks fixtures
// up by exact key, so a query-less fallback there would serve one language's
// badges for every language; the fix therefore stays in the recorder. Values
// are query strings with the leading "?".
export const QUERY_VARIANTS: ReadonlyMap<string, readonly string[]> = new Map([
    ['/api/achievements', ['?lang=en', '?lang=de', '?lang=es', '?lang=fr', '?lang=it', '?lang=nl']],
]);

function idsFromEntry(entry: RecordedEntry | null, pick: (body: unknown) => FixtureId[]): FixtureId[] {
    if (!entry) return [];
    try {
        return pick(JSON.parse(entry.body.toString('utf8')) as unknown);
    } catch {
        return [];
    }
}

function parsedBody(entry: RecordedEntry | null): unknown {
    if (!entry) return null;
    try {
        return JSON.parse(entry.body.toString('utf8')) as unknown;
    } catch {
        return null;
    }
}

function expandIds(kind: IdKind): FixtureId[] {
    if (kind === 'shots') {
        // Phase A records at most the first list page, so union every recorded
        // page (the phase B walk below fills the older ones in) with the
        // `/shots.json` dump when the instance served one — otherwise
        // `/api/shots/{id}` is only expanded for the newest shots and older
        // shots the other views link to get no fixture (#1511).
        const bodies = recordedGetAll(ID_SOURCES.shots.listPath).map(entry => parsedBody(entry));
        const dump = recordedGet(ID_SOURCES.shotDump.listPath);
        if (dump) bodies.push(parsedBody(dump));
        return mergeShotIds(bodies);
    }
    const source = ID_SOURCES[kind];
    return idsFromEntry(recordedGet(source.listPath), source.pick);
}

async function tryFetch(baseUrl: string, apiToken: string, urlPath: string): Promise<RecordedEntry | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(baseUrl + urlPath, {
            headers: { 'x-glp-token': apiToken },
            signal: controller.signal,
        });
        return {
            status: response.status,
            contentType: response.headers.get('content-type') || '',
            body: Buffer.from(await response.arrayBuffer()),
        };
    } catch (err) {
        console.warn(`demo-fixtures: GET ${urlPath} failed: ${(err as Error).message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Page size for the shot-list walk below. Mirrors public-src/views/shots/
// index.ts's SHOTS_PAGE_LIMIT, so a page the demo later scrolls to is keyed
// exactly as the SPA would request it (same limit, same cursor chain).
const SHOTS_PAGE_LIMIT = 60;

// Phase A only ever loads the first `GET /api/shots` page, so the expansion
// source for `/api/shots/{id}` would otherwise miss every older shot the
// dial-in, analytics, achievements and comparison views link to (#1511). Walk
// the rest of the keyset-paginated list here, recording each page through the
// same recordResponse() path as the other fetches so the ids and the fixtures
// both exist. The already-recorded first page is reused, not refetched.
async function recordAllShotListPages(baseUrl: string, apiToken: string): Promise<void> {
    let cursor: string | null = null;
    for (;;) {
        const query = new URLSearchParams({ limit: String(SHOTS_PAGE_LIMIT) });
        if (cursor) query.set('cursor', cursor);
        const concrete = `${ID_SOURCES.shots.listPath}?${query.toString()}`;
        let entry = recorded.get(fixtureKey('GET', concrete));
        if (!entry) {
            const fetched = await tryFetch(baseUrl, apiToken, concrete);
            if (!fetched) return;
            recordResponse('GET', baseUrl + concrete, fetched.status, fetched.contentType, fetched.body);
            entry = recorded.get(fixtureKey('GET', concrete));
        }
        const page = asRecord(parsedBody(entry ?? null));
        const next = page?.['nextCursor'];
        cursor = page?.['hasMore'] === true && typeof next === 'string' ? next : null;
        if (!cursor) return;
    }
}

async function recordPhaseB(baseUrl: string, apiToken: string, getPaths: readonly string[]): Promise<void> {
    await recordAllShotListPages(baseUrl, apiToken);
    for (const template of getPaths) {
        if (OPENAPI_GET_SKIP.has(template)) continue;
        const hasParam = /\{[^}]+\}/.test(template);
        const variants = (QUERY_VARIANTS.get(template) ?? []).map(query => `${template}${query}`);
        const concretes = hasParam ? expandParamPaths(template) : [template, ...variants];
        for (const concrete of concretes) {
            if (recorded.has(fixtureKey('GET', concrete))) continue;
            const entry = await tryFetch(baseUrl, apiToken, concrete);
            if (entry) recordResponse('GET', baseUrl + concrete, entry.status, entry.contentType, entry.body);
        }
    }
}

function expandParamPaths(template: string): string[] {
    const source = PARAM_PATH_SOURCES.find(candidate => candidate.match.test(template));
    if (!source) return [];
    const ids = expandIds(source.kind);
    const selected = UNCAPPED_PARAM_PATHS.has(template) ? ids : ids.slice(0, MAX_IDS_PER_PATH);
    return selected.map(id => template.replace(/\{[^}]+\}/, String(id)));
}

// ── Phase B bookkeeping + output ─────────────────────────────────────────

function templateToRegex(template: string): RegExp {
    const pattern = template
        .split('/')
        .map(segment => (/^\{[^}]+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/');
    return new RegExp(`^${pattern}$`);
}

function missingGetPaths(getPaths: readonly string[]): string[] {
    const missing: string[] = [];
    for (const template of getPaths) {
        if (OPENAPI_GET_SKIP.has(template)) continue;
        const matcher = templateToRegex(template);
        const found = [...recorded.keys()].some(key => {
            if (!key.startsWith('GET ')) return false;
            const pathOnly = key.slice(4).split('?')[0] ?? '';
            return matcher.test(pathOnly);
        });
        if (!found) missing.push(template);
    }
    return missing;
}

// Manifest keys the demo cannot work without. They come from the query
// variants above rather than the OpenAPI scan, so a dropped or failed fetch is
// caught here instead of shipping a page that stays empty (#1497).
const REQUIRED_FIXTURE_KEYS: readonly string[] = ['GET /api/achievements?lang=en'];

function missingRequiredKeys(): string[] {
    return REQUIRED_FIXTURE_KEYS.filter(key => !recorded.has(key));
}

function collectLeaks(apiToken: string): string[] {
    const hits: string[] = [];
    for (const [key, entry] of recorded) {
        if (!isTextContentType(entry.contentType)) continue;
        for (const value of findLeaks(entry.body.toString('utf8'), [apiToken])) {
            hits.push(`${key}: ${value}`);
        }
    }
    return hits;
}

function writeFixtures(outDir: string): { count: number; totalBytes: number } {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const entries: Record<string, { status: number; contentType: string; file: string }> = {};
    let totalBytes = 0;
    for (const key of [...recorded.keys()].sort()) {
        const entry = recorded.get(key);
        if (!entry) continue;
        const ext = extForContentType(entry.contentType);
        const file = fixtureFileName(key, ext);
        let body = entry.body;
        if (ext === 'json') {
            try {
                body = Buffer.from(`${JSON.stringify(JSON.parse(entry.body.toString('utf8')), null, 2)}\n`, 'utf8');
            } catch {
                // Keep the raw bytes so a malformed JSON fixture is visible in
                // the output rather than silently dropped.
            }
        }
        writeFileSync(path.join(outDir, file), body);
        totalBytes += body.length;
        entries[key] = { status: entry.status, contentType: entry.contentType, file };
    }
    writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify({ generated: new Date().toISOString(), entries }, null, 2)}\n`);
    return { count: Object.keys(entries).length, totalBytes };
}

// ── Orchestration ────────────────────────────────────────────────────────

interface ApiRequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}

// Authenticated JSON round-trip for the setup calls below. Unlike the
// best-effort phase B fetches, any non-2xx throws so a broken setup fails
// the run instead of silently producing empty views.
async function apiJson<T = unknown>(baseUrl: string, apiToken: string, pathname: string, init: ApiRequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { 'x-glp-token': apiToken, ...(init.headers ?? {}) };
    const response = await fetch(baseUrl + pathname, {
        method: init.method || 'GET',
        headers,
        body: init.body ?? null,
    });
    if (!response.ok) {
        throw new Error(`demo-fixtures: ${init.method || 'GET'} ${pathname} -> ${response.status}`);
    }
    return await response.json() as T;
}

// Places a few pending orders through the same public API the kiosk order
// form uses, so the Orders view is not empty. Returns the API token for the
// later authenticated fetches.
async function createPendingOrders(baseUrl: string): Promise<string> {
    const { apiToken } = (await fetch(`${baseUrl}/api/token`).then(response => response.json())) as { apiToken: string };

    // A restored backup ships orders disabled, so placeOrder() answers 503
    // until the DB setting is switched on through the settings API.
    const settings = await apiJson<Record<string, unknown>>(baseUrl, apiToken, '/api/orders/settings');
    await apiJson(baseUrl, apiToken, '/api/orders/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, enabled: true }),
    });

    // placeOrder() only accepts an item name that exists in the menu, so take
    // one from the restored menu rather than a hard-coded drink.
    const menu = await apiJson<Array<{ name?: string }>>(baseUrl, apiToken, '/api/orders/menu');
    const item = (Array.isArray(menu) ? menu[0]?.name : '') || '';
    if (!item) throw new Error('demo-fixtures: the restored menu has no items to order');

    for (const customer of ['Ada Demo', 'Ben Demo', 'Cora Demo']) {
        await apiJson(baseUrl, apiToken, '/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item, customer }),
        });
    }
    return apiToken;
}

async function main(): Promise<void> {
    const outDir = path.join(appRoot, 'demo', 'fixtures');
    const backupPath = process.env.GLP_DEMO_BACKUP || path.join(appRoot, 'demo', 'glp-demo-backup.zip');
    const openapiPath = path.join(appRoot, 'go', 'internal', 'system', 'openapi.yaml');

    try {
        const baseUrl = await bootServer();
        const restored = await restoreBackup(baseUrl, backupPath);
        console.log(`demo-fixtures: restored ${path.relative(appRoot, backupPath)} (${restored.shots ?? 0} shots)`);

        const apiToken = await createPendingOrders(baseUrl);
        await recordPhaseA(baseUrl);
        console.log(`demo-fixtures: ${recorded.size} responses recorded from the desktop/phone passes`);

        const getPaths = parseOpenApiGetPaths(readFileSync(openapiPath, 'utf8'));
        await recordPhaseB(baseUrl, apiToken, getPaths);

        const leaks = collectLeaks(apiToken);
        if (leaks.length) {
            throw new Error(`refusing to write fixtures — possible personal data leaked:\n${leaks.join('\n')}`);
        }

        const missingKeys = missingRequiredKeys();
        if (missingKeys.length) {
            throw new Error(`refusing to write fixtures — required responses were not recorded:\n${missingKeys.join('\n')}`);
        }

        const { count, totalBytes } = writeFixtures(outDir);
        const missing = missingGetPaths(getPaths);
        console.log(`demo-fixtures: wrote ${count} fixtures (${(totalBytes / 1024).toFixed(1)} KiB) to ${path.relative(process.cwd(), outDir)}`);
        for (const template of missing) {
            console.warn(`demo-fixtures: openapi GET ${template} was neither recorded nor skipped`);
        }
    } finally {
        stopServer();
    }
}

// Only boot the server and write fixtures when invoked as a script. Without
// this guard, importing the pure helpers in a unit test runs the whole
// recorder — and its process.exit() — as an import side effect, the same
// failure dev-stats.mts's guard prevents (#527).
const entryArg = process.argv[1];
const invokedDirectly = entryArg !== undefined && fileURLToPath(import.meta.url) === path.resolve(entryArg);
if (invokedDirectly) {
    main()
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}
