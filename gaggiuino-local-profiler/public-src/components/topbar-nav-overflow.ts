// #2079: the desktop top bar used to be a horizontal scroll strip with a
// hidden scrollbar and an edge fade (#424, #1516), so a tab that did not fit
// was only reachable by scrolling sideways. This module measures the row
// instead: when the tabs do not fit, the status group compacts first and only
// then do the tabs from the end of the row move into a "More" menu. A tab is
// either fully visible or in the menu, and the active tab always stays in the
// row.
//
// Order of steps in layoutTopbarNav():
//   1. reset every class and hide the menu,
//   2. measure the row (a phone does not render it, so stop there),
//   3. keep the row as measured, otherwise compact the status group and
//      re-measure,
//   4. otherwise reserve the menu button's width and move the tail that no
//      longer fits.

const OVERFLOW_CLASS = 'topbar-nav-overflow';
const READY_CLASS = 'topbar-nav-ready';
const COMPACT_CLASS = 'topbar-compact';
const BADGE_CLASS = 'has-badge';

// Sub-pixel widths are normal, so a row within a pixel of its room counts as
// fitting.
const FIT_TOLERANCE = 1;

/** Width of `widths` laid out in a row with `gap` between them. */
function rowWidth(widths: readonly number[], gap: number): number {
    if (widths.length === 0) return 0;
    return widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
}

/**
 * Pure: the indices of the tabs that move into the "More" menu, ascending.
 *
 * `[]` when everything fits. Otherwise `moreWidth` is reserved for the menu
 * button, the active tab is kept first, and the remaining tabs are kept in DOM
 * order until the first one that no longer fits, so the hidden tabs stay a
 * contiguous tail. The active index is never returned, even when it alone
 * exceeds the room.
 */
export function planTopbarOverflow(
    widths: readonly number[],
    activeIndex: number,
    available: number,
    moreWidth: number,
    gap: number,
): number[] {
    if (rowWidth(widths, gap) <= available + FIT_TOLERANCE) return [];

    const kept = new Set<number>();
    let budget = available - moreWidth;
    if (activeIndex >= 0 && activeIndex < widths.length) {
        kept.add(activeIndex);
        budget -= (widths[activeIndex] ?? 0) + gap;
    }
    for (let i = 0; i < widths.length; i++) {
        if (kept.has(i)) continue;
        const cost = (widths[i] ?? 0) + gap;
        if (cost > budget) break;
        kept.add(i);
        budget -= cost;
    }
    return widths.map((_, i) => i).filter(i => !kept.has(i));
}

export interface TopbarNavEls {
    bar: HTMLElement;
    nav: HTMLElement;
    tabs: HTMLElement[];
    more: HTMLDetailsElement;
    gap: number;
}

/** The top bar's tab row and its menu button, or null when the markup is not there. */
export function queryTopbarNav(): TopbarNavEls | null {
    const bar = document.getElementById('content-topbar');
    const nav = bar?.querySelector<HTMLElement>('.topbar-nav-scroll') ?? null;
    const list = nav?.querySelector<HTMLElement>('.topbar-nav-list') ?? null;
    const more = document.getElementById('topbarNavMore') as HTMLDetailsElement | null;
    if (!bar || !nav || !list || !more) return null;
    const tabs = [...list.querySelectorAll<HTMLElement>('.topbar-nav')];
    const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
    return { bar, nav, tabs, more, gap };
}

/** The badge text the user should see, or '' when there is none or it is inline-hidden. */
function visibleBadge(tab: HTMLElement): string {
    const badge = tab.querySelector<HTMLElement>('.maint-badge');
    if (!badge || badge.style.display === 'none') return '';
    return (badge.textContent ?? '').trim();
}

export interface TopbarMenuEntry {
    target: string;
    label: string;
    badge: string;
    disabled: boolean;
}

/** One entry per tab that is in the "More" menu, in DOM order. */
export function topbarMenuEntries(tabs: readonly HTMLElement[]): TopbarMenuEntry[] {
    return tabs
        .filter(tab => tab.classList.contains(OVERFLOW_CLASS))
        .map(tab => ({
            target: tab.id,
            label: (tab.querySelector<HTMLElement>('.rail-label')?.textContent ?? '').trim(),
            badge: visibleBadge(tab),
            disabled: (tab as HTMLButtonElement).disabled === true,
        }));
}

function closeMenu(more: HTMLDetailsElement): void {
    if (more.open) more.open = false;
}

function menuButton(tab: HTMLElement, entry: TopbarMenuEntry): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lib-sheet-menu-btn';
    button.setAttribute('data-nav-target', entry.target);
    const icon = tab.querySelector<HTMLElement>('.rail-icon-slot');
    if (icon) {
        const copy = icon.cloneNode(true) as HTMLElement;
        copy.setAttribute('aria-hidden', 'true');
        // The tab's own badge carries an id; the copy may not duplicate it.
        for (const el of copy.querySelectorAll('[id]')) el.removeAttribute('id');
        button.append(copy);
    }
    const label = document.createElement('span');
    label.textContent = entry.label;
    button.append(label);
    if (entry.badge) {
        const badge = document.createElement('span');
        badge.className = 'maint-badge';
        badge.textContent = entry.badge;
        button.append(badge);
    }
    button.disabled = entry.disabled;
    return button;
}

/** Rebuild the open menu from the tabs currently in it (DOM APIs only). */
function renderMenu(tabs: readonly HTMLElement[]): void {
    const menu = document.getElementById('topbarNavMenu');
    if (!menu) return;
    const inMenu = tabs.filter(tab => tab.classList.contains(OVERFLOW_CLASS));
    const byTarget = new Map<string, HTMLElement>(inMenu.map(tab => [tab.id, tab] as const));
    menu.replaceChildren(...topbarMenuEntries(inMenu).flatMap(entry => {
        const tab = byTarget.get(entry.target);
        return tab ? [menuButton(tab, entry)] : [];
    }));
}

/**
 * Measure and apply the row's layout. Every read and write happens in this
 * call, so the result is in place before the next paint (no rAF, no timers).
 */
export function layoutTopbarNav(els: TopbarNavEls | null = queryTopbarNav()): void {
    if (!els) return;
    const { bar, nav, tabs, more, gap } = els;

    bar.classList.remove(COMPACT_CLASS);
    for (const tab of tabs) tab.classList.remove(OVERFLOW_CLASS);
    more.hidden = true;
    more.classList.remove(BADGE_CLASS);

    const fits = (widths: readonly number[]): boolean => rowWidth(widths, gap) <= nav.clientWidth + FIT_TOLERANCE;
    // Leaving the menu hidden must also close it, or it would pop open the
    // next time the tabs need it. A menu that stays in use is left open and
    // rebuilt instead.
    const done = (): void => {
        if (more.hidden) closeMenu(more);
        bar.classList.add(READY_CLASS);
    };

    // Phone layout: the row is display:none, so there is nothing to lay out.
    if (nav.getClientRects().length === 0) {
        done();
        return;
    }

    // Inline-hidden tabs (Live, Orders) take no part in the row.
    const shown: { el: HTMLElement; width: number }[] = [];
    for (const tab of tabs) {
        const width = tab.getBoundingClientRect().width;
        if (width > 0) shown.push({ el: tab, width });
    }
    const widths = shown.map(item => item.width);

    if (fits(widths)) {
        done();
        return;
    }

    // The status group (sync time away, Sync as its icon) gives the room first.
    bar.classList.add(COMPACT_CLASS);
    if (fits(widths)) {
        done();
        return;
    }

    more.hidden = false;
    const activeIndex = shown.findIndex(item => item.el.classList.contains('active'));
    const hidden = planTopbarOverflow(widths, activeIndex, nav.clientWidth, more.getBoundingClientRect().width, gap);
    const hiddenSet = new Set(hidden);
    const inMenu = shown.filter((_, index) => hiddenSet.has(index)).map(item => item.el);
    for (const el of inMenu) el.classList.add(OVERFLOW_CLASS);
    if (inMenu.some(el => visibleBadge(el) !== '')) more.classList.add(BADGE_CLASS);
    if (more.open) renderMenu(inMenu);
    done();
}

function watch(target: Element | null, init: MutationObserverInit): void {
    if (!target || typeof MutationObserver === 'undefined') return;
    new MutationObserver(() => layoutTopbarNav()).observe(target, init);
}

/** Lay the row out now and again whenever its room or its content changes. */
export function initTopbarNav(): void {
    const els = queryTopbarNav();
    if (!els) {
        // The row stays hidden until the first layout has run; if the markup
        // is not the one this module expects, show it unlaid-out rather than
        // leave it invisible.
        document.getElementById('content-topbar')?.classList.add(READY_CLASS);
        return;
    }
    const { bar, nav, tabs, more } = els;

    layoutTopbarNav(els);

    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => layoutTopbarNav()).observe(bar);
    }

    // The tab list: label text (language change), Live/Orders visibility and
    // their badges. The class attribute is not observed, so the layout's own
    // class writes cannot feed back in.
    watch(nav.querySelector('.topbar-nav-list'), {
        subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'],
    });
    watch(more.querySelector('.rail-label'), { subtree: true, childList: true, characterData: true });
    const text = { subtree: true, childList: true, characterData: true };
    watch(document.getElementById('railMachineName'), text);
    watch(document.getElementById('syncTime'), text);
    watch(document.getElementById('syncBtn'), text);
    // Power and switcher only change by inline style or by being re-rendered;
    // #topbarMachineIcon is an animated SVG and is deliberately left alone.
    const styleOnly = { attributes: true, attributeFilter: ['style'] };
    watch(document.getElementById('powerBtn'), styleOnly);
    watch(document.getElementById('machineSwitcher'), { ...styleOnly, childList: true, subtree: true });
    watch(document.getElementById('expandSidebarBtn'), { attributes: true, attributeFilter: ['class'] });

    // Web fonts change every label's width once they arrive.
    const fonts = document.fonts;
    if (fonts) {
        fonts.addEventListener?.('loadingdone', () => layoutTopbarNav());
        const ready = fonts.ready;
        if (typeof ready?.then === 'function') {
            void ready.then(() => layoutTopbarNav(), () => { /* no fonts API */ });
        }
    }

    // The native <details>/<button> pair supplies Tab and Enter/Space; Escape
    // and a click outside close the menu.
    more.addEventListener('toggle', () => {
        if (more.open) renderMenu(tabs);
    });
    document.getElementById('topbarNavMenu')?.addEventListener('click', event => {
        const entry = (event.target as Element | null)?.closest('[data-nav-target]');
        const target = entry?.getAttribute('data-nav-target');
        if (!target) return;
        closeMenu(more);
        const tab = document.getElementById(target);
        tab?.click();
        tab?.focus();
    });
    document.addEventListener('keydown', event => {
        if (!more.open || event.key !== 'Escape') return;
        event.preventDefault();
        closeMenu(more);
        more.querySelector<HTMLElement>('summary')?.focus();
    });
    document.addEventListener('pointerdown', event => {
        if (!more.open) return;
        const target = event.target as Node | null;
        if (target && more.contains(target)) return;
        closeMenu(more);
    });
}
