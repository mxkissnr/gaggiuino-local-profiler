#!/usr/bin/env node
// Smoke test for the static demo build (#1193).
//
// The deploy workflow (`.github/workflows/demo-pages.yml`) runs this after
// `npm run build:demo` and before uploading demo-dist/ to GitHub Pages. It
// serves the build under /gaggiuino-local-profiler/ — the project sub-path
// Pages publishes it to — with a tiny node:http static server, then drives
// Chromium through the demo in two viewports (desktop and phone): every main
// view, one shot detail, and a shot simulated from the demo banner. Any page
// error, console error, API request the fixtures do not cover, or HTTP >= 400
// fails the run, so a broken build never reaches the site.
//
// Run on demand with `npm run demo:smoke`. Requires `npm run build:demo`
// first and `npx playwright install chromium` once beforehand.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/* eslint-disable no-undef -- the callbacks passed to Playwright's
   page.evaluate / page.waitForFunction / context.addInitScript are serialised
   and run inside the Chromium tab, where `document`, `navigator`,
   `localStorage` and `getComputedStyle` are real globals; ESLint lints this
   file with Node globals only. Same pattern as scripts/screenshots.mjs. */

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(appRoot, '..', 'demo-dist');
// The URL prefix GitHub Pages serves a project site under. The demo's own
// build base is './', so every asset resolves beneath this path.
const BASE_PATH = '/gaggiuino-local-profiler';

const CONTENT_TYPES = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
    ['.woff2', 'font/woff2'],
    ['.woff', 'font/woff'],
    ['.ico', 'image/x-icon'],
    ['.map', 'application/json; charset=utf-8'],
    ['.txt', 'text/plain; charset=utf-8'],
    ['.zip', 'application/zip'],
]);

/**
 * Content type for a file path, chosen by extension; an unknown extension
 * falls back to the generic binary type rather than a wrong text type.
 */
export function contentTypeFor(filePath) {
    return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

/**
 * Resolves a URL pathname to an absolute path under `rootDir`, or null when it
 * escapes the root (a `..` traversal) or carries malformed percent-encoding.
 * The traversal guard is the point: the server only ever reads inside
 * demo-dist/, never a sibling file a crafted path points at.
 */
export function resolveRequestPath(rootDir, urlPath) {
    const raw = String(urlPath).split(/[?#]/)[0];
    let decoded;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return null;
    }
    if (decoded.includes('\0')) return null;
    const rel = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
    const root = path.resolve(rootDir);
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
}

/** Serves `rootDir` under BASE_PATH on a free port; resolves the server. */
function startServer(rootDir) {
    const server = createServer(async (req, res) => {
        try {
            const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
            if (pathname !== BASE_PATH && !pathname.startsWith(BASE_PATH + '/')) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('not found');
                return;
            }
            const file = resolveRequestPath(rootDir, pathname.slice(BASE_PATH.length));
            if (!file) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('forbidden');
                return;
            }
            const info = await stat(file);
            // A directory (the sub-path root) maps to its index.html.
            const target = info.isDirectory() ? path.join(file, 'index.html') : file;
            const body = await readFile(target);
            res.writeHead(200, { 'Content-Type': contentTypeFor(target) });
            res.end(body);
        } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('not found');
        }
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

// One entry per main view. `desktop`/`mobile` are the two nav surfaces the app
// exposes: the top bar (screenshots.mjs's #btn* selectors) and, below the 768px
// breakpoint, the configurable bottom nav / "Mehr" sheet (#443).
const VIEWS = [
    { desktop: '#btnShots', mobile: '#bnShots', container: '#shots-view' },
    { desktop: '#btnLibrary', mobile: '#bnLibrary', container: '#library-view' },
    { desktop: '#btnAnalytics', mobile: '#bnAnalytics', container: '#analytics-view' },
    { desktop: '#btnMaintenance', mobile: '#bnMaintenance', container: '#maintenance-view' },
    { desktop: '#btnDialin', mobile: '#bnDialin', container: '#dialin-view' },
    { desktop: '#btnLive', mobile: '#bnLive', container: '#live-view' },
    { desktop: '#btnOrders', mobile: '#bnOrders', container: '#orders-view' },
    { desktop: '#btnSettings', mobile: '#bnSettings', container: '#settings-view' },
];

// Live/Orders ship hidden unless the capability is configured (updatePowerButton
// in status.js); a static demo has no live machine to report one, so force both
// visible — same treatment screenshots.mjs gives #btnLive — on either nav.
const REVEAL_CSS = '#btnLive{display:flex!important}#btnOrders{display:flex!important}' +
    '#bnLive{display:flex!important}#bnOrders{display:flex!important}';

const PROFILES = [
    { name: 'desktop', viewport: { width: 1440, height: 900 } },
    { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

/** Switches to `view`, clicking whichever nav surface is actually shown. */
async function openView(page, view) {
    const desktop = page.locator(view.desktop);
    if (await desktop.isVisible()) {
        await desktop.click();
    } else {
        const mobile = page.locator(view.mobile);
        // The "Mehr" sheet holds every destination outside the mobile main bar.
        if (!(await mobile.isVisible())) await page.click('#bnMore');
        await mobile.click();
    }
    await page.waitForSelector(view.container, { state: 'visible', timeout: 20000 });
}

/** Opens a shot's detail: mobile reaches the list through the burger drawer. */
async function openShotDetail(page) {
    const drawer = page.locator('#mobileDrawerBtn');
    if (await drawer.isVisible()) await drawer.click();
    await page.waitForSelector('#sidebar .shot', { state: 'visible', timeout: 20000 });
    const shots = page.locator('#sidebar .shot');
    const count = await shots.count();
    await shots.nth(count > 1 ? 1 : 0).click();
    await page.waitForSelector('#chart-area', { state: 'visible', timeout: 20000 });
}

/** Reads the "MM:SS" elapsed label the Live view shows; 0 when it is blank. */
function elapsedSeconds(label) {
    const [minutes, seconds] = String(label).trim().split(':').map(Number);
    return Number.isFinite(minutes) && Number.isFinite(seconds) ? minutes * 60 + seconds : 0;
}

/** Records every way the Live view must show the replayed shot as running. */
async function assertLiveShot(page, problems, profileName) {
    const state = await page.evaluate(() => {
        const badge = document.getElementById('live-status-badge');
        const content = document.getElementById('live-content');
        const time = document.getElementById('liveTime');
        return {
            brewing: !!badge && badge.classList.contains('brewing'),
            contentVisible: !!content && getComputedStyle(content).display !== 'none',
            elapsed: time ? time.textContent : '',
        };
    });
    if (!state.brewing) problems.push(`[${profileName}] Live view is not brewing after the simulated shot`);
    if (!state.contentVisible) problems.push(`[${profileName}] Live content is hidden during the simulated shot`);
    if (elapsedSeconds(state.elapsed) <= 0) {
        problems.push(`[${profileName}] simulated shot elapsed time is not past zero (${state.elapsed || 'blank'})`);
    }
}

async function runProfile(browser, baseUrl, profile, problems) {
    const context = await browser.newContext({
        viewport: profile.viewport,
        isMobile: profile.isMobile,
        hasTouch: profile.hasTouch,
        locale: 'en-US',
    });
    await context.addInitScript(() => {
        try { localStorage.setItem('glp_lang', 'en'); } catch { /* ignore */ }
    });
    const page = await context.newPage();
    page.on('pageerror', error => problems.push(`[${profile.name}] page error: ${error.message}`));
    page.on('console', message => {
        const text = message.text();
        if (message.type() === 'error') problems.push(`[${profile.name}] console error: ${text}`);
        if (text.includes('[glp-demo] no fixture for')) problems.push(`[${profile.name}] missing fixture: ${text}`);
    });
    page.on('response', response => {
        if (response.status() >= 400) problems.push(`[${profile.name}] HTTP ${response.status()} ${response.url()}`);
    });

    try {
        await page.goto(baseUrl, { waitUntil: 'load' });
        // The demo boot registers its worker and reloads once unless it
        // already controls the page; nothing renders against the fixtures
        // until it does.
        await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 30000 });
        await page.waitForFunction(
            () => document.querySelector('[data-i18n="nav_analytics"]')?.textContent === 'Analytics',
            undefined, { timeout: 30000 },
        );
        await page.addStyleTag({ content: REVEAL_CSS });

        // Shots is the default view; open a shot detail from its list first.
        await openView(page, VIEWS[0]);
        await openShotDetail(page);
        for (const view of VIEWS.slice(1)) await openView(page, view);

        // The banner's "Simulate a shot" replays the newest recorded shot onto
        // the Live view; let it advance a few seconds so the elapsed readout
        // proves a real shot is running, not an idle machine.
        await page.click('#glpDemoBanner [data-i18n="demo.simulate"]');
        await page.waitForTimeout(5000);
        await assertLiveShot(page, problems, profile.name);
    } finally {
        await context.close();
    }
}

async function main() {
    if (!existsSync(distDir)) {
        console.error(`demo-smoke: ${path.relative(appRoot, distDir)}/ not found — run \`npm run build:demo\` first`);
        process.exit(1);
    }

    const server = await startServer(distDir);
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}${BASE_PATH}/`;
    const problems = [];
    let browser;
    try {
        browser = await chromium.launch();
        for (const profile of PROFILES) {
            try {
                await runProfile(browser, baseUrl, profile, problems);
            } catch (error) {
                problems.push(`[${profile.name}] ${error.message}`);
            }
        }
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }

    if (problems.length) {
        console.error(`demo-smoke: ${problems.length} problem(s):`);
        for (const problem of problems) console.error(`  - ${problem}`);
        process.exit(1);
    }
    console.log('demo-smoke: OK');
}

// Only serve and drive the browser when invoked as a script; importing the
// pure helpers in a unit test must not start a server (same guard as
// demo-fixtures.mjs / dev-stats.mjs, #527).
const invokedDirectly = process.argv[1] &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
    main().catch(error => {
        console.error(error);
        process.exit(1);
    });
}
