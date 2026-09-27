// Demo banner (#1193). The static GitHub Pages demo answers every API request
// from recorded fixtures, so a form the visitor submits is accepted and then
// thrown away. This slim bar sits above the app so they always know they are
// in a demo, and it repeats that a write was not saved when the service worker
// says one happened.
//
// The offset follows components/dev-banner.ts: body is `height: 100vh;
// overflow: hidden` with global `box-sizing: border-box`, so a body padding-top
// shrinks the flex layout by the banner's own height. On mobile #main and
// #sidebar are `position: fixed; inset: 0` against the viewport, where that
// padding has no effect, so they get an inline `top` (an inline top wins over
// the media query's inset shorthand) and are shrunk by the banner's height too
// so their own `height: 100vh` cannot run past the viewport bottom; on desktop
// they are static and those inline styles are cleared.
import { t } from '../i18n.js';

const BANNER_ID = 'glpDemoBanner';
const WRITE_MESSAGE = 'glp-demo-write';
const NOT_SAVED_MS = 3000;
const README_URL = 'https://github.com/mxkissnr/gaggiuino-local-profiler#readme';
const FIXED_PANES = ['main', 'sidebar'];

function buildBanner(): HTMLElement {
    const bar = document.createElement('div');
    bar.id = BANNER_ID;
    Object.assign(bar.style, {
        position: 'fixed', top: '0', left: '0', right: '0', zIndex: '9999',
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center',
        gap: 'var(--sp-1) var(--sp-3)', padding: 'var(--sp-1) var(--sp-3)',
        background: 'var(--raised)', color: 'var(--gray-200)',
        borderBottom: '1px solid var(--gray-700)',
        fontSize: 'var(--fs-1)', textAlign: 'center',
    });

    const label = document.createElement('span');
    label.dataset.i18n = 'demo.banner';
    label.textContent = t('demo.banner');

    const link = document.createElement('a');
    link.href = README_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.dataset.i18n = 'demo.getApp';
    link.textContent = t('demo.getApp');
    link.style.color = 'var(--accent-ink)';
    link.style.fontWeight = '600';
    link.style.whiteSpace = 'nowrap';

    bar.append(label, link);
    return bar;
}

/** Keeps the app (and the fixed mobile panes) clear of the banner. */
function offsetApp(bar: HTMLElement): void {
    const height = bar.offsetHeight;
    document.body.style.paddingTop = `${height}px`;
    for (const id of FIXED_PANES) {
        const pane = document.getElementById(id);
        if (!pane) continue;
        // Desktop keeps these in flow and full-height; only the fixed mobile
        // panes need the inline offset, and they must shrink by the banner's
        // height too or their own `height: 100vh` would push the bottom of
        // their scroll area off-screen.
        if (getComputedStyle(pane).position === 'fixed') {
            pane.style.top = `${height}px`;
            pane.style.height = `calc(100vh - ${height}px)`;
        } else {
            pane.style.top = '';
            pane.style.height = '';
        }
    }
}

function showNotSaved(bar: HTMLElement): void {
    if (window.showToast) {
        window.showToast(t('demo.notSaved'));
        return;
    }
    // No toast helper wired (shouldn't happen once main.ts has loaded): swap
    // the banner text itself for the same few seconds.
    const label = bar.querySelector<HTMLElement>('[data-i18n="demo.banner"]');
    if (!label) return;
    label.textContent = t('demo.notSaved');
    window.setTimeout(() => { label.textContent = t('demo.banner'); }, NOT_SAVED_MS);
}

function watchWrites(bar: HTMLElement): void {
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { type?: string } | null | undefined;
        if (data?.type === WRITE_MESSAGE) showNotSaved(bar);
    });
}

/**
 * Mounts the fixed demo banner and keeps the app offset below it. Idempotent,
 * so a second call (e.g. a re-run of the demo boot) is a no-op.
 */
export function mountDemoBanner(): void {
    if (document.getElementById(BANNER_ID)) return;
    const bar = buildBanner();
    document.body.insertAdjacentElement('afterbegin', bar);
    offsetApp(bar);
    // A language switch can rewrap the text and a resize can change its height,
    // so re-offset whenever the bar's own size changes rather than only once.
    window.addEventListener('resize', () => { offsetApp(bar); });
    new ResizeObserver(() => { offsetApp(bar); }).observe(bar);
    watchWrites(bar);
}
