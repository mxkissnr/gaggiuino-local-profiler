// #1516: the desktop topbar's tab row (.topbar-nav-scroll) scrolls
// horizontally with its scrollbar hidden, so on a narrow window the tabs that
// fall off the edge look cut off rather than scrollable. These helpers keep a
// mask fade on whichever edge still has hidden tabs.

// Sub-pixel scroll offsets are normal, so treat anything within a pixel of an
// edge as "at" that edge rather than showing a fade for it.
const EDGE_TOLERANCE = 1;

// Pure: the edge classes the row should carry for the given scroll metrics.
// An empty list when every tab fits, so a row that cannot scroll stays clean.
export function topbarNavFadeClasses(scrollLeft: number, scrollWidth: number, clientWidth: number): string[] {
    const maxScroll = scrollWidth - clientWidth;
    if (maxScroll <= EDGE_TOLERANCE) return [];
    const classes: string[] = [];
    if (scrollLeft > EDGE_TOLERANCE) classes.push('fade-left');
    if (scrollLeft < maxScroll - EDGE_TOLERANCE) classes.push('fade-right');
    return classes;
}

export function updateTopbarNavFade(el: HTMLElement | null): void {
    if (!el) return;
    const classes = topbarNavFadeClasses(el.scrollLeft, el.scrollWidth, el.clientWidth);
    el.classList.toggle('fade-left', classes.includes('fade-left'));
    el.classList.toggle('fade-right', classes.includes('fade-right'));
}

// Whether `el` is fully inside `scroller`'s visible box; drives switchMode()'s
// scroll-into-view so an already-visible tab is not needlessly re-scrolled.
export function isFullyVisibleIn(el: HTMLElement, scroller: HTMLElement): boolean {
    const b = el.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return b.left >= s.left - EDGE_TOLERANCE && b.right <= s.right + EDGE_TOLERANCE;
}

export function initTopbarNavFade(): void {
    const el = document.querySelector<HTMLElement>('.topbar-nav-scroll');
    if (!el) return;
    const sync = (): void => updateTopbarNavFade(el);
    el.addEventListener('scroll', sync, { passive: true });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sync).observe(el);
    // applyTranslations() swaps the tab labels' text nodes, changing the row's
    // scrollWidth without resizing the row's own box (its width is set by the
    // flex parent), so a ResizeObserver on the row can't see it — watch the
    // content instead.
    if (typeof MutationObserver !== 'undefined') {
        new MutationObserver(sync).observe(el, { childList: true, characterData: true, subtree: true });
    }
    sync();
}
