#!/usr/bin/env node
// Regenerates docs/screenshots/*.png for the README/wiki. Drives a headless
// Chromium (Playwright) through each view of the throwaway, seeded instance
// booted by scripts/e2e-harness.mjs (shared with test/e2e/smoke.test.mjs —
// see that module for what "throwaway" means: its own tmp DATA_DIR and port,
// never touches /data or 8099). Run on demand: `node scripts/screenshots.mjs`.
// Requires `npx playwright install chromium` once beforehand.

import { mkdirSync, cpSync, existsSync } from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { appRoot, bootServer, seed } from './e2e-harness.mjs';

const outDir = path.join(appRoot, 'docs', 'screenshots');

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
    await page.waitForTimeout(500); // let async post-load renders (thumbnails, charts) settle

    await page.click('#btnShots');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'shots.png') });

    await page.click('#btnLibrary');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'library.png') });

    const wheelBtn = page.locator('[data-action="open-flavor-wheel"]').first();
    if (await wheelBtn.count()) {
        await wheelBtn.click();
        await page.waitForTimeout(600); // sunburst render
        await page.screenshot({ path: path.join(outDir, 'flavor-wheel.png') });
        const closeBtn = page.locator('#flavorWheelModal .fw-close, #flavorWheelModal [data-action="close-flavor-wheel"]').first();
        if (await closeBtn.count()) await closeBtn.click();
    }

    await page.click('#btnAnalytics');
    await page.waitForTimeout(400);
    await page.locator('#worldMapWrap').scrollIntoViewIfNeeded();
    await page.waitForTimeout(800); // ECharts map render
    await page.screenshot({ path: path.join(outDir, 'analytics.png') });

    // Machine comparison + weekday/hour heatmap + bean ranking (#394) — only
    // rendered/visible once >=2 machines exist, which seed() now sets up.
    await page.locator('#machineComparisonCard').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'analytics-machines.png') });

    await page.click('#btnMaintenance');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'maintenance.png') });

    await page.click('#btnDialin');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'dialin.png') });

    // Live/Orders/Settings (previously undocumented — every top-level tab
    // now gets a screenshot).
    await page.click('#btnLive');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'live.png') });

    await page.click('#btnOrders');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'orders.png') });

    await page.click('#btnSettings');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'settings.png') });

    await browser.close();
    console.log(`Screenshots written to ${outDir}`);

    const wikiDir = process.argv[2];
    if (wikiDir && existsSync(wikiDir)) {
        const wikiImages = path.join(wikiDir, 'images');
        mkdirSync(wikiImages, { recursive: true });
        cpSync(outDir, wikiImages, { recursive: true });
        console.log(`Copied screenshots into wiki repo at ${wikiImages}`);
    }

    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
