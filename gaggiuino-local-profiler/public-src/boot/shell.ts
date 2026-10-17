// Boot step (#1615): the app shell -- sidebar, topbar/bottom/drawer
// navigation, keyboard shot navigation, page-visibility handling. Moved
// verbatim out of main.ts's DOMContentLoaded handler; run through runStep()
// so a missing element only skips this step.
import { S } from '../state/index.js';
import { filterShots, setSortMode, sortedShots, toggleDesktopSidebar, selectShot, openShotDrawer,
         closeShotDrawer, handleDrawerTouchStart, handleDrawerTouchEnd, handleEdgeSwipeStart,
         handleEdgeSwipeEnd } from '../components/sidebar.js';
import { updateStatus, toggleMachinePower, triggerSync } from '../components/status.js';
import { switchMode } from '../components/mode.js';
import { renderBottomNav, renderBottomNavSettings, closeMoreSheet } from '../components/bottom-nav.js';
import { toggleTrash, flushAutoSave } from '../views/shots.js';
import { loadDemoData, endDemo } from '../components/onboarding.js';
import { handleTopbarMachineIconClick, bindEasterEggPanelEscape } from '../components/topbar-machine-icon.js';
import { renderWhatsNewCard } from '../components/whats-new.js';

export function wireAppShell(): void {
  bindEasterEggPanelEscape();

  // ── Keyboard navigation: left/right arrows between shots ──────────────
  document.addEventListener('keydown', e => {
    if (S.currentMode !== 'shots') return;
    // Ignore if focus is in an input/textarea
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const shots = sortedShots();
    if (!shots.length) return;
    const idx = shots.findIndex(s => s.id === S.primaryShotId);

    if (e.key === 'ArrowRight') {
      const next = shots[idx + 1];
      if (next) selectShot(next.id);
    } else if (e.key === 'ArrowLeft') {
      const prev = shots[idx - 1];
      if (prev) selectShot(prev.id);
    }
  });

  // ── Static element wiring ──────────────────────────────────────────────
  document.getElementById('collapseBtn')!.addEventListener('click', toggleDesktopSidebar);
  document.getElementById('expandSidebarBtn')!.addEventListener('click', toggleDesktopSidebar);
  // #969: filterShots() does 3 full DOM passes over the shot list; on a
  // large history that's too much work to redo synchronously on every
  // keystroke. Debounce so a fast typist only pays for it once per pause.
  let _searchDebounce: ReturnType<typeof setTimeout> | undefined;
  document.getElementById('shotSearch')!.addEventListener('input', e => {
    const value = (e.target as HTMLInputElement).value;
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => filterShots(value), 150);
  });
  document.getElementById('sortNewest')!.addEventListener('click', () => setSortMode('newest'));
  document.getElementById('sortScore')!.addEventListener('click', () => setSortMode('score'));
  document.getElementById('sortRating')!.addEventListener('click', () => setSortMode('rating'));
  document.getElementById('sortDur')!.addEventListener('click', () => setSortMode('duration'));
  document.getElementById('trash-toggle')!.addEventListener('click', toggleTrash);
  document.getElementById('powerBtn')!.addEventListener('click', () => { void toggleMachinePower(); });
  // #914: mobile topbar duplicate of #powerBtn -- see index.html comment.
  document.getElementById('railPowerBtn')!.addEventListener('click', () => { void toggleMachinePower(); });
  document.getElementById('syncBtn')!.addEventListener('click', () => { void triggerSync(); });
  document.getElementById('onboardingDemoBtn')!.addEventListener('click', () => { void loadDemoData(); });
  document.getElementById('glpDemoEndBtn')!.addEventListener('click', () => { void endDemo(); });

  // ── Desktop topbar nav (#424) — same ids as the old #rail/#mode-bar
  // buttons, just relocated+restyled markup, so switchMode()'s active-state
  // toggling and status.ts's live/orders visibility gating both keep
  // working unchanged.
  document.getElementById('btnLive')!.addEventListener('click', () => switchMode('live'));
  document.getElementById('btnShots')!.addEventListener('click', () => switchMode('shots'));
  document.getElementById('btnAnalytics')!.addEventListener('click', () => switchMode('analytics'));
  document.getElementById('btnDialin')!.addEventListener('click', () => switchMode('dialin'));
  document.getElementById('btnLibrary')!.addEventListener('click', () => switchMode('library'));
  document.getElementById('btnMaintenance')!.addEventListener('click', () => switchMode('maintenance'));
  document.getElementById('btnAchievements')!.addEventListener('click', () => switchMode('achievements'));
  document.getElementById('btnOrders')!.addEventListener('click', () => switchMode('orders'));
  // #1514: still wired by id — Settings moved out of .topbar-nav-scroll into a
  // fixed topbar slot but kept #btnSettings, so this listener needs no change.
  document.getElementById('btnSettings')!.addEventListener('click', () => switchMode('settings'));

  // ── Mobile burger drawer (#425) — additive shot-list access from any
  // view; the bottom-nav Shots-primary-screen flow below is unaffected.
  document.getElementById('mobileDrawerBtn')!.addEventListener('click', openShotDrawer);
  document.getElementById('sidebar-drawer-backdrop')!.addEventListener('click', closeShotDrawer);
  document.getElementById('sidebar')!.addEventListener('touchstart', handleDrawerTouchStart, { passive: true });
  document.getElementById('sidebar')!.addEventListener('touchend', handleDrawerTouchEnd, { passive: true });
  // #682: edge-swipe-to-open is bound to `document`, not #sidebar -- the
  // sidebar is transformed off-screen while closed and therefore can't
  // receive touch events itself.
  document.addEventListener('touchstart', handleEdgeSwipeStart, { passive: true });
  document.addEventListener('touchend', handleEdgeSwipeEnd, { passive: true });

  // ── Bottom navigation (#403, #443, mobile) ───────────────────────────────
  // #431: Shots opens the shot detail directly (latest/last-selected shot) —
  // the shot list is no longer reachable from here at all, only via the
  // burger drawer (#425's openShotDrawer, wired above). #443: which
  // destinations land in the bar vs. the "Mehr" sheet, and their click
  // wiring, is now built by renderBottomNav() (components/bottom-nav.ts)
  // from the user's glp_bottom_nav_config — only the static backdrop needs
  // wiring here.
  renderBottomNav();
  renderBottomNavSettings();
  renderWhatsNewCard();
  document.getElementById('more-sheet-backdrop')!.addEventListener('click', closeMoreSheet);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAutoSave();
    // #733: the 30s setInterval(updateStatus, ...) below gets throttled by
    // the browser while the tab is backgrounded, so force one immediate poll
    // on refocus to refresh the status dot/hostname/sync time without waiting
    // for the next tick.
    //
    // #734 review: must pass S.activeMachineId through, same as
    // applyActiveMachineChange() does (#464) -- an unscoped call hits the
    // default machine's /api/status and overwrites #railMachineName/
    // #railStatusDot even when a non-default machine is the active
    // selection, undoing #464's fix via this new trigger.
    if (document.visibilityState === 'visible') void updateStatus(S.activeMachineId);
  });
  document.getElementById('topbarMachineIcon')!.addEventListener('click', handleTopbarMachineIconClick);
}
