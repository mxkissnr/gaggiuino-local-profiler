#!/usr/bin/env node
// Regenerates docs/screenshots/*.png for the README/wiki. Drives a headless
// Chromium (Playwright) through each view of the throwaway, seeded (or
// backup-restored) instance booted by scripts/e2e-harness.mts (shared with
// test/e2e/smoke.test.mts — see that module for what "throwaway" means: its
// own tmp DATA_DIR and port, never touches /data or 8099). Run on demand:
// `node scripts/screenshots.mts`. Requires `npx playwright install chromium`
// once beforehand.
//
// #1181: by default the README/wiki views are rendered from the sanitized
// demo backup committed at demo/glp-demo-backup.zip, restored into the
// throwaway instance through POST /api/restore. Real data makes the views
// look like actual use rather than the synthetic 12-shot seed. Set
// GLP_SCREENSHOT_BACKUP=/path/to/glp-backup.zip to restore a different backup
// instead; if neither exists the built-in demo seed is used as a fallback. A
// restore that does not succeed aborts the run with a non-zero exit. The
// backup is read into the instance's tmp DATA_DIR, which is deleted along with
// the instance, and the file itself must never be committed
// (`scripts/*.zip` is git-ignored); review any screenshots made from personal
// data before committing them.
//
// #1032: every capture waits for a real readiness signal (a chart canvas
// with non-blank pixels, an ECharts instance that has painted, images
// decoded) instead of a fixed setTimeout — the lazy per-shot curve fetch
// (#957) and the dynamic-import ECharts bundle (#797) both resolve well
// after the old fixed 400ms, so the pre-#1032 images caught half-rendered
// views (empty shot chart, mid-render sunburst).
//
// #1809: every PNG is a full-window page.screenshot() at the same 1400x900
// viewport — no per-view clipping and no height trimming to the content — so
// the set looks consistent side by side and the top nav, with the active tab,
// is visible on every image.
//
// Data source of each PNG (#1185). Every capture comes from the one instance
// loaded for the run: the restored backup (demo/glp-demo-backup.zip by
// default, GLP_SCREENSHOT_BACKUP when it is set) or the built-in demo seed
// when no zip is available. live.png and orders.png are captured in both
// modes too; the Orders view gets three demo orders created by this script
// through the instance's HTTP API, so the queue is never empty.

import { mkdirSync, cpSync, existsSync } from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { appRoot, bootServer, restoreBackup, seed, stopServer } from './e2e-harness.mts';

const outDir = path.join(appRoot, 'docs', 'screenshots');

// #1181: real-backup mode. The committed sanitized demo backup is the default;
// GLP_SCREENSHOT_BACKUP overrides it; the demo seed is the fallback.
const demoBackupPath = path.join(appRoot, 'demo', 'glp-demo-backup.zip');
const backupPath = process.env.GLP_SCREENSHOT_BACKUP
    ?? (existsSync(demoBackupPath) ? demoBackupPath : undefined);
const fromBackup = !!backupPath;

/* eslint-disable no-undef -- the callbacks below are serialised and run
   inside the Chromium tab via Playwright's page.waitForFunction/evaluate,
   where `document` is a real global; ESLint lints this file with Node
   globals only. Same pattern as test/e2e/smoke.test.mts. */

// Runs inside the page: a coarse fingerprint of whatever `sel` resolves to
// as a <canvas> (or an element containing one — ECharts mounts its canvas
// as a child). `null` until the canvas exists and has painted more than one
// flat colour; otherwise a hash of a sparse pixel sample. Covers both
// Chart.js (the canvas is the element) and ECharts (world map, flavor
// wheel) without needing either library's globals.
function canvasFingerprint(sel: string): number | null {
    const host = document.querySelector(sel);
    const canvas = host && (host.tagName === 'CANVAS' ? (host as HTMLCanvasElement) : host.querySelector<HTMLCanvasElement>('canvas'));
    if (!canvas || !canvas.width || !canvas.height) return null;
    let ctx: CanvasRenderingContext2D | null;
    try { ctx = canvas.getContext('2d'); } catch { return null; }
    if (!ctx) return null;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let hash = 0;
    let distinct = 0;
    let first = -1;
    // Prime stride: hits an aperiodic scatter of pixels across the buffer.
    for (let i = 0; i < data.length; i += 1021 * 4) {
        const v = (data[i] ?? 0) + (data[i + 1] ?? 0) * 7 + (data[i + 2] ?? 0) * 13 + (data[i + 3] ?? 0) * 17;
        hash = (Math.imul(hash, 31) + v) >>> 0;
        if (first === -1) first = v;
        else if (v !== first) distinct++;
    }
    return distinct > 0 ? hash : null;
}

// Waits until the canvas has painted AND stopped changing between polls —
// i.e. any entry animation (ECharts sunburst/map, Chart.js) has finished.
async function waitForPaint(page: Page, sel: string, { timeout = 20000, quietMs = 500 }: { timeout?: number; quietMs?: number } = {}): Promise<void> {
    const start = Date.now();
    let prev: number | null = null;
    let stableSince = 0;
    for (;;) {
        const fp = await page.evaluate(canvasFingerprint, sel);
        const now = Date.now();
        if (fp !== null && fp === prev) {
            if (!stableSince) stableSince = now;
            if (now - stableSince >= quietMs) return;
        } else {
            stableSince = 0;
        }
        prev = fp;
        if (now - start > timeout) {
            // Best-effort tool: a sparse chart the prime-stride sampler never
            // lands on reads as fp===null forever. Warn and move on rather
            // than aborting the whole regeneration over one uncertain view.
            if (fp === null) console.warn(`waitForPaint: ${sel} not confirmed painted within ${timeout}ms — capturing anyway`);
            return;
        }
        await page.waitForTimeout(120);
    }
}

// Waits until every image matching `sel` has decoded. A thumb with no src yet
// is not treated as ready: a blob fetch that 404'd never assigns a src, and an
// image mid-load reports complete===true with naturalWidth===0 — both used to
// count as ready and screenshot blank (#1184).
async function waitForImages(page: Page, sel: string, { timeout = 10000 }: { timeout?: number } = {}): Promise<void> {
    await page.waitForFunction((selector) => {
        const imgs = [...document.querySelectorAll<HTMLImageElement>(selector)];
        return imgs.every(i => i.hasAttribute('src') && i.complete && i.naturalWidth > 0);
    }, sel, { timeout }).catch(() => {
        console.warn(`waitForImages: ${sel} not decoded within ${timeout}ms — capturing anyway`);
    });
}

// #1185: after the library wait, name every thumbnail that is still blank — an
// <img> whose blob fetch never resolved has no src (or resolved to
// naturalWidth 0), which screenshots as an empty dark square with no warning.
// Reports each entity id so a backed-up-but-unserved photo is visible in the
// run log instead of silently shipping a blank screenshot.
async function reportUnhydratedThumbs(page: Page): Promise<void> {
    const missing = await page.evaluate(() => {
        const sels = '.lib-bean-thumb, .lib-grinder-thumb, .lib-basket-thumb, .lib-puckscreen-thumb';
        return [...document.querySelectorAll<HTMLImageElement>(sels)]
            .filter(img => !img.hasAttribute('src') || img.naturalWidth === 0)
            .map(img => ({
                kind: img.className,
                id: img.dataset.beanId || img.dataset.grinderId || img.dataset.basketId || img.dataset.puckscreenId || '?',
            }));
    });
    if (missing.length) {
        console.warn(`library: ${missing.length} thumbnail(s) not hydrated (photo missing/unserved) — capturing anyway: ${JSON.stringify(missing)}`);
    }
}

// Scrolls `viewSel`'s own overflow:auto box so that `targetSel` (or the
// .analytics-sec section wrapping it) sits flush at the top of the frame — exact,
// unlike Element.scrollIntoView() which stops a scroll-padding short.
async function alignToTop(page: Page, viewSel: string, targetSel: string): Promise<void> {
    await page.evaluate(({ viewSel, targetSel }) => {
        const view = document.querySelector(viewSel);
        const el = document.querySelector(targetSel);
        if (!view || !el) return;
        const target = el.closest('.analytics-sec') || el;
        view.scrollTop += target.getBoundingClientRect().top - view.getBoundingClientRect().top;
    }, { viewSel, targetSel });
}

// Shoots the whole window (#1809) after resetting `viewSel`'s own
// overflow:auto box to its top, so a view left mid-scroll by an earlier step
// is captured from its start. Every PNG uses this same 1400x900 frame, which
// keeps the top nav (and its active tab) in shot and the set consistent.
async function shootWindow(page: Page, viewSel: string, filePath: string): Promise<void> {
    await page.locator(viewSel).evaluate(el => el.scrollTo(0, 0));
    await page.waitForTimeout(120);
    await page.screenshot({ path: filePath });
}

// Places three demo orders in the throwaway instance so the Orders view has
// a queue to show (#1809): the instance's own queue is empty, and a restored
// backup usually holds only completed orders. The API calls use the same
// `x-glp-token` auth as restoreBackup()/seed() in e2e-harness.mts. Orders are
// only accepted while the shop is open, so enable it first (the restored
// backup may carry it off). Returns how many orders were placed.
async function seedDemoOrders(baseUrl: string): Promise<number> {
    const { apiToken } = (await fetch(`${baseUrl}/api/token`).then(r => r.json())) as { apiToken: string };
    const headers = { 'Content-Type': 'application/json', 'x-glp-token': apiToken };
    const call = async (p: string, body?: unknown): Promise<unknown> => {
        const r = await fetch(`${baseUrl}${p}`, {
            method: 'POST',
            headers,
            body: body === undefined ? null : JSON.stringify(body),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`POST ${p} -> ${r.status}: ${text}`);
        return text ? (JSON.parse(text) as unknown) : {};
    };

    await call('/api/orders/settings', { enabled: true });

    // POST /api/orders rejects an item that is not on the menu.
    const menu = (await fetch(`${baseUrl}/api/orders/menu`, { headers }).then(r => r.json())) as Array<{ name?: string }>;
    const items = menu.map(m => m.name).filter((n): n is string => !!n).slice(0, 3);
    if (items.length < 3) {
        // Best-effort like every other capture: an empty menu still gives a
        // warnable Orders view rather than aborting the whole regeneration.
        console.warn(`orders: GET /api/orders/menu returned ${items.length} usable item(s), wanted 3`);
    }

    const customers = ['Anna', 'Ben', 'Chris'] as const;
    const placed: Array<{ id?: string }> = [];
    for (const [i, item] of items.entries()) {
        const customer = customers[i] ?? 'Guest';
        placed.push((await call('/api/orders', { item, customer })) as { id?: string });
    }
    // Accept the first one so both Queue and In Progress are populated.
    const firstId = placed[0]?.id;
    if (firstId) await call(`/api/orders/${encodeURIComponent(firstId)}/accept`, { eta: 5 });
    console.log(`orders: placed ${placed.length} demo order(s) (${items.join(', ')})`);
    return placed.length;
}

async function main(): Promise<void> {
    mkdirSync(outDir, { recursive: true });

    console.log(`Screenshots data source: ${backupPath ?? 'built-in demo seed'}`);
    const baseUrl = await bootServer();
    if (fromBackup) {
        const result = await restoreBackup(baseUrl, path.resolve(backupPath));
        console.log(`Restored backup ${backupPath ?? ''} (${result.shots ?? 0} shots)`);
    } else {
        await seed(baseUrl);
    }

    const browser = await chromium.launch();
    // #1184: browser.newPage() inherits the host OS locale, so every PNG came
    // out in the desktop's language on a non-English machine. Pin an English
    // locale for browser-level strings (Intl dates/numbers, navigator.language)
    // and seed glp_lang before any page script runs, since the SPA reads
    // navigator.language and a restored backup can carry its own preference. A
    // fixed timezone keeps relative dates stable across machines.
    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        locale: 'en-US',
        timezoneId: 'Europe/Berlin',
    });
    await context.addInitScript(() => {
        try { localStorage.setItem('glp_lang', 'en'); } catch { /* ignore */ }
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    // Prove the SPA rendered English, not the German default the static HTML
    // ships with: nav_analytics is 'Analytics' in English and 'Statistiken' in
    // German (public-src/i18n/en.ts / de.ts).
    await page.waitForFunction(() => {
        const el = document.querySelector('[data-i18n="nav_analytics"]');
        return localStorage.getItem('glp_lang') === 'en' && !!el && el.textContent === 'Analytics';
    });
    // The update-check banner does a real GitHub API call and renders whenever
    // the checked-out version is ahead of the latest published release (the
    // normal case mid-release, before this version's own tag exists yet) —
    // it overlays the top of the page and intercepts clicks on the nav bar.
    await page.addStyleTag({ content: '#glpUpdateBanner{display:none!important}' });
    // #btnLive is only shown once a switch_entity is configured for machine
    // power control (components/status.ts's updatePowerButton()) — this
    // throwaway instance has no HA connection to report one, so force it
    // visible for the screenshot rather than leaving the Live tab undocumented.
    await page.addStyleTag({ content: '#btnLive{display:flex!important}' });

    // ── Shots ──────────────────────────────────────────────────────────
    // Full-viewport capture (not scoped to #shots-view like the rest): the
    // shot list in #sidebar is half of what this view is, and a scoped
    // #shots-view shot is #957-lazy so it also needs the curve to land.
    // Wait for the shot-detail line chart to actually paint before shooting.
    await page.click('#btnShots');
    await page.waitForSelector('#chart-area', { state: 'visible' });
    await waitForPaint(page, '#espressoShotChart');
    await page.waitForTimeout(150); // let the phase-band overlay settle on top of the lines
    // #1184: the shot photo's blob URL is assigned after an async fetch, and a
    // 404'd image stays complete with naturalWidth 0, so wait for it to decode
    // when the selected shot has one. Seed shots carry no photo, so only wait
    // when the view indicates one — never hang on its absence.
    await page.waitForFunction(() => {
        const hero = document.getElementById('shotHeroPhoto') as HTMLImageElement | null;
        const thumb = document.getElementById('shotHeaderThumb') as HTMLImageElement | null;
        const indicated = !!(hero && hero.classList.contains('has-photo')) || !!(thumb && thumb.style.display !== 'none');
        if (!indicated) return true;
        const decoded = (el: HTMLImageElement | null): boolean => !!el && el.hasAttribute('src') && el.complete && el.naturalWidth > 0;
        return decoded(hero) || decoded(thumb);
    }, undefined, { timeout: 10000 }).catch(() => console.warn('shots: shot photo not decoded within 10000ms — capturing anyway'));
    await page.screenshot({ path: path.join(outDir, 'shots.png') });

    // Every remaining capture is the same full 1400x900 window (#1809), after
    // clicking the view's nav tab so the top nav shows the active tab.

    // ── Library ────────────────────────────────────────────────────────
    await page.click('#btnLibrary');
    // The seeded library always contains the 'Yirgacheffe' demo bean; a real
    // backup has arbitrary beans, so wait for the rendered shelf instead.
    // #1330: the shelf renders .lib-shelf-tile (grid) / .lib-shelf-row (list);
    // it no longer emits .lib-item (that class survives only in the sheet).
    await page.waitForFunction(
        fromBackup
            ? () => document.querySelectorAll('#beanListUI .lib-shelf-tile, #beanListUI .lib-shelf-row').length > 0
            : () => (document.getElementById('beanListUI')?.textContent || '').includes('Yirgacheffe'),
        undefined, { timeout: 15000 },
    );
    // Any bean/roaster/product thumbnails must be decoded, or they screenshot
    // blank. Only the thumbnails are waited on (the view also holds the hidden
    // flavor-wheel image, whose src stays unset until that modal opens).
    await waitForImages(page, '#library-view .lib-bean-thumb, #library-view .lib-grinder-thumb, #library-view .lib-basket-thumb, #library-view .lib-puckscreen-thumb');
    // A restored backup's photos must all be served; name any that are not.
    if (fromBackup) await reportUnhydratedThumbs(page);
    await shootWindow(page, '#library-view', path.join(outDir, 'library.png'));

    // ── Flavor wheel ───────────────────────────────────────────────────
    // #1330 moved the wheel button off the shelf into the bean's detail
    // sheet, and it only renders for a bean that has flavors. Open the first
    // such bean's sheet, then shoot the wheel inside it. Best-effort: a
    // backup whose beans carry no flavors simply has no wheel to capture.
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
        // The open bean sheet itself (stock, bags, small wheel) over the
        // shelf, full viewport like shots.png. Wait for the slide-in to finish
        // and the sheet's photos to decode before shooting.
        await page.waitForSelector('#beanSheet .lib-sheet', { state: 'visible' });
        await page.waitForTimeout(400);
        await waitForImages(page, '#beanSheet img[src]');
        await page.screenshot({ path: path.join(outDir, 'bean-sheet.png') });

        const wheelBtn = page.locator('#beanSheet [data-action="open-flavor-wheel"]').first();
        await wheelBtn.click();
        await page.waitForSelector('#flavorWheelModal', { state: 'visible' });
        await waitForPaint(page, '#flavorWheelCanvas'); // ECharts sunburst (incl. its entry animation)
        // Full window with the modal open (#1809), not the modal box alone.
        await page.screenshot({ path: path.join(outDir, 'flavor-wheel.png') });
        const closeBtn = page.locator('#flavorWheelModal .fw-close, #flavorWheelModal [data-action="close-flavor-wheel"]').first();
        if (await closeBtn.count()) await closeBtn.click();
        // Close the sheet too, or its backdrop covers the nav bar and the
        // Analytics click below never lands. Target the close button: the
        // backdrop shares data-action="close-bean-sheet" but the sheet sits
        // over its centre, so a first-match click never receives the event.
        await page.locator('#beanSheet .lib-sheet-close').click();
        // The close slides the sheet out (~220ms) before removing it; wait for
        // it to go so the backdrop cannot swallow the next nav click.
        // Best-effort like the rest of this step.
        await page.waitForSelector('#beanSheet .lib-sheet', { state: 'hidden', timeout: 2000 }).catch(() => {});
    } else {
        console.warn('flavor-wheel: no bean with flavors found — skipping');
    }

    // ── Analytics ──────────────────────────────────────────────────────
    // #analytics-view is its own overflow:auto scroll container. Two
    // captures: the summary top, and the machine-comparison band lower
    // down. #797 made ECharts a dynamic import(), so the world map / trend
    // chart land seconds after the nav click — wait for each to paint.
    await page.click('#btnAnalytics');
    await page.waitForSelector('#analytics-view', { state: 'visible' });
    await waitForPaint(page, '#trendChart');        // Chart.js score-trend
    await page.locator('#worldMapWrap').scrollIntoViewIfNeeded();
    await waitForPaint(page, '#worldMapWrap');      // ECharts origin map (force the dynamic import to resolve)
    // Capture 1: summary KPIs + score trend + calendar.
    await shootWindow(page, '#analytics-view', path.join(outDir, 'analytics.png'));

    // Capture 2: the "More insights" fold with its lazily-built charts
    // (#1467). It starts closed, and the fold only builds its charts once
    // opened, so open it first — a closed capture would show the summary plus
    // empty canvases. seed() registers >=2 machines, so the machine-comparison
    // section is present; a real backup may restore only one machine and leave
    // it hidden, in which case fall back to aligning the fold itself rather
    // than scrolling to a zero-height box.
    await page.locator('#analyticsMore').evaluate(el => el.setAttribute('open', ''));
    await page.waitForSelector('#analyticsMore[open]');
    // Opening runs the builders on the toggle event; wait for the charts that
    // exist (a sparse backup can replace a canvas with an empty-state note).
    for (const sel of ['#profileChart', '#dialinProgressionChart']) {
        if (await page.locator(sel).count()) await waitForPaint(page, sel);
    }
    const moreTarget = (await page.locator('#machineComparisonCard').isVisible())
        ? '#machineComparisonCard'
        : '#analyticsMore';
    await alignToTop(page, '#analytics-view', moreTarget);
    await page.waitForTimeout(200);
    // Keep the mid-view scroll alignToTop() just set: no scrollTo(0, 0) here.
    await page.screenshot({ path: path.join(outDir, 'analytics-machines.png') });

    // ── Maintenance ────────────────────────────────────────────────────
    await page.click('#btnMaintenance');
    await page.waitForFunction(
        () => document.querySelectorAll('#maintSummary .maint-tile').length > 0,
        undefined, { timeout: 15000 },
    );
    await shootWindow(page, '#maintenance-view', path.join(outDir, 'maintenance.png'));

    // ── Dial-in ────────────────────────────────────────────────────────
    await page.click('#btnDialin');
    // The dial-in grid is populated from shot/dial-in history; a real backup
    // without dial-in data leaves it empty, so don't abort the whole run there
    // — capture what's rendered and warn.
    await page.waitForFunction(() => {
        const grid = document.getElementById('dialinGrid');
        return !!grid && grid.children.length > 0 && !grid.querySelector('.dialin-empty');
    }, undefined, { timeout: 15000 }).catch((err: unknown) => {
        if (fromBackup) {
            console.warn('dialin: no dial-in data in backup — capturing anyway');
            return;
        }
        throw err instanceof Error ? err : new Error(String(err));
    });
    await shootWindow(page, '#dialin-view', path.join(outDir, 'dialin.png'));

    // ── Live / Orders / Settings (previously undocumented tabs) ─────────
    // Both are captured in every mode (#1809). Live shows the connecting /
    // offline state: the throwaway instance has no machine to reach, so the
    // badge wait is best-effort like dial-in's rather than aborting the run.
    await page.click('#btnLive');
    await page.waitForFunction(() => {
        const badge = document.getElementById('live-status-badge');
        return !!badge && !badge.classList.contains('connecting');
    }, undefined, { timeout: 15000 }).catch(() => {
        console.warn('live: machine never left the connecting state — capturing anyway');
    });
    await shootWindow(page, '#live-view', path.join(outDir, 'live.png'));

    // The throwaway instance's queue is empty and a restored backup holds only
    // completed orders, so the script places demo orders of its own first.
    const placedOrders = await seedDemoOrders(baseUrl);
    await page.click('#btnOrders');
    await page.waitForFunction(
        () => !!document.getElementById('ordersEnabledLabel')?.textContent,
        undefined, { timeout: 15000 },
    );
    await page.waitForFunction(
        (min) => document.querySelectorAll('#orders-pending-list .order-card, #orders-accepted-list .order-card').length >= min,
        placedOrders, { timeout: 15000 },
    ).catch(() => console.warn('orders: queue did not show all demo orders in 15000ms — capturing anyway'));
    await shootWindow(page, '#orders-view', path.join(outDir, 'orders.png'));

    // #1514: Settings left .topbar-nav-scroll for a fixed slot, but the
    // click target is still its unchanged id.
    await page.click('#btnSettings');
    // seed() adds a second machine; a real backup may hold just one.
    await page.waitForFunction(
        (min) => document.querySelectorAll('#machinesList .machine-row').length >= min,
        fromBackup ? 1 : 2, { timeout: 15000 },
    );
    await shootWindow(page, '#settings-view', path.join(outDir, 'settings.png'));

    await context.close();
    await browser.close();
    console.log(`Screenshots written to ${outDir}`);

    const wikiDir = process.argv[2];
    if (wikiDir && existsSync(wikiDir)) {
        const wikiImages = path.join(wikiDir, 'images');
        mkdirSync(wikiImages, { recursive: true });
        cpSync(outDir, wikiImages, { recursive: true });
        console.log(`Copied screenshots into wiki repo at ${wikiImages}`);
    }

}

main()
    .then(() => { stopServer(); process.exit(0); })
    .catch(err => { console.error(err); stopServer(); process.exit(1); });

/* eslint-enable no-undef */
