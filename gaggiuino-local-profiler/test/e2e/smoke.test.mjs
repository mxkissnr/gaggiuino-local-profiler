// Playwright E2E smoke test (#798). Boots the throwaway, seeded instance
// from scripts/e2e-harness.mjs (shared with scripts/screenshots.mjs) once,
// then drives a single real headless Chromium tab through every top-level
// nav view. This is deliberately a smoke test, not a UI regression suite:
// each view only needs to (a) reach an interactive state and (b) log no
// browser console errors while doing so. (b) is the actual point — it is
// the one thing pure unit/integration tests structurally cannot see, e.g.
// a chunk 404ing under a path prefix (see #797, which moves echarts behind
// a dynamic import()) or a view throwing on mount, both of which would
// otherwise leave a view silently blank with every other test still green.
//
// One shared page/session (not a fresh page per view) mirrors how the app
// is actually used — a single load, then tab-switching — and keeps this
// fast; console errors are attributed to a view by diffing the accumulated
// error list around that view's own nav click, not by resetting per test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { bootServer, seed } from '../../scripts/e2e-harness.mjs';

let browser, page;
const consoleErrors = [];

before(async () => {
    const baseUrl = await bootServer();
    await seed(baseUrl);

    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push(String(err)));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    // Same two overrides scripts/screenshots.mjs applies, for the same
    // reasons: the update-check banner does a real GitHub API call and
    // overlays/intercepts clicks on the nav bar whenever the checked-out
    // version is ahead of the latest published release; #btnLive stays
    // display:none until a switch_entity is configured, which this
    // throwaway instance never has.
    await page.addStyleTag({ content: '#glpUpdateBanner{display:none!important}' });
    await page.addStyleTag({ content: '#btnLive{display:flex!important}' });
    await page.waitForTimeout(500); // let async post-load renders settle, same as screenshots.mjs
});

after(async () => {
    await browser?.close();
    // No process.exit() here on purpose — see scripts/e2e-harness.mjs's
    // bootServer() comment: node:test needs to finish computing its exit
    // code first, so termination is left to the test:e2e script's
    // --test-force-exit flag instead.
});

// Snapshots consoleErrors, runs the view transition, waits for its
// interactive-state marker, then returns only the errors that appeared
// during that transition.
async function gotoView({ nav, post, ready }) {
    const before = consoleErrors.length;
    await page.click(nav);
    // Analytics' #worldMapWrap only exists inside the now-visible view — it
    // must be scrolled into view AFTER the click, not before (it's not
    // "visible" per Playwright's actionability check while its view
    // container is still display:none from the previous mode).
    if (post) await post(page);
    await page.waitForFunction(ready, undefined, { timeout: 10000 });
    await page.waitForTimeout(300); // let the view's own async render finish, same margin screenshots.mjs uses
    return consoleErrors.slice(before);
}

// The `ready` callbacks below run inside the browser tab via Playwright's
// page.waitForFunction(), not in this Node process -- `document` is a real
// global there, even though ESLint's static analysis (correctly, for a
// .mjs file with node globals) doesn't know that.
/* eslint-disable no-undef */
const VIEWS = [
    {
        name: 'Shots',
        nav: '#btnShots',
        // sidebar.js renders one `wrapper-<id>` element per shot (see
        // components/mode.js's goToShot()) — seed() creates 7.
        ready: () => !!document.querySelector('[id^="wrapper-"]'),
    },
    {
        name: 'Library',
        nav: '#btnLibrary',
        // renderBeanList() (views/library.js) replaces #beanListUI's
        // content with real bean cards once S.coffeeLibrary loads —
        // checking for one of the seeded bean names proves it rendered the
        // real data, not just an empty-state placeholder.
        ready: () => (document.getElementById('beanListUI')?.textContent || '').includes('Yirgacheffe'),
    },
    {
        name: 'Analytics',
        nav: '#btnAnalytics',
        post: async p => { await p.locator('#worldMapWrap').scrollIntoViewIfNeeded(); },
        // The ECharts world map (views/analytics.js) mounts a <canvas> into
        // #worldMapWrap once echarts.init() renders — same element
        // scripts/screenshots.mjs scrolls to before its own screenshot.
        ready: () => !!document.querySelector('#worldMapWrap canvas'),
    },
    {
        name: 'Maintenance',
        nav: '#btnMaintenance',
        // renderMaintenanceDashboard() (views/maintenance.js) fills
        // #maintSummary with .maint-tile counters once the async
        // maintenance data loads.
        ready: () => document.querySelectorAll('#maintSummary .maint-tile').length > 0,
    },
    {
        name: 'Dialin',
        nav: '#btnDialin',
        // views/dialin.js fills #dialinGrid with real shot cards once
        // recent shots load; an empty grid would still contain a single
        // ".dialin-empty" placeholder node, so this must specifically wait
        // for that not to be the only child.
        ready: () => {
            const grid = document.getElementById('dialinGrid');
            return !!grid && grid.children.length > 0 && !grid.querySelector('.dialin-empty');
        },
    },
    {
        name: 'Live',
        nav: '#btnLive',
        // connectLiveStream() (views/live.js) sets the badge to 'connecting'
        // synchronously, then the first api/live/data response resolves it
        // to ready/unreachable/idle/brewing/error via setLiveBadge() — this
        // seeded instance's default machine has no host configured, so it
        // resolves to 'unreachable', but any resolved state proves the view
        // reached an interactive state, not just its initial connecting one.
        ready: () => {
            const badge = document.getElementById('live-status-badge');
            return !!badge && !badge.classList.contains('connecting');
        },
    },
    {
        name: 'Orders',
        nav: '#btnOrders',
        // loadOrdersView() (views/orders.js) awaits api/orders/settings
        // before setting #ordersEnabledLabel's text.
        ready: () => !!document.getElementById('ordersEnabledLabel')?.textContent,
    },
    {
        name: 'Settings',
        nav: '#btnSettings',
        // renderMachinesList() (components/machines-settings.js) renders
        // one .machine-row per machine — seed() creates 2.
        ready: () => document.querySelectorAll('#machinesList .machine-row').length >= 2,
    },
];
/* eslint-enable no-undef */

for (const view of VIEWS) {
    test(`${view.name} view reaches an interactive state with no console errors`, async () => {
        const errors = await gotoView(view);
        assert.deepEqual(errors, [], `${view.name} view logged console errors: ${JSON.stringify(errors)}`);
    });
}
