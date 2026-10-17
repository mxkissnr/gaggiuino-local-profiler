// Boot step (#1615): the static controls of the maintenance, orders, live,
// analytics and dial-in views. Moved verbatim out of main.ts's
// DOMContentLoaded handler; run through runStep() so a missing element only
// skips this step.
import { t } from '../i18n.js';
import { onRefShotChange, clearReferenceShot } from '../views/live.js';
import { getAnalyticsFilter, setAnalyticsFilter, initAnalyticsMoreFold } from '../views/analytics.js';
import { openMaintLogForm, closeMaintLogForm, submitMaintLogEntry } from '../views/maintenance.js';
import { setOrdersEnabled, toggleOrdersMenu, addOrderMenuItem, toggleOrdersStats, toggleOrdersNotify } from '../views/orders.js';
import { renderDialin } from '../views/dialin.js';
import { safeLocalStorage } from '../storage.js';

export function wireViews(): void {
  document.getElementById('openMaintLogBtn')!.addEventListener('click', openMaintLogForm);
  document.getElementById('submitMaintLogBtn')!.addEventListener('click', () => { void submitMaintLogEntry(); });
  document.getElementById('cancelMaintLogBtn')!.addEventListener('click', closeMaintLogForm);
  document.getElementById('ordersEnabledToggle')!.addEventListener('change', e => { void setOrdersEnabled((e.target as HTMLInputElement).checked); });
  document.getElementById('ordersMenuTitle')!.addEventListener('click', toggleOrdersMenu);
  document.getElementById('ordersStatsTitle')!.addEventListener('click', toggleOrdersStats);
  document.getElementById('ordersNotifyTitle')!.addEventListener('click', toggleOrdersNotify);
  document.getElementById('addOrderMenuItemBtn')!.addEventListener('click', () => { void addOrderMenuItem(); });
  document.getElementById('refShotSelect')!.addEventListener('change', e => onRefShotChange((e.target as HTMLInputElement).value));
  document.getElementById('refClearBtn')!.addEventListener('click', clearReferenceShot);

  // ── Analytics toolbar (#1467): one period + search filter for the whole
  // page. The chips mirror the saved state; the search debounces so a fast
  // typist only re-runs the builders once per pause.
  const analyticsSearch = document.getElementById('analyticsSearch') as HTMLInputElement | null;
  const analyticsRangeChips = document.querySelectorAll<HTMLElement>('[data-action="analytics-range"]');
  const syncAnalyticsRangeChips = (days: number): void => {
    analyticsRangeChips.forEach(chip => {
      const on = Number(chip.dataset.days) === days;
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  };
  const _analyticsFilter = getAnalyticsFilter();
  syncAnalyticsRangeChips(_analyticsFilter.days);
  if (analyticsSearch) {
    analyticsSearch.value = _analyticsFilter.query;
    analyticsSearch.setAttribute('aria-label', t('analytics_search_ph'));
    let _analyticsSearchDebounce: ReturnType<typeof setTimeout> | undefined;
    analyticsSearch.addEventListener('input', e => {
      const value = (e.target as HTMLInputElement).value;
      clearTimeout(_analyticsSearchDebounce);
      _analyticsSearchDebounce = setTimeout(() => setAnalyticsFilter({ query: value }), 150);
    });
  }
  analyticsRangeChips.forEach(chip => chip.addEventListener('click', () => {
    const days = Number(chip.dataset.days) as 0 | 7 | 30 | 90;
    syncAnalyticsRangeChips(days);
    setAnalyticsFilter({ days });
  }));
  // #1467: the "More insights" fold starts closed, remembers the viewer's
  // choice and only builds its charts once opened (Chart.js cannot measure a
  // hidden canvas).
  initAnalyticsMoreFold();
  document.getElementById('dialinCount')!.addEventListener('change', e => {
    safeLocalStorage.setItem('glp_dialin_count', (e.target as HTMLInputElement).value);
    void renderDialin();
  });
}
