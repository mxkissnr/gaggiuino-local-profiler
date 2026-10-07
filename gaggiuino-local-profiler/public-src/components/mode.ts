import { S } from '../state/index.js';
import { updateMobileShotSidebarVisibility } from './sidebar.js';
import { applyBottomNavActiveState } from './bottom-nav.js';

const TOPBAR_FADE_LEFT = 'fade-left';
const TOPBAR_FADE_RIGHT = 'fade-right';
// #1516: 1px of slack so sub-pixel rounding/zoom never leaves the row looking
// scrollable when it is flush at an edge (or hides a fade on a fitted row).
const TOPBAR_FADE_TOLERANCE = 1;

export interface TopbarNavFadeState {
  fadeLeft: boolean;
  fadeRight: boolean;
}

/**
 * Pure: which edges of the desktop tab row have hidden tabs, from its scroll
 * metrics. No overflow (within tolerance) → no fade on either edge.
 */
export function topbarNavFadeState(scrollLeft: number, scrollWidth: number, clientWidth: number): TopbarNavFadeState {
  const maxScroll = scrollWidth - clientWidth;
  const scrollable = maxScroll > TOPBAR_FADE_TOLERANCE;
  return {
    fadeLeft: scrollable && scrollLeft > TOPBAR_FADE_TOLERANCE,
    fadeRight: scrollable && scrollLeft < maxScroll - TOPBAR_FADE_TOLERANCE,
  };
}

function applyTopbarNavFade(el: HTMLElement): void {
  const { fadeLeft, fadeRight } = topbarNavFadeState(el.scrollLeft, el.scrollWidth, el.clientWidth);
  el.classList.toggle(TOPBAR_FADE_LEFT, fadeLeft);
  el.classList.toggle(TOPBAR_FADE_RIGHT, fadeRight);
}

function topbarNavScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.topbar-nav-scroll');
}

/** Re-reads the row's metrics and toggles the edge-fade modifier classes. */
export function updateTopbarNavFade(): void {
  const el = topbarNavScroller();
  if (el) applyTopbarNavFade(el);
}

let topbarNavFadeBound = false;

/**
 * Binds the fade to the row's scroll event (passive) and a ResizeObserver,
 * then applies it once. Idempotent: later calls only re-apply the classes.
 */
export function initTopbarNavFade(): void {
  if (topbarNavFadeBound) { updateTopbarNavFade(); return; }
  const el = topbarNavScroller();
  if (!el) return;
  topbarNavFadeBound = true;
  el.addEventListener('scroll', () => applyTopbarNavFade(el), { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => applyTopbarNavFade(el));
    observer.observe(el);
    // The tab list keeps the scroller's width (its flex-shrink:0 buttons
    // overflow it), so a label-width change from a language switch resizes no
    // box the row owns. Observe each button instead — its width follows its
    // text — so the fade is re-measured once translations have been applied.
    el.querySelectorAll('.topbar-nav').forEach(btn => observer.observe(btn));
  }
  applyTopbarNavFade(el);
}

export function goToShot(id: number): void {
  switchMode('shots');
  if (window.selectShot) window.selectShot(id);
  setTimeout(() => {
    const el = document.getElementById(`wrapper-${id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 50);
}

export function switchMode(mode: string): void {
  // #430: flush any pending debounced annotation save before leaving Shots —
  // the annotation panel (and its auto-save) only exists there, so this is
  // the mode-switch equivalent of the blur/visibilitychange flushes wired in
  // main.js.
  if (S.currentMode === 'shots' && mode !== 'shots' && window.flushAutoSave) window.flushAutoSave();
  S.currentMode = mode;
  (document.getElementById('btnShots') as HTMLElement).classList.toggle('active',       mode === 'shots');
  (document.getElementById('btnLive') as HTMLElement).classList.toggle('active',        mode === 'live');
  (document.getElementById('btnAnalytics') as HTMLElement).classList.toggle('active',   mode === 'analytics');
  (document.getElementById('btnDialin') as HTMLElement).classList.toggle('active',      mode === 'dialin');
  (document.getElementById('btnLibrary') as HTMLElement).classList.toggle('active',     mode === 'library');
  (document.getElementById('btnMaintenance') as HTMLElement).classList.toggle('active', mode === 'maintenance');
  (document.getElementById('btnAchievements') as HTMLElement).classList.toggle('active', mode === 'achievements');
  (document.getElementById('btnOrders') as HTMLElement).classList.toggle('active',      mode === 'orders');
  (document.getElementById('btnSettings') as HTMLElement).classList.toggle('active',    mode === 'settings');

  // Bottom nav (#403, #443, mobile) — mirrors the rail's active state above.
  // Which bn* id is active vs. which container it's currently rendered in
  // (main bar or "Mehr" sheet) is user-configurable since #443, so this is
  // delegated to bottom-nav.js's own DOM-containment-based projection
  // instead of a hardcoded mode-name list here.
  applyBottomNavActiveState(mode);

  (document.getElementById('shots-view') as HTMLElement).style.display       = mode === 'shots'       ? 'flex' : 'none';
  (document.getElementById('live-view') as HTMLElement).style.display        = mode === 'live'        ? 'flex' : 'none';
  (document.getElementById('analytics-view') as HTMLElement).style.display   = mode === 'analytics'   ? 'flex' : 'none';
  (document.getElementById('dialin-view') as HTMLElement).style.display      = mode === 'dialin'      ? 'flex' : 'none';
  (document.getElementById('library-view') as HTMLElement).style.display     = mode === 'library'     ? 'flex' : 'none';
  (document.getElementById('maintenance-view') as HTMLElement).style.display = mode === 'maintenance' ? 'flex' : 'none';
  (document.getElementById('achievements-view') as HTMLElement).style.display = mode === 'achievements' ? 'flex' : 'none';
  (document.getElementById('orders-view') as HTMLElement).style.display      = mode === 'orders'      ? 'flex' : 'none';
  (document.getElementById('settings-view') as HTMLElement).style.display    = mode === 'settings'    ? 'grid' : 'none';

  if (mode === 'live') {
    if (window.populateRefSelector) window.populateRefSelector();
    if (window.connectLiveStream) window.connectLiveStream();
  } else {
    if (window.disconnectLiveStream) window.disconnectLiveStream();
  }
  if (mode === 'analytics')   { if (window.initAnalytics) window.initAnalytics(); }
  if (mode === 'dialin')      { if (window.renderDialin) window.renderDialin(); }
  if (mode === 'library')     {
    if (window.renderBeanList) window.renderBeanList();
    if (window.renderGrinderList) window.renderGrinderList();
  }
  if (mode === 'maintenance') { if (window.loadMaintenanceView) window.loadMaintenanceView(); }
  if (mode === 'achievements') { if (window.loadAchievementsView) window.loadAchievementsView(); }
  // #334: re-render on every entry so the per-machine shot count reflects
  // S.allShots as of now, not whatever it was at the initial loadMachines()
  // call (which can race loadData() on startup — see #333).
  if (mode === 'settings')    { if (window.renderMachinesList) window.renderMachinesList(); }
  if (mode === 'orders') {
    if (window.loadOrdersView) window.loadOrdersView();
    if (window.startOrdersPolling) window.startOrdersPolling();
  } else {
    if (window.stopOrdersPolling) window.stopOrdersPolling();
  }

  const modeMap: Record<string, string> = {
    shots: 'btnShots', live: 'btnLive', analytics: 'btnAnalytics',
    dialin: 'btnDialin', library: 'btnLibrary', maintenance: 'btnMaintenance',
    achievements: 'btnAchievements', orders: 'btnOrders', settings: 'btnSettings'
  };
  const btnId = modeMap[mode];
  const activeBtn = btnId ? document.getElementById(btnId) : null;
  if (activeBtn) {
    // #1516: only scroll when the tab is actually clipped, so switching to an
    // already-visible tab does not nudge the row needlessly, then refresh the
    // edge fade for the new scroll position.
    const scroller = activeBtn.closest<HTMLElement>('.topbar-nav-scroll');
    if (scroller && typeof activeBtn.getBoundingClientRect === 'function') {
      const btnRect = activeBtn.getBoundingClientRect();
      const rowRect = scroller.getBoundingClientRect();
      if (btnRect.left < rowRect.left || btnRect.right > rowRect.right) {
        activeBtn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
    updateTopbarNavFade();
  }

  // #410/#461: mobile shows #shots-view full screen only while
  // mode === 'shots' — re-evaluate on every mode switch, e.g. so a leftover
  // burger-drawer overlay closes when leaving Shots for Library.
  updateMobileShotSidebarVisibility();
}

// #1516: bind the edge fade once the app is live. The row's markup is in
// index.html, and the `load` handler runs after main.ts's DOMContentLoaded
// handler has applied translations, so the tab labels are at their final
// widths when the first measurement happens.
if (typeof document !== 'undefined' && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  if (document.readyState === 'complete') initTopbarNavFade();
  else window.addEventListener('load', initTopbarNavFade);
}
