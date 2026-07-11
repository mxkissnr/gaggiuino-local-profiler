export const S = {
  currentLang: (() => {
    const stored = localStorage.getItem('glp_lang');
    const lang = stored || navigator.language.slice(0, 2).toLowerCase();
    return lang;
  })(),
  glpToken: localStorage.getItem('glp_token') || '',
  shots: [],
  trashedShots: [],
  chart: null,
  primaryShotId: null,
  compareShotId: null,
  currentRating: 0,
  currentMode: 'shots',
  trashOpen: false,
  livePollInterval: null,
  preheatPollInterval: null,
  liveChart: null,
  refShotId: null,
  liveIsActive: false,
  liveLastSeq: -1,
  liveWasLive: false,
  liveBrewStartWall: null,
  liveTimerTick: null,
  pqChart: null,
  currentChartTab: 'zeit',
  machinePowerState: null,
  currentSort: 'newest',
  sortAsc: false,
  fsChart: null,
  currentFsTab: 'zeit',
  _flapInitDone: false,
  coffeeLibrary: { beans: [], grinders: [] },
  drinkMenu: [],
  milkTypes: [],
  beanEditId: null,
  _beanStockEditId: null,
  grinderEditId: null,
  trendChart: null,
  profileBarChart: null,
  doseDistChart: null,
  ratioDistChart: null,
  timeOfDayChart: null,
  trendWindow: 30,
  _calendarResizeObserver: null,
  currentFilter: '',
  _urlImportSource: null,
  _urlImportedAt: null,
  _urlImportSourceUrl: null,
  _scanStream: null,
  _scanDetector: null,
  _scanActive: false,
  _ordersMenuOpen: true,
  _ordersPollTimer: null,
  _ordersEtaSelected: {},
  _ordersDeclineOpen: {},
  _ordersStatsOpen: false,
  machineReachable: null,
  isDemo: false,
  machineProfiles: [],
  profileEditId: null,
  profileEditBeanId: null,
  profilePreviewChart: null,
};

// ── Reactive pub/sub ──────────────────────────────────────────────────────
// Lightweight wrapper: setState() mutates S and notifies subscribers for
// that key. Direct S mutations (S.shots = [...]) continue to work as before
// and don't notify — use setState() for reactive updates going forward.

const _subs = new Map();

export function subscribe(key, callback) {
  if (!_subs.has(key)) _subs.set(key, new Set());
  _subs.get(key).add(callback);
  return () => _subs.get(key)?.delete(callback);
}

export function setState(key, value) {
  S[key] = value;
  _subs.get(key)?.forEach(cb => cb(value));
}
