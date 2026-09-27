#!/usr/bin/env node
// Records a static snapshot of every API response the SPA needs, so a later
// slice (S2) can serve the demo from GitHub Pages with a service worker
// instead of the Go backend (#1193). This slice only writes the recorder; it
// touches neither the SPA, the service worker, the Vite config nor workflows.
//
// Two recording phases feed one manifest:
//   A. SPA-driven — boots the real throwaway server from scripts/e2e-harness.mjs,
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
// (needs `npx playwright install chromium` once, same as screenshots.mjs).

import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { appRoot, bootServer, restoreBackup, stopServer } from './e2e-harness.mjs';

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

// OpenAPI GET operations deliberately not fetched in phase B, each with the
// reason it cannot or must not be replayed as a static fixture.
const OPENAPI_GET_SKIP = new Map([
    ['/api/token',                   'secret — the static demo must never ship a real token'],
    ['/api/events',                  'SSE stream — the response never completes'],
    ['/api/backup',                  'downloads a full backup zip'],
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
export function fixtureKey(method, urlString) {
    const url = new URL(urlString, 'http://fixture.invalid');
    const params = [...url.searchParams.entries()]
        .filter(([name]) => !CACHE_BUSTER_PARAMS.has(name))
        .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
    const query = params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
    return `${String(method).toUpperCase()} ${url.pathname}${query ? `?${query}` : ''}`;
}

// FNV-1a (32-bit) — a short, dependency-free, deterministic suffix that keeps
// distinct keys apart even when their slugged names collide.
function fnv1aHex(input) {
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
export function fixtureFileName(key, ext) {
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
export function extForContentType(contentType) {
    const base = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (CONTENT_TYPE_EXT.has(base)) return CONTENT_TYPE_EXT.get(base);
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
 * the allowed harness addresses, any e-mail address, and any 32+ char hex run
 * that is neither one of the sanitized placeholders nor part of an extra
 * allowed value (e.g. the harness API token). Empty means clean.
 */
export function findLeaks(text, extraAllowed = []) {
    const source = String(text ?? '');
    const allowed = [...PLACEHOLDER_HEX, ...extraAllowed].filter(Boolean).map(String);
    const hits = new Set();
    for (const match of source.matchAll(IPV4_RE)) {
        if (!ALLOWED_IPV4.has(match[0])) hits.add(match[0]);
    }
    for (const match of source.matchAll(EMAIL_RE)) hits.add(match[0]);
    for (const match of source.matchAll(HEX_RE)) {
        if (allowed.some(value => value.includes(match[0]))) continue;
        hits.add(match[0]);
    }
    return [...hits];
}

/**
 * Minimal, dependency-free scan of openapi.yaml for its GET operation paths.
 * The file is machine-maintained with one path per `  /...:` line and one
 * `    get:` per operation, so a line-based read is enough and avoids pulling
 * a YAML parser in as a dependency.
 */
export function parseOpenApiGetPaths(yamlText) {
    const paths = [];
    let current = null;
    for (const rawLine of String(yamlText ?? '').split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        const pathMatch = /^ {2}(\/[^:]*):\s*$/.exec(line);
        if (pathMatch) {
            current = pathMatch[1];
            continue;
        }
        if (current && /^ {4}get:\s*$/.test(line)) paths.push(current);
    }
    return paths;
}

// ── Recorder state ───────────────────────────────────────────────────────

// manifest key -> { status, contentType, body: Buffer }; last write wins so the
// desktop/phone passes and phase A/phase B converge on one fixture per key.
const recorded = new Map();

function recordResponse(method, urlString, status, contentType, body) {
    if (!body || body.length === 0) return;
    recorded.set(fixtureKey(method, urlString), {
        status,
        contentType: contentType || '',
        body: Buffer.from(body),
    });
}

function isTextContentType(contentType) {
    const base = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (!base) return false;
    return base.startsWith('text/') || base.includes('json') || base.includes('xml')
        || base.includes('javascript') || base.includes('svg');
}

function recordedGet(pathname) {
    for (const [key, entry] of recorded) {
        if (!key.startsWith(`GET ${pathname}`)) continue;
        const rest = key.slice(`GET ${pathname}`.length);
        if (rest === '' || rest.startsWith('?')) return entry;
    }
    return null;
}

// ── Phase A: SPA-driven ──────────────────────────────────────────────────

const PAGE_PROFILES = [
    { name: 'desktop', viewport: { width: 1440, height: 900 } },
    { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

/* eslint-disable no-undef -- the callbacks below run inside the Chromium tab
   via Playwright, where `document` is a real global; ESLint lints this file
   with Node globals only. Same pattern as scripts/screenshots.mjs. */

// Clicks through the DOM directly (not page.click) so the topbar buttons work
// at phone width too, where CSS hides them: the SPA attaches their handlers
// regardless of visibility.
async function clickInPage(page, selector) {
    return page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.click();
        return true;
    }, selector);
}

const VIEWS = [
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
        ready: () => document.querySelectorAll('#beanListUI .lib-item').length > 0,
        after: async page => {
            // Best-effort: the flavor-wheel image is only fetched when its
            // modal opens, and a restored backup may not expose the button.
            if (await clickInPage(page, '[data-action="open-flavor-wheel"]')) {
                await page.waitForSelector('#flavorWheelModal', { state: 'visible', timeout: 5000 }).catch(() => {});
                await clickInPage(page, '#flavorWheelModal .fw-close, #flavorWheelModal [data-action="close-flavor-wheel"]');
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
        nav: '#btnSettings',
        ready: () => document.querySelectorAll('#machinesList .machine-row').length >= 1,
    },
];

async function visitAllViews(page) {
    for (const view of VIEWS) {
        if (!(await clickInPage(page, view.nav))) {
            console.warn(`demo-fixtures: nav ${view.nav} (${view.name}) not found`);
            continue;
        }
        if (view.ready) {
            await page.waitForFunction(view.ready, undefined, { timeout: 15000 }).catch(err => {
                console.warn(`demo-fixtures: ${view.name} not ready: ${err.message}`);
            });
        }
        if (view.after) {
            await view.after(page).catch(err => console.warn(`demo-fixtures: ${view.name} follow-up failed: ${err.message}`));
        }
    }
}

function attachRecorder(page) {
    const pending = [];
    page.on('response', response => {
        let pathname;
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
                console.warn(`demo-fixtures: unreadable response ${method} ${pathname}: ${err.message}`);
            }
        })());
    });
    return pending;
}

async function recordPhaseA(baseUrl) {
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
                // two style overrides mirror screenshots.mjs and smoke.test.mjs.
                await page.waitForFunction(
                    () => !!document.querySelector('[data-i18n="nav_analytics"]'),
                    undefined, { timeout: 15000 },
                ).catch(() => {});
                await page.addStyleTag({ content: '#glpUpdateBanner{display:none!important}' });
                await page.addStyleTag({ content: '#btnLive{display:flex!important}' });
                await visitAllViews(page);
            } catch (err) {
                console.warn(`demo-fixtures: ${profile.name} pass aborted: ${err.message}`);
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

// Which recorded list response supplies the ids for each {id} path, and where
// those ids sit in its body.
const ID_SOURCES = {
    shots:      { listPath: '/api/shots',      pick: body => (body?.shots ?? []).map(item => item.id) },
    shotDump:   { listPath: '/shots.json',     pick: body => (Array.isArray(body) ? body : []).map(item => item.id) },
    beans:      { listPath: '/api/library',    pick: body => (body?.beans ?? []).map(item => item.id) },
    grinders:   { listPath: '/api/library',    pick: body => (body?.grinders ?? []).map(item => item.id) },
    baskets:    { listPath: '/api/library',    pick: body => (body?.baskets ?? []).map(item => item.id) },
    puckScreens:{ listPath: '/api/library',    pick: body => (body?.puckScreens ?? []).map(item => item.id) },
    profiles:   { listPath: '/api/machine/profiles', pick: body => (body?.optionsRaw ?? []).map(item => item.id) },
};

const PARAM_PATH_SOURCES = [
    { match: /^\/api\/shots\/\{id\}$/, kind: 'shots' },
    { match: /^\/api\/shots\/\{id\}\/card$/, kind: 'shots' },
    { match: /^\/api\/shots\/\{id\}\/image$/, kind: 'shots' },
    { match: /^\/api\/library\/bean\/\{id\}\/image$/, kind: 'beans' },
    { match: /^\/api\/library\/grinder\/\{id\}\/image$/, kind: 'grinders' },
    { match: /^\/api\/library\/basket\/\{id\}\/image$/, kind: 'baskets' },
    { match: /^\/api\/library\/puckscreen\/\{id\}\/image$/, kind: 'puckScreens' },
    { match: /^\/api\/machine\/profile\/\{id\}$/, kind: 'profiles' },
];

function idsFromEntry(entry, pick) {
    if (!entry) return [];
    try {
        return pick(JSON.parse(entry.body.toString('utf8'))).filter(id => id !== null && id !== undefined);
    } catch {
        return [];
    }
}

function expandIds(kind) {
    if (kind === 'shots') {
        const primary = idsFromEntry(recordedGet(ID_SOURCES.shots.listPath), ID_SOURCES.shots.pick);
        return primary.length ? primary : idsFromEntry(recordedGet(ID_SOURCES.shotDump.listPath), ID_SOURCES.shotDump.pick);
    }
    const source = ID_SOURCES[kind];
    return idsFromEntry(recordedGet(source.listPath), source.pick);
}

async function tryFetch(baseUrl, apiToken, urlPath) {
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
        console.warn(`demo-fixtures: GET ${urlPath} failed: ${err.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function recordPhaseB(baseUrl, apiToken, getPaths) {
    for (const template of getPaths) {
        if (OPENAPI_GET_SKIP.has(template)) continue;
        const hasParam = /\{[^}]+\}/.test(template);
        const concretes = hasParam ? expandParamPaths(template) : [template];
        for (const concrete of concretes) {
            if (recorded.has(fixtureKey('GET', concrete))) continue;
            const entry = await tryFetch(baseUrl, apiToken, concrete);
            if (entry) recordResponse('GET', baseUrl + concrete, entry.status, entry.contentType, entry.body);
        }
    }
}

function expandParamPaths(template) {
    const source = PARAM_PATH_SOURCES.find(candidate => candidate.match.test(template));
    if (!source) return [];
    return expandIds(source.kind)
        .slice(0, MAX_IDS_PER_PATH)
        .map(id => template.replace(/\{[^}]+\}/, String(id)));
}

// ── Phase B bookkeeping + output ─────────────────────────────────────────

function templateToRegex(template) {
    const pattern = template
        .split('/')
        .map(segment => (/^\{[^}]+\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/');
    return new RegExp(`^${pattern}$`);
}

function missingGetPaths(getPaths) {
    const missing = [];
    for (const template of getPaths) {
        if (OPENAPI_GET_SKIP.has(template)) continue;
        const matcher = templateToRegex(template);
        const found = [...recorded.keys()].some(key => {
            if (!key.startsWith('GET ')) return false;
            const pathOnly = key.slice(4).split('?')[0];
            return matcher.test(pathOnly);
        });
        if (!found) missing.push(template);
    }
    return missing;
}

function collectLeaks(apiToken) {
    const hits = [];
    for (const [key, entry] of recorded) {
        if (!isTextContentType(entry.contentType)) continue;
        for (const value of findLeaks(entry.body.toString('utf8'), [apiToken])) {
            hits.push(`${key}: ${value}`);
        }
    }
    return hits;
}

function writeFixtures(outDir) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const entries = {};
    let totalBytes = 0;
    for (const key of [...recorded.keys()].sort()) {
        const entry = recorded.get(key);
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

// Places a few pending orders through the same public API the kiosk order
// form uses, so the Orders view is not empty. Returns the API token for the
// later authenticated fetches.
async function createPendingOrders(baseUrl) {
    const { apiToken } = await fetch(`${baseUrl}/api/token`).then(response => response.json());
    for (const customer of ['Ada Demo', 'Ben Demo', 'Cora Demo']) {
        const response = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-glp-token': apiToken },
            body: JSON.stringify({ item: 'Espresso', customer }),
        });
        if (!response.ok) console.warn(`demo-fixtures: creating order for ${customer} -> ${response.status}`);
    }
    return apiToken;
}

async function main() {
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
// failure dev-stats.mjs's guard prevents (#527).
const invokedDirectly = process.argv[1] &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
    main()
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}
