#!/usr/bin/env node
// Regenerates docs/screenshots/*.png for the README/wiki. Drives a headless
// Chromium (Playwright) through each view of the throwaway, seeded instance
// booted by scripts/e2e-harness.mjs (shared with test/e2e/smoke.test.mjs —
// see that module for what "throwaway" means: its own tmp DATA_DIR and port,
// never touches /data or 8099). Run on demand: `node scripts/screenshots.mjs`.
// Requires `npx playwright install chromium` once beforehand.
//
// #1032: every capture waits for a real readiness signal (a chart canvas
// with non-blank pixels, an ECharts instance that has painted, images
// decoded) instead of a fixed setTimeout — the lazy per-shot curve fetch
// (#957) and the dynamic-import ECharts bundle (#797) both resolve well
// after the old fixed 400ms, so the pre-#1032 images caught half-rendered
// views (empty shot chart, mid-render sunburst).

import { mkdirSync, cpSync, existsSync } from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { appRoot, bootServer, seed, stopServer } from './e2e-harness.mjs';

const outDir = path.join(appRoot, 'docs', 'screenshots');

/* eslint-disable no-undef -- the callbacks below are serialised and run
   inside the Chromium tab via Playwright's page.waitForFunction/evaluate,
   where `document` is a real global; ESLint lints this file with Node
   globals only. Same pattern as test/e2e/smoke.test.mjs. */

// Runs inside the page: a coarse fingerprint of whatever `sel` resolves to
// as a <canvas> (or an element containing one — ECharts mounts its canvas
// as a child). `null` until the canvas exists and has painted more than one
// flat colour; otherwise a hash of a sparse pixel sample. Covers both
// Chart.js (the canvas is the element) and ECharts (world map, flavor
// wheel) without needing either library's globals.
function canvasFingerprint(sel) {
    const host = document.querySelector(sel);
    const canvas = host && (host.tagName === 'CANVAS' ? host : host.querySelector('canvas'));
    if (!canvas || !canvas.width || !canvas.height) return null;
    let ctx;
    try { ctx = canvas.getContext('2d'); } catch { return null; }
    if (!ctx) return null;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let hash = 0;
    let distinct = 0;
    let first = -1;
    // Prime stride: hits an aperiodic scatter of pixels across the buffer.
    for (let i = 0; i < data.length; i += 1021 * 4) {
        const v = data[i] + data[i + 1] * 7 + data[i + 2] * 13 + data[i + 3] * 17;
        hash = (Math.imul(hash, 31) + v) >>> 0;
        if (first === -1) first = v;
        else if (v !== first) distinct++;
    }
    return distinct > 0 ? hash : null;
}

// Waits until the canvas has painted AND stopped changing between polls —
// i.e. any entry animation (ECharts sunburst/map, Chart.js) has finished.
async function waitForPaint(page, sel, { timeout = 20000, quietMs = 500 } = {}) {
    const start = Date.now();
    let prev = null;
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

// Scrolls `viewSel`'s own overflow:auto box so that `targetSel` (or the
// .analytics-card wrapping it) sits flush at the top of the frame — exact,
// unlike Element.scrollIntoView() which stops a scroll-padding short.
async function alignToTop(page, viewSel, targetSel) {
    await page.evaluate(({ viewSel, targetSel }) => {
        const view = document.querySelector(viewSel);
        const el = document.querySelector(targetSel);
        if (!view || !el) return;
        const target = el.closest('.analytics-card') || el;
        view.scrollTop += target.getBoundingClientRect().top - view.getBoundingClientRect().top;
    }, { viewSel, targetSel });
}

// Clip-shoots `sel`'s on-screen rectangle at the current scroll position —
// unlike Locator.screenshot(), which re-scrolls the element into view first
// (discarding a mid-view scroll set beforehand) and always captures the
// element's full box, leaving a dead band below short content in a tall
// flex:1/overflow:auto view (its scrollHeight never drops below its
// clientHeight, so that can't be measured — walk the leaf descendants for
// the real content extent instead). Height is trimmed to whichever is
// shorter: the visible frame, or the content that's actually there.
async function shootView(page, sel, filePath, { fromTop = true, pad = 24 } = {}) {
    if (fromTop) {
        await page.locator(sel).evaluate(el => el.scrollTo(0, 0));
        await page.waitForTimeout(120);
    }
    const box = await page.locator(sel).evaluate((el, pad) => {
        const vr = el.getBoundingClientRect();
        let bottom = vr.top;
        const paint = /^(CANVAS|IMG|SVG|VIDEO)$/;
        (function walk(node) {
            for (const c of node.children) {
                const r = c.getBoundingClientRect();
                // inline <svg> reports tagName 'svg' (lowercase, SVG namespace)
                const painty = paint.test((c.tagName || '').toUpperCase());
                const leaf = c.children.length === 0;
                if (r.height > 0 && (painty || (leaf && c.textContent.trim()))) {
                    bottom = Math.max(bottom, r.bottom);
                }
                walk(c);
            }
        })(el);
        const contentH = Math.min(vr.height, Math.ceil(bottom - vr.top) + pad);
        return { x: vr.x, y: vr.y, width: vr.width, height: Math.max(1, contentH) };
    }, pad);
    await page.screenshot({ path: filePath, clip: box });
}

async function main() {
    mkdirSync(outDir, { recursive: true });

    const baseUrl = await bootServer();
    await seed(baseUrl);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    // The update-check banner does a real GitHub API call and renders whenever
    // the checked-out version is ahead of the latest published release (the
    // normal case mid-release, before this version's own tag exists yet) —
    // it overlays the top of the page and intercepts clicks on the nav bar.
    await page.addStyleTag({ content: '#glpUpdateBanner{display:none!important}' });
    // #btnLive is only shown once a switch_entity is configured for machine
    // power control (components/status.js's updatePowerButton()) — this
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
    await page.screenshot({ path: path.join(outDir, 'shots.png') });

    // Each remaining capture is scoped to its view container (#<tab>-view)
    // via shootView() — cuts the repeated top nav bar out and trims the dead
    // band a short view leaves below its content in a tall overflow:auto box.

    // ── Library ────────────────────────────────────────────────────────
    await page.click('#btnLibrary');
    await page.waitForFunction(
        () => (document.getElementById('beanListUI')?.textContent || '').includes('Yirgacheffe'),
        undefined, { timeout: 15000 },
    );
    // Any bean/roaster thumbnails must be decoded, or they screenshot blank.
    await page.waitForFunction(() => {
        const imgs = [...document.querySelectorAll('#library-view img')];
        return imgs.every(i => i.complete && (i.naturalWidth > 0 || i.getAttribute('src') === null));
    }, undefined, { timeout: 10000 }).catch(() => {});
    await shootView(page, '#library-view', path.join(outDir, 'library.png'));

    // ── Flavor wheel ───────────────────────────────────────────────────
    const wheelBtn = page.locator('[data-action="open-flavor-wheel"]').first();
    if (await wheelBtn.count()) {
        await wheelBtn.click();
        await page.waitForSelector('#flavorWheelModal', { state: 'visible' });
        await waitForPaint(page, '#flavorWheelCanvas'); // ECharts sunburst (incl. its entry animation)
        await page.locator('#flavorWheelModal').screenshot({ path: path.join(outDir, 'flavor-wheel.png') });
        const closeBtn = page.locator('#flavorWheelModal .fw-close, #flavorWheelModal [data-action="close-flavor-wheel"]').first();
        if (await closeBtn.count()) await closeBtn.click();
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
    await shootView(page, '#analytics-view', path.join(outDir, 'analytics.png'));

    // Capture 2: bean ranking + machine comparison + dial-in progression
    // (#394) — the machine-comparison card only renders once >=2 machines
    // exist, which seed() sets up. Scroll toward the bean-ranking card (it
    // ends up near the top, clamped by the view's own scroll extent) and
    // clip-shoot the frame at that position.
    await alignToTop(page, '#analytics-view', '#beanRanking');
    await page.waitForTimeout(200);
    await shootView(page, '#analytics-view', path.join(outDir, 'analytics-machines.png'), { fromTop: false });

    // ── Maintenance ────────────────────────────────────────────────────
    await page.click('#btnMaintenance');
    await page.waitForFunction(
        () => document.querySelectorAll('#maintSummary .maint-tile').length > 0,
        undefined, { timeout: 15000 },
    );
    await shootView(page, '#maintenance-view', path.join(outDir, 'maintenance.png'));

    // ── Dial-in ────────────────────────────────────────────────────────
    await page.click('#btnDialin');
    await page.waitForFunction(() => {
        const grid = document.getElementById('dialinGrid');
        return !!grid && grid.children.length > 0 && !grid.querySelector('.dialin-empty');
    }, undefined, { timeout: 15000 });
    await shootView(page, '#dialin-view', path.join(outDir, 'dialin.png'));

    // ── Live / Orders / Settings (previously undocumented tabs) ─────────
    await page.click('#btnLive');
    await page.waitForFunction(() => {
        const badge = document.getElementById('live-status-badge');
        return !!badge && !badge.classList.contains('connecting');
    }, undefined, { timeout: 15000 });
    await shootView(page, '#live-view', path.join(outDir, 'live.png'));

    await page.click('#btnOrders');
    await page.waitForFunction(
        () => !!document.getElementById('ordersEnabledLabel')?.textContent,
        undefined, { timeout: 15000 },
    );
    await shootView(page, '#orders-view', path.join(outDir, 'orders.png'));

    await page.click('#btnSettings');
    await page.waitForFunction(
        () => document.querySelectorAll('#machinesList .machine-row').length >= 2,
        undefined, { timeout: 15000 },
    );
    await shootView(page, '#settings-view', path.join(outDir, 'settings.png'));

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

/* eslint-enable no-undef */

main()
    .then(() => { stopServer(); process.exit(0); })
    .catch(err => { console.error(err); stopServer(); process.exit(1); });
