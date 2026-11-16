// Playwright E2E smoke test (#798). Boots the throwaway, seeded instance
// from scripts/e2e-harness.mts (shared with scripts/screenshots.mts) once,
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
import type { Browser, Page } from 'playwright';
import { bootServer, seed, stopServer } from '../../scripts/e2e-harness.mts';
import { openTopbarTab } from '../../scripts/topbar-nav.mts';

let browser: Browser;
let page: Page;
const consoleErrors: string[] = [];

before(async () => {
    const baseUrl = await bootServer();
    await seed(baseUrl);

    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push(String(err)));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await applyOverrides();
    await page.waitForTimeout(500); // let async post-load renders settle, same as screenshots.mts
});

// Same two overrides scripts/screenshots.mts applies, for the same reasons:
// the update-check banner does a real GitHub API call and
// overlays/intercepts clicks on the nav bar whenever the checked-out
// version is ahead of the latest published release; #btnLive stays
// display:none until a switch_entity is configured, which this throwaway
// instance never has. Re-applied after every reload in the top bar test.
async function applyOverrides(): Promise<void> {
    await page.addStyleTag({ content: '#glpUpdateBanner{display:none!important}' });
    await page.addStyleTag({ content: '#btnLive{display:flex!important}' });
}

after(async () => {
    await browser?.close();
    // Stop the spawned glp-server child so it doesn't linger after the run.
    // No process.exit() here on purpose — node:test needs to finish
    // computing its exit code first, so final termination is left to the
    // test:e2e script's --test-force-exit flag.
    stopServer();
});

interface View {
    name: string;
    nav: string;
    post?: (page: Page) => Promise<void>;
    ready: () => boolean;
}

// Snapshots consoleErrors, runs the view transition, waits for its
// interactive-state marker, then returns only the errors that appeared
// during that transition.
async function gotoView({ nav, post, ready }: View): Promise<string[]> {
    const before = consoleErrors.length;
    await openTopbarTab(page, nav);
    // Analytics' #worldMapWrap only exists inside the now-visible view — it
    // must be scrolled into view AFTER the click, not before (it's not
    // "visible" per Playwright's actionability check while its view
    // container is still display:none from the previous mode).
    if (post) await post(page);
    await page.waitForFunction(ready, undefined, { timeout: 10000 });
    await page.waitForTimeout(300); // let the view's own async render finish, same margin screenshots.mts uses
    return consoleErrors.slice(before);
}

// The `ready` callbacks below run inside the browser tab via Playwright's
// page.waitForFunction(), not in this Node process -- `document` is a real
// global there, even though ESLint's static analysis (correctly, for a
// .mts file with node globals) doesn't know that.
/* eslint-disable no-undef */
const VIEWS: View[] = [
    {
        name: 'Shots',
        nav: '#btnShots',
        // sidebar.ts renders one `wrapper-<id>` element per shot (see
        // components/mode.ts's goToShot()) — the demo dataset seeds 12.
        ready: () => !!document.querySelector('[id^="wrapper-"]'),
    },
    {
        name: 'Library',
        nav: '#btnLibrary',
        // renderBeanList() (views/library.ts) replaces #beanListUI's
        // content with real bean cards once S.coffeeLibrary loads —
        // checking for one of the seeded bean names proves it rendered the
        // real data, not just an empty-state placeholder. The demo dataset's
        // first bean is "GLP Demo — Ethiopia Yirgacheffe".
        ready: () => (document.getElementById('beanListUI')?.textContent || '').includes('Yirgacheffe'),
    },
    {
        name: 'Analytics',
        nav: '#btnAnalytics',
        post: async p => { await p.locator('#worldMapWrap').scrollIntoViewIfNeeded(); },
        // The ECharts world map (views/analytics.ts) mounts a <canvas> into
        // #worldMapWrap once echarts.init() renders — same element
        // scripts/screenshots.mts scrolls to before its own screenshot.
        ready: () => !!document.querySelector('#worldMapWrap canvas'),
    },
    {
        name: 'Maintenance',
        nav: '#btnMaintenance',
        // renderMaintenanceDashboard() (views/maintenance.ts) fills
        // #maintVerdict once the async maintenance data loads.
        ready: () => !!document.querySelector('#maintVerdict .analytics-verdict-title'),
    },
    {
        name: 'Dialin',
        nav: '#btnDialin',
        // views/dialin.ts fills #dialinGrid with real shot cards once
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
        // connectLiveStream() (views/live.ts) sets the badge to 'connecting'
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
        // loadOrdersView() (views/orders.ts) awaits api/orders/settings
        // before setting #ordersEnabledLabel's text.
        ready: () => !!document.getElementById('ordersEnabledLabel')?.textContent,
    },
    {
        name: 'Settings',
        // #1514: still #btnSettings — the button left the scrolling nav row,
        // but the id (and page.click()'s visibility check at 1400 px) is intact.
        nav: '#btnSettings',
        // renderMachinesList() (components/machines-settings.ts) renders one
        // .machine-row per machine — the default row plus the second
        // machine seed() adds.
        ready: () => document.querySelectorAll('#machinesList .machine-row').length >= 2,
    },
];
/* eslint-enable no-undef */

for (const view of VIEWS) {
    void test(`${view.name} view reaches an interactive state with no console errors`, async () => {
        const errors = await gotoView(view);
        assert.deepEqual(errors, [], `${view.name} view logged console errors: ${JSON.stringify(errors)}`);
    });
}

// ── Top bar fit at laptop widths (#2079) ─────────────────────────────────
// The smoke run above only ever looks at 1400 px in English, which is why
// tabs being cut off at 1280 px (and at 1144 px inside Home Assistant with
// its sidebar open) went unnoticed. Dutch has the longest tab labels, then
// French and Spanish; German is longer than English.

interface TopbarTabReport {
    id: string;
    visible: boolean;
    inside: boolean;
    insideList: boolean;
    leftOfSettings: boolean;
    truncated: boolean;
    overflow: boolean;
}

interface TopbarReport {
    tabs: TopbarTabReport[];
    moreShown: boolean;
    moreLeftOfSettings: boolean;
    compact: boolean;
    scrollShown: boolean;
    bottomNavShown: boolean;
    syncTimeShown: boolean;
}

interface TopbarMenuEntryReport {
    target: string;
    disabled: boolean;
}

/* eslint-disable no-undef */
// Runs in the page: one plain report of what the row currently looks like.
const readTopbar = (): TopbarReport => {
    const bar = document.getElementById('content-topbar')!;
    const scroll = document.querySelector<HTMLElement>('.topbar-nav-scroll')!;
    const scrollBox = scroll.getBoundingClientRect();
    // The list clips whatever does not fit it, so it is the tighter bound on a
    // tab that is still drawn but cut.
    const listBox = document.querySelector<HTMLElement>('.topbar-nav-list')!.getBoundingClientRect();
    const settingsBox = document.getElementById('btnSettings')!.getBoundingClientRect();
    const moreBox = document.getElementById('topbarNavMore')!.getBoundingClientRect();
    const tabs = [...document.querySelectorAll<HTMLElement>('.topbar-nav-list > .topbar-nav')];
    return {
        tabs: tabs.map(tab => {
            const box = tab.getBoundingClientRect();
            const label = tab.querySelector<HTMLElement>('.rail-label');
            return {
                id: tab.id,
                visible: box.width > 0 && box.height > 0,
                inside: box.left >= scrollBox.left - 1 && box.right <= scrollBox.right + 1,
                insideList: box.left >= listBox.left - 1 && box.right <= listBox.right + 1,
                leftOfSettings: box.right <= settingsBox.left + 1,
                truncated: !!label && label.scrollWidth > label.clientWidth + 1,
                overflow: tab.classList.contains('topbar-nav-overflow'),
            };
        }),
        moreShown: moreBox.width > 0 && moreBox.height > 0,
        moreLeftOfSettings: moreBox.right <= settingsBox.left + 1,
        compact: bar.classList.contains('topbar-compact'),
        scrollShown: scrollBox.width > 0,
        bottomNavShown: (document.getElementById('bottom-nav')?.getBoundingClientRect().width ?? 0) > 0,
        syncTimeShown: (document.getElementById('syncTime')?.getBoundingClientRect().width ?? 0) > 0,
    };
};

// The tabs marked hidden and the entries the open "More" menu offers, read in
// one go: topbar-nav-overflow.ts rebuilds the menu from those very classes
// whenever it lays the row out, so a single snapshot is the only way to
// compare them.
const readMenuAndOverflow = (): { overflow: string[]; entries: TopbarMenuEntryReport[] } => ({
    overflow: [...document.querySelectorAll<HTMLElement>('.topbar-nav-list > .topbar-nav.topbar-nav-overflow')]
        .map(tab => tab.id),
    entries: [...document.querySelectorAll<HTMLButtonElement>('#topbarNavMenu [data-nav-target]')]
        .map(el => ({ target: el.dataset['navTarget'] ?? '', disabled: el.disabled })),
});

// What the last layout decided plus the two texts it shares the bar with, as a
// short string -- see waitForStableRow(). The texts are part of it because a
// late status poll rewrites the sync time (or the machine name), and the row
// re-measures when that happens.
const readLayoutSignature = (): string => {
    const bar = document.getElementById('content-topbar');
    const moreBox = document.getElementById('topbarNavMore')!.getBoundingClientRect();
    const overflow = [...document.querySelectorAll<HTMLElement>('.topbar-nav-list > .topbar-nav.topbar-nav-overflow')]
        .map(tab => tab.id);
    return [
        bar?.classList.contains('topbar-compact') ? 'compact' : '-',
        moreBox.width > 0 ? 'more' : '-',
        overflow.join(','),
        document.getElementById('syncTime')?.textContent ?? '',
        document.getElementById('railMachineName')?.textContent ?? '',
    ].join('|');
};

// The same for the open menu: what it offers plus what the row hides, so the
// two can be compared at one moment -- see waitForStable().
const readMenuSignature = (): string => {
    const bar = document.getElementById('content-topbar');
    const overflow = [...document.querySelectorAll<HTMLElement>('.topbar-nav-list > .topbar-nav.topbar-nav-overflow')]
        .map(tab => tab.id);
    const entries = [...document.querySelectorAll<HTMLElement>('#topbarNavMenu [data-nav-target]')]
        .map(el => el.dataset['navTarget'] ?? '');
    return [overflow.join(','), entries.join(','), bar?.classList.contains('topbar-compact') ? 'compact' : '-'].join('|');
};

const readMenuState = (): { open: boolean; summaryFocused: boolean } => {
    const more = document.getElementById('topbarNavMore') as HTMLDetailsElement;
    return { open: more.open, summaryFocused: document.activeElement === more.querySelector('summary') };
};

// Waits for the <details> to be open with a rendered entry.
const readMenuOpen = (): boolean => {
    const more = document.getElementById('topbarNavMore') as HTMLDetailsElement | null;
    return more?.open === true && document.querySelectorAll('#topbarNavMenu [data-nav-target]').length > 0;
};
/* eslint-enable no-undef */

// The layout re-runs from a ResizeObserver callback, so wait two frames for
// it to land before reading the row.
/* eslint-disable no-undef */
async function settleFrame(): Promise<void> {
    await page.evaluate(() => new Promise<void>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => { resolve(); }));
    }));
}
/* eslint-enable no-undef */

// Reloads in `lang`, re-applying the overrides the before() hook installs
// (a reload drops them, they are per-document style tags).
/* eslint-disable no-undef */
async function useLang(lang: string): Promise<void> {
    await page.evaluate(value => { localStorage.setItem('glp_lang', value); }, lang);
    await page.reload({ waitUntil: 'networkidle' });
    await applyOverrides();
    // The row stays hidden until the first layout has run.
    await page.waitForFunction(
        () => document.getElementById('content-topbar')?.classList.contains('topbar-nav-ready') === true,
        undefined,
        { timeout: 10000 },
    );
    await page.waitForTimeout(300);
}
/* eslint-enable no-undef */

// A width change is also what makes the row lay itself out again after the
// reload re-added the forced-visible Live tab, which no inline-style mutation
// announces.
async function resizeTo(width: number, height = 900): Promise<void> {
    await page.setViewportSize({ width, height });
    await settleFrame();
    await waitForStableRow();
}

// The row shares its bar with the sync time and the machine name and re-measures
// whenever either text changes -- which a status poll landing right after the
// reload does ("kein Sync" becomes "13:16", a shorter text, so a tab can move
// back out of the menu). Reading the row and the menu at different moments then
// compares two different layouts. Poll until three reads at least a frame apart
// agree, and only then measure.
const STABLE_READS = 3;

async function waitForStable(read: () => string, what: string): Promise<void> {
    let previous: string | null = null;
    let same = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
        await page.waitForTimeout(60);
        const current = await page.evaluate(read);
        same = current === previous ? same + 1 : 1;
        previous = current;
        if (same >= STABLE_READS) return;
    }
    assert.fail(`the top bar ${what} never settled (last read: ${previous})`);
}

async function waitForStableRow(): Promise<void> {
    await waitForStable(readLayoutSignature, 'layout');
}

// The <details>/<summary> toggle event is what rebuilds the menu, and the
// browser dispatches it after the click; a closed menu keeps its previous
// entries in the DOM, so wait for the open state and then for the content to
// stop changing rather than trust whatever is there. Resolves false when the
// row no longer needs the button, so the caller can skip instead of clicking a
// hidden element.
async function openMoreMenu(): Promise<boolean> {
    const toggle = page.locator('#topbarNavMore > summary');
    if (!(await toggle.isVisible())) return false;
    // Clicking the summary toggles, so only click a closed menu.
    const alreadyOpen = await page.evaluate(readMenuOpen);
    if (!alreadyOpen) await toggle.click();
    await page.waitForFunction(readMenuOpen, undefined, { timeout: 5000 });
    await waitForStable(readMenuSignature, 'menu');
    return true;
}

// Every tab that is in the row is fully inside it, left of the settings gear
// and not truncated; when tabs did move into "More", the status group
// compacted first.
async function assertTopbarFits(lang: string, width: number): Promise<TopbarReport> {
    await resizeTo(width);
    const report = await page.evaluate(readTopbar);
    const where = `${lang} at ${width} px`;

    const shown = report.tabs.filter(tab => tab.visible);
    assert.ok(shown.length > 0, `${where}: no tab is visible`);
    for (const tab of shown) {
        assert.ok(tab.inside, `${where}: tab ${tab.id} sticks out of the row`);
        assert.ok(tab.insideList, `${where}: tab ${tab.id} is cut off by its own row`);
        assert.ok(tab.leftOfSettings, `${where}: tab ${tab.id} overlaps the settings gear`);
        assert.ok(!tab.truncated, `${where}: tab ${tab.id} has a truncated label`);
    }
    if (report.moreShown) {
        assert.ok(report.moreLeftOfSettings, `${where}: the More button overlaps the settings gear`);
        assert.ok(report.compact, `${where}: tabs moved into More before the bar compacted`);
    }
    return report;
}

/* eslint-disable no-undef */
const isFocusedAndActive = (id: string): { active: boolean; focused: boolean } => {
    const el = document.getElementById(id);
    return { active: el?.classList.contains('active') === true, focused: document.activeElement === el };
};
/* eslint-enable no-undef */

void test('top bar fits at laptop widths in every language (#2079)', async () => {
    for (const lang of ['de', 'en', 'it', 'fr', 'es', 'nl']) {
        await useLang(lang);

        for (const width of [1280, 1144, 1024]) {
            await assertTopbarFits(lang, width);

            // The menu lists exactly the hidden tabs, in row order, and Escape
            // closes it leaving focus on the toggle.
            if (!(await openMoreMenu())) continue;
            const shownMenu = await page.evaluate(readMenuAndOverflow);
            assert.deepEqual(shownMenu.entries.map(entry => entry.target), shownMenu.overflow,
                `${lang} at ${width} px: the More menu does not list the hidden tabs`);

            await page.keyboard.press('Escape');
            const state = await page.evaluate(readMenuState);
            assert.equal(state.open, false, `${lang} at ${width} px: Escape did not close the More menu`);
            assert.equal(state.summaryFocused, true, `${lang} at ${width} px: Escape left focus off the More toggle`);
        }

        // A tab picked from the menu comes into the row as the active one, so
        // the page the user just opened is never hidden.
        await assertTopbarFits(lang, 1024);
        if (await openMoreMenu()) {
            const { entries } = await page.evaluate(readMenuAndOverflow);
            const pickable = entries.filter(entry => !entry.disabled).map(entry => entry.target);
            const picked = pickable[pickable.length - 1];
            assert.ok(picked, `${lang}: the More menu has no enabled entry to pick`);

            await page.locator(`#topbarNavMenu [data-nav-target="${picked}"]`).click();
            await settleFrame();
            await waitForStableRow();

            const afterPick = await page.evaluate(readTopbar);
            assert.ok(afterPick.tabs.find(tab => tab.id === picked)?.visible,
                `${lang}: the tab opened from the menu is not visible`);
            const pickedState = await page.evaluate(isFocusedAndActive, picked);
            assert.equal(pickedState.active, true, `${lang}: the tab opened from the menu is not active`);
            assert.equal(pickedState.focused, true, `${lang}: the tab opened from the menu did not take focus`);

            // The tab now sits in the row, so the menu no longer offers it. A
            // row that fits again has no menu left to open.
            if (afterPick.moreShown) {
                if (await openMoreMenu()) {
                    const relisted = (await page.evaluate(readMenuAndOverflow)).entries.map(entry => entry.target);
                    assert.ok(!relisted.includes(picked), `${lang}: the tab opened from the menu is still listed`);
                    await page.keyboard.press('Escape');
                }
            }
        }
        await openTopbarTab(page, '#btnShots');
        await waitForStableRow();

        // Nothing is hidden on a wide screen in the reference language.
        if (lang === 'en') {
            await resizeTo(1920);
            const wide = await page.evaluate(readTopbar);
            assert.deepEqual(wide.tabs.filter(tab => tab.overflow), [], 'en at 1920 px: a tab moved into More');
            assert.equal(wide.moreShown, false, 'en at 1920 px: the More button is shown');
            assert.equal(wide.syncTimeShown, true, 'en at 1920 px: the sync time is hidden');
        }

        // The phone layout keeps its bottom navigation and never renders the
        // measured row, in every language.
        await resizeTo(390, 844);
        const phone = await page.evaluate(readTopbar);
        assert.equal(phone.scrollShown, false, 'phone: the desktop tab row is shown');
        assert.equal(phone.moreShown, false, 'phone: the More button is shown');
        assert.equal(phone.bottomNavShown, true, 'phone: the bottom navigation is hidden');
    }

    await resizeTo(1400);
    await useLang('en');
});
