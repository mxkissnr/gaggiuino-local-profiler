export const S = {
  currentLang: (() => {
    const stored = localStorage.getItem('glp_lang');
    const lang = stored || navigator.language.slice(0, 2).toLowerCase();
    return lang;
  })(),
  glpToken: localStorage.getItem('glp_token') || '',
  // S.shots is the currently *visible* (machine-filtered) set every existing
  // view (sidebar, analytics, ...) already reads; S.allShots is the full
  // unfiltered fetch from the server, re-filtered into S.shots whenever
  // S.activeMachineId changes (#325) — see filterShotsByMachine() below and
  // applyActiveMachineChange() in components/machines-settings.js.
  shots: [],
  allShots: [],
  trashedShots: [],
  chart: null,
  primaryShotId: null,
  compareShotId: null,
  currentRating: 0,
  currentMode: 'shots',
  // #454: 'detail' by default so a fresh page load lands on the last shot's
  // detail view (per #431's intent), not the shot list — see
  // updateMobileShotSidebarVisibility() in components/sidebar.js.
  mobileShotSubview: 'detail',
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
  dialinProgressionChart: null,
  trendWindow: 30,
  _calendarResizeObserver: null,
  currentFilter: '',
  // #439: which month-tier sidebar groups are expanded — in-memory only
  // (never mirrored to localStorage), so it survives re-renders/shot
  // switches within a session but resets on a fresh page load, matching the
  // pre-#399 sidebar's month-accordion behavior.
  _expandedMonths: new Set(),
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
  // Multi-machine registry (#319) — S.machines mirrors GET /api/machines;
  // activeMachineId is restored from localStorage in machines-settings.js.
  machines: [],
  activeMachineId: null,
  machineProfiles: [],
  profileEditId: null,
  profileEditBeanId: null,
  profilePreviewChart: null,
  // Guided Dial-In (#310) — session is client-only, mirrored to localStorage
  // so a reload doesn't lose an in-progress dial-in (see dialin-wizard.js).
  dialinSession: (() => {
    try { return JSON.parse(localStorage.getItem('glp_dialin_session') || 'null'); }
    catch { return null; }
  })(),
  // Profile Dial-In (#313) — same client-only, localStorage-mirrored pattern
  // as dialinSession, adapted for tuning a machine profile's phases (see
  // profile-dialin-wizard.js) instead of a single grind number.
  profileDialinSession: (() => {
    try { return JSON.parse(localStorage.getItem('glp_profile_dialin_session') || 'null'); }
    catch { return null; }
  })(),
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

// Multi-machine shot filtering (#325). `activeMachineId` of null (machines
// not loaded yet) or the sentinel 'all' means "show everything" — a shot
// with no machineId at all (e.g. cached/pre-#317 data) is treated as
// belonging to the default machine (id 1), matching the backend's own
// default-machine convention.
export function filterShotsByMachine(shots, activeMachineId) {
  if (activeMachineId == null || activeMachineId === 'all') return shots;
  return shots.filter(s => (s.machineId ?? 1) === activeMachineId);
}
