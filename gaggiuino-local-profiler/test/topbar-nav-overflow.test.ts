// #2079: the desktop top bar no longer scrolls sideways. planTopbarOverflow is
// the pure decision behind which tabs move into the "More" menu;
// layoutTopbarNav measures the row and applies it. Node environment, no DOM
// library: the row is a hand-built fake with a Set-backed classList, like the
// deleted topbar-nav-fade test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    planTopbarOverflow,
    layoutTopbarNav,
    topbarMenuEntries,
    type TopbarNavEls,
} from '../public-src/components/topbar-nav-overflow.js';

const here = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(here, '../public-src/index.html'), 'utf8');
const CSS = readFileSync(join(here, '../public-src/style.css'), 'utf8');

const g = globalThis as unknown as Record<string, unknown>;
g.document ??= { getElementById: () => null, createElement: () => null };

// Realistic tab widths for the dev build's German labels, Live and Orders
// included: Shots, Live, Library, Analytics, Dial-In, Maintenance,
// Achievements, Orders.
const WIDTHS = [88, 80, 102, 118, 102, 133, 140, 95];
const GAP = 2;
const MORE = 80;

describe('planTopbarOverflow() (#2079)', () => {
    it('moves nothing when every tab fits', () => {
        expect(planTopbarOverflow(WIDTHS, 0, 900, MORE, GAP)).toEqual([]);
        // A row within the one-pixel tolerance still counts as fitting.
        expect(planTopbarOverflow([100, 100], -1, 202, MORE, 0)).toEqual([]);
    });

    it('moves a contiguous tail and reserves the menu width', () => {
        const room = 700;
        expect(planTopbarOverflow(WIDTHS, 0, room, 0, GAP)).toEqual([6, 7]);
        expect(planTopbarOverflow(WIDTHS, 0, room, MORE, GAP)).toEqual([5, 6, 7]);
    });

    it('keeps an active last tab and moves the ones before it instead', () => {
        expect(planTopbarOverflow(WIDTHS, 7, 700, MORE, GAP)).toEqual([5, 6]);
    });

    it('works with no active tab (the Settings page)', () => {
        expect(planTopbarOverflow(WIDTHS, -1, 700, MORE, GAP)).toEqual([5, 6, 7]);
    });

    it('keeps only the active tab when it and the menu alone exceed the room', () => {
        expect(planTopbarOverflow(WIDTHS, 3, 150, MORE, GAP)).toEqual([0, 1, 2, 4, 5, 6, 7]);
    });
});

describe('planTopbarOverflow() property sweep (#2079)', () => {
    it('never clips a kept tab, never hides the active one, and covers every tab', () => {
        for (let available = 200; available <= 1300; available += 7) {
            for (let active = -1; active < WIDTHS.length; active++) {
                const hidden = planTopbarOverflow(WIDTHS, active, available, MORE, GAP);
                const hiddenSet = new Set(hidden);
                const kept = WIDTHS.map((_, i) => i).filter(i => !hiddenSet.has(i));

                // Disjoint and covering: every tab is either kept or hidden.
                expect(kept.filter(i => hiddenSet.has(i))).toEqual([]);
                expect([...kept, ...hidden].sort((a, b) => a - b)).toEqual(WIDTHS.map((_, i) => i));
                // The active tab is always in the row.
                if (active >= 0) expect(hiddenSet.has(active)).toBe(false);

                // The kept tabs plus the menu still fit, so no tab is clipped.
                // The one exception the plan allows is the active tab alone,
                // when even it does not fit next to the menu.
                if (hidden.length > 0 && kept.length > 1) {
                    const keptWidth = kept.reduce((sum, i) => sum + (WIDTHS[i] ?? 0), 0) + GAP * (kept.length - 1);
                    expect(keptWidth + MORE).toBeLessThanOrEqual(available);
                }
            }
        }
    });
});

interface FakeBadge {
    textContent: string;
    style: Record<string, string>;
}

interface FakeClassList {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
}

function fakeClassList(classes: Set<string>): FakeClassList {
    return {
        add: (name: string) => { classes.add(name); },
        remove: (name: string) => { classes.delete(name); },
        contains: (name: string) => classes.has(name),
    };
}

interface FakeTab {
    id: string;
    width: number;
    badge: FakeBadge | null;
    disabled: boolean;
    classes: Set<string>;
    classList: FakeClassList;
    getBoundingClientRect(): { width: number };
    querySelector(selector: string): FakeBadge | { textContent: string } | null;
}

function fakeTab(id: string, width: number, opts: { active?: boolean; badge?: string } = {}): FakeTab {
    const classes = new Set<string>();
    if (opts.active) classes.add('active');
    const label = `label-${id}`;
    const badge = opts.badge === undefined ? null : { textContent: opts.badge, style: {} as Record<string, string> };
    const tab: FakeTab = {
        id,
        width,
        badge,
        disabled: false,
        classes,
        classList: fakeClassList(classes),
        getBoundingClientRect: () => ({ width: tab.width }),
        querySelector: (selector: string) => {
            if (selector === '.rail-label') return { textContent: label };
            if (selector === '.maint-badge') return tab.badge;
            return null;
        },
    };
    return tab;
}

interface FakeRow {
    els: TopbarNavEls;
    barClasses: Set<string>;
    moreClasses: Set<string>;
    more: { hidden: boolean; open: boolean; classList: FakeClassList; getBoundingClientRect(): { width: number } };
    nav: { clientWidth: number; getClientRects(): unknown[] };
    tabs: FakeTab[];
    /** Change the room the row is measured against, like a window resize. */
    setRoom(room: number): void;
}

interface RowOptions {
    widths?: number[];
    room: number;
    /** Width the status group gives back while `topbar-compact` is on. */
    compactSaving?: number;
    rendered?: boolean;
    activeId?: string;
    badgeOn?: { id: string; text: string };
}

function makeRow(opts: RowOptions): FakeRow {
    const widths = opts.widths ?? WIDTHS;
    const saving = opts.compactSaving ?? 60;
    const barClasses = new Set<string>();
    const moreClasses = new Set<string>();
    const tabs = widths.map((width, i) => {
        const id = `btn${i}`;
        const tabOpts: { active?: boolean; badge?: string } = { active: opts.activeId === id };
        if (opts.badgeOn?.id === id) tabOpts.badge = opts.badgeOn.text;
        return fakeTab(id, width, tabOpts);
    });
    let room = opts.room;
    const nav = {
        get clientWidth(): number {
            return barClasses.has('topbar-compact') ? room + saving : room;
        },
        getClientRects: () => (opts.rendered === false ? [] : [{}]),
    };
    const more = {
        hidden: false,
        open: false,
        classList: fakeClassList(moreClasses),
        getBoundingClientRect: () => ({ width: MORE }),
    };
    const els: TopbarNavEls = {
        bar: { classList: fakeClassList(barClasses) } as unknown as HTMLElement,
        nav: nav as unknown as HTMLElement,
        tabs: tabs as unknown as HTMLElement[],
        more: more as unknown as HTMLDetailsElement,
        gap: GAP,
    };
    return { els, barClasses, moreClasses, more, nav, tabs, setRoom: (value: number) => { room = value; } };
}

function hiddenIds(row: FakeRow): string[] {
    return row.tabs.filter(tab => tab.classes.has('topbar-nav-overflow')).map(tab => tab.id);
}

describe('layoutTopbarNav() (#2079)', () => {
    it('leaves a wide row alone and marks it ready', () => {
        const row = makeRow({ room: 900 });
        layoutTopbarNav(row.els);
        expect(row.barClasses.has('topbar-compact')).toBe(false);
        expect(hiddenIds(row)).toEqual([]);
        expect(row.more.hidden).toBe(true);
        expect(row.barClasses.has('topbar-nav-ready')).toBe(true);
    });

    it('compacts the status group first and moves nothing when that is enough', () => {
        // Overflowing as measured, but the 60 px the compact status group gives
        // back is enough.
        const row = makeRow({ room: 820, compactSaving: 60 });
        layoutTopbarNav(row.els);
        expect(row.barClasses.has('topbar-compact')).toBe(true);
        expect(hiddenIds(row)).toEqual([]);
        expect(row.more.hidden).toBe(true);
        expect(row.barClasses.has('topbar-nav-ready')).toBe(true);
    });

    it('moves the tail into the menu once the compact row still overflows', () => {
        // The 1280 px dev build with two machines: even the compact row cannot
        // hold every tab.
        const row = makeRow({ room: 640, compactSaving: 60, activeId: 'btn0' });
        layoutTopbarNav(row.els);
        expect(row.barClasses.has('topbar-compact')).toBe(true);
        expect(hiddenIds(row)).toEqual(['btn5', 'btn6', 'btn7']);
        expect(row.more.hidden).toBe(false);

        const visible = row.tabs.filter(tab => !tab.classes.has('topbar-nav-overflow'));
        const visibleWidth = visible.reduce((sum, tab) => sum + tab.width, 0) + GAP * (visible.length - 1);
        expect(visibleWidth + MORE).toBeLessThanOrEqual(row.nav.clientWidth);

        const entries = topbarMenuEntries(row.tabs as unknown as HTMLElement[]);
        expect(entries.map(entry => entry.target)).toEqual(['btn5', 'btn6', 'btn7']);
        expect(entries.map(entry => entry.label)).toEqual(['label-btn5', 'label-btn6', 'label-btn7']);
    });

    it('keeps an active Orders tab in the row and out of the menu', () => {
        const row = makeRow({ room: 640, compactSaving: 60, activeId: 'btn7' });
        layoutTopbarNav(row.els);
        expect(row.tabs[7]?.classes.has('topbar-nav-overflow')).toBe(false);
        expect(hiddenIds(row)).toEqual(['btn5', 'btn6']);
        expect(topbarMenuEntries(row.tabs as unknown as HTMLElement[]).map(e => e.target)).toEqual(['btn5', 'btn6']);
    });

    it('ignores an inline-hidden tab (Live) entirely', () => {
        const widths = [...WIDTHS];
        widths[1] = 0;
        const row = makeRow({ widths, room: 640, compactSaving: 60, activeId: 'btn0' });
        layoutTopbarNav(row.els);
        expect(hiddenIds(row)).not.toContain('btn1');
        expect(topbarMenuEntries(row.tabs as unknown as HTMLElement[]).map(e => e.target)).not.toContain('btn1');
    });

    it('does nothing on a phone, where the row is not rendered', () => {
        const row = makeRow({ room: 300, rendered: false });
        layoutTopbarNav(row.els);
        expect(row.barClasses.has('topbar-compact')).toBe(false);
        expect(hiddenIds(row)).toEqual([]);
        expect(row.more.hidden).toBe(true);
        expect(row.barClasses.has('topbar-nav-ready')).toBe(true);
    });

    it('clears every stale class when the row is widened again', () => {
        const row = makeRow({ room: 640, compactSaving: 60, activeId: 'btn0' });
        layoutTopbarNav(row.els);
        expect(hiddenIds(row).length).toBeGreaterThan(0);
        expect(row.more.hidden).toBe(false);

        row.setRoom(1200);
        layoutTopbarNav(row.els);
        expect(row.barClasses.has('topbar-compact')).toBe(false);
        expect(hiddenIds(row)).toEqual([]);
        expect(row.more.hidden).toBe(true);
        expect(row.moreClasses.has('has-badge')).toBe(false);
    });

    it('flags the menu when a hidden tab carries a badge', () => {
        const row = makeRow({ room: 640, compactSaving: 60, activeId: 'btn0', badgeOn: { id: 'btn5', text: '2' } });
        layoutTopbarNav(row.els);
        expect(row.moreClasses.has('has-badge')).toBe(true);
        const entry = topbarMenuEntries(row.tabs as unknown as HTMLElement[]).find(e => e.target === 'btn5');
        expect(entry?.badge).toBe('2');
    });

    it('leaves an inline-hidden badge out of the entries', () => {
        const row = makeRow({ room: 640, compactSaving: 60, activeId: 'btn0', badgeOn: { id: 'btn5', text: '2' } });
        const badge = row.tabs[5]?.badge;
        if (badge) badge.style.display = 'none';
        layoutTopbarNav(row.els);
        expect(row.moreClasses.has('has-badge')).toBe(false);
        const entry = topbarMenuEntries(row.tabs as unknown as HTMLElement[]).find(e => e.target === 'btn5');
        expect(entry?.badge).toBe('');
    });
});

describe('top bar markup and stylesheet (#2079)', () => {
    it('puts the More menu after the tab list inside the nav scroll row', () => {
        const start = HTML.indexOf('<nav class="topbar-nav-scroll">');
        const row = HTML.slice(start, HTML.indexOf('</nav>', start));
        expect(row.indexOf('</div>')).toBeLessThan(row.indexOf('<details id="topbarNavMore"'));
        expect(row).toContain('id="topbarNavMore" class="topbar-nav-more" hidden');
        expect(row).toMatch(/<summary[^>]*data-i18n-title="nav_more"/);
        expect(row).toContain('id="topbarNavMenu"');
    });

    it('no longer scrolls the row and has no edge fade', () => {
        const start = CSS.indexOf('.topbar-nav-scroll {');
        const rule = CSS.slice(start, CSS.indexOf('}', start));
        expect(rule).not.toContain('overflow-x: auto');
        expect(rule).not.toContain('scrollbar-width');
        expect(CSS).not.toContain('fade-right');
        expect(CSS).not.toContain('fade-left');
    });

    it('hides an overflowed tab even when a test script forces it visible', () => {
        expect(CSS).toMatch(/#content-topbar \.topbar-nav\.topbar-nav-overflow \{\s*display: none !important;/);
    });

    it('compacts the status group through the bar class', () => {
        expect(CSS).toContain('#content-topbar.topbar-compact #syncTime');
        expect(CSS).toContain('#content-topbar.topbar-compact #syncBtn');
        expect(CSS).toContain('.topbar-nav-more.has-badge .rail-icon-slot::after');
    });
});
