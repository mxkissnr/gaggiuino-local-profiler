import { TRANSLATIONS } from './constants.js';

export const S = {
  // navigator.language used to be trusted as-is, with no
  // check against the languages GLP actually ships (TRANSLATIONS below) —
  // an unsupported browser locale (e.g. pt, pl, sv) fell through to
  // i18n.js's own TRANSLATIONS.de fallback, showing the entire UI in German
  // to a non-German user by construction. Validate against the real key set
  // here instead and fall back to English, matching every other
  // unsupported-language fallback in this codebase (i18n.js's t(),
  // constants.js's localeFor(), the backend's getHaLanguage()/notifyT()).
  currentLang: (() => {
    const stored = localStorage.getItem('glp_lang');
    const lang = stored || navigator.language.slice(0, 2).toLowerCase();
    return Object.prototype.hasOwnProperty.call(TRANSLATIONS, lang) ? lang : 'en';
  })(),
  // In-memory only (#522) — never persisted to localStorage. A fresh token is
  // fetched on every load via initToken()'s /api/token call (see api.js).
  glpToken: '',
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
  shotDefaults: null,
  beanEditId: null,
  _beanStockEditId: null,
  grinderEditId: null,
  basketEditId: null,
  puckScreenEditId: null,
  trendChart: null,
  profileBarChart: null,
  doseDistChart: null,
  ratioDistChart: null,
  timeOfDayChart: null,
  dialinProgressionChart: null,
  trendWindow: 30,
  _calendarResizeObserver: null,
  currentFilter: '',
  // Structured bean filter (shot history) — set by clicking a bean in the
  // Library view; ANDed with the free-text S.currentFilter search in
  // filterShots() (sidebar.js). { id, name } or null for "no filter".
  beanFilter: null,
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
  legacyMachineOptionsPending: false, // #662
  // #735: SSE push connection state -- null = "not yet known" (treated the
  // same as false by consumers until proven true), true once EventSource
  // has successfully opened at least once, false once fallback detection
  // (see sse.js) has given up on it for this session.
  sseActive: null,
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
