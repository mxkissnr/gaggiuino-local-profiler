import { S } from '../state.js';
import { t } from '../i18n.js';
import { localeFor } from '../constants.js';
import { apiFetch } from '../api.js';
import { shareOrDownloadBlob } from '../utils.js';
import { updateMachineBanner, updateOnboardingPanel, updateDemoBadge, updateLegacyMachineOptionsBanner } from './onboarding.js';
import { showDevBuildBanner } from './dev-banner.js';
import { syncInstallId } from '../views/setup-wizard.js';

// Tracks the server-side shot count as of the last status poll, so the periodic
// poll below can detect a newly-finished shot even when the user isn't on the
// shots view (and thus never got the live.js post-brew loadData() trigger) —
// see #296.
let knownShotCount = null;

// #731/#735: active shot-import progress entries as last seen by the
// *polling fallback* (pollSyncProgressFallback() below, only exercised when
// S.sseActive is falsy) -- keyed by machineId, kept only so the poll that
// finds a given machine's entry gone can show that machine's own "done"
// toast. Must be per-machine, not a single scalar: lib/state.js's own
// state.syncProgress is deliberately keyed by machineId too (see its and
// lib/sync.js's comments), because more than one machine can be backfilling
// at once and their progress must not clobber each other -- a scalar here
// would let machine B's completion go untoasted for as long as machine A is
// still active (whichever entry happened to be tracked last wins), and would
// misattribute A's total to B's toast once A also finished. An entry is
// deleted the moment its toast fires, so it doesn't repeat on later polls,
// and a machineId only ever toasts once it's first been seen active (so
// app startup never fires it for an import already in progress before this
// session opened). Entirely separate from _pushSyncProgress below -- the two
// paths never share state, so a mid-session S.sseActive flip can't leave
// either one with stale/duplicate data.
let _lastSyncProgress = new Map();

// #735: same per-machine tracking as _lastSyncProgress above, but driven
// purely by SSE push (handleSyncProgressEvent/handleSyncCompleteEvent) --
// used only to pick which machine's bar to render when more than one is
// backfilling, since a "complete" push has no list to fall back to the way
// the polling fallback's /api/status response does.
const _pushSyncProgress = new Map();

// #742 review: two machines can genuinely backfill concurrently (syncShots()/
// syncMachineShots() are not mutually exclusive, see lib/sync.js) -- an
// earlier version of this tracked a baseline PER machine and displayed
// "that machine's own baseline + current" on every event, which made the
// shared header flicker/regress between each machine's independent total
// (e.g. 42 -> 39 -> 42...) instead of showing one consistent combined
// count. The same global/scalar-instead-of-per-machine-keyed bug class
// already fixed in #730/#732, except inverted here: S.shots.length is a
// single global count (not per-machine), so there can only be ONE shared
// base, with each machine contributing its own `current` on top of it.
//
// _midSyncCurrent: machineId -> that machine's own last-seen `current`, for
// every machine presently mid-sync. The displayed count is always
// _globalBaseline + the SUM of every entry here.
// _globalBaseline: S.shots.length (or a running fold of already-finished
// machines' final `current`, see below), captured fresh the moment the
// FIRST machine of a new "nobody currently mid-sync" round starts
// backfilling -- stays fixed while anything is still mid-sync, so a second
// machine joining in never re-samples S.shots.length out from under an
// already-in-progress display. Reserved for the SSE push path only.
let _midSyncCurrent = new Map();
let _globalBaseline = null;

function displaySyncCount() {
  let sum = 0;
  for (const c of _midSyncCurrent.values()) sum += c;
  setShotCountDisplay((_globalBaseline ?? S.shots.length) + sum);
}

// #742: updates just the two DOM bits that show the shot count -- the
// sidebar header's "(N)" text and the flap-board odometer -- without going
// through the full renderSidebar()/loadData() cycle, which would be far too
// expensive to run on every SYNC_PROGRESS tick (as fast as per-shot).
function setShotCountDisplay(n) {
  const countEl = document.getElementById('shot-count');
  if (countEl) countEl.textContent = `(${n})`;
  if (window.updateFlapCounter) window.updateFlapCounter(n);
}

// #735: shared bar-rendering helper -- both the polling fallback and the
// SSE push handlers need to render "this machine's import is at
// current/total" (or hide the bar entirely) the exact same way.
function renderSyncProgressBar(entry) {
  const syncProgressBar = document.getElementById('syncProgressBar');
  if (!syncProgressBar) return;
  if (!entry) {
    syncProgressBar.style.display = 'none';
    return;
  }
  const { current, total } = entry;
  const label = document.getElementById('syncProgressLabel');
  const fill  = syncProgressBar.querySelector('.sync-progress-fill');
  if (label) label.textContent = t('sync_progress_label', current, total);
  if (fill) fill.style.width = `${Math.min(100, (current / total) * 100)}%`;
  syncProgressBar.style.display = '';
}

// #731: the pre-SSE polling implementation, kept as the fallback path for
// whenever SSE hasn't (yet, or ever) connected this session -- see
// public-src/sse.js's fallback detection. Derives "a backfill just
// finished" purely from an entry disappearing between two /api/status
// polls, which is why it needs the toast/list bookkeeping below; the SSE
// push path (handleSyncCompleteEvent) doesn't need any of this, since the
// backend tells it directly.
function pollSyncProgressFallback(list, machineId) {
  // #731: toast every previously-tracked machine whose entry is gone from
  // this poll's list -- independent of whichever single entry the bar
  // itself ends up showing below, so machine B finishing while A is still
  // backfilling still gets its own toast right away, not only once A also
  // finishes (or never, if A finished first and B's entry never got picked
  // as "the" entry to track).
  for (const [id, prev] of _lastSyncProgress) {
    if (!list.some(p => p.machineId === id)) {
      if (window.showToast) window.showToast(t('sync_complete_toast', prev.total));
      _lastSyncProgress.delete(id);
    }
  }
  for (const p of list) _lastSyncProgress.set(p.machineId, p);

  // There's only one bar to show even with multiple machines active --
  // prefer whichever machine this poll was scoped to, falling back to
  // the first active entry otherwise.
  const entry = list.length
    ? (list.find(p => p.machineId === Number(machineId)) || list[0])
    : null;
  renderSyncProgressBar(entry);
}

// #735: SSE push handlers -- registered once in main.js's bootstrap
// (connectEvents()/onEvent()), independent of whichever view is currently
// open. Structurally simpler than the polling fallback above: the backend
// tells us directly when a backfill finishes and whether it succeeded, so
// there's no "entry vanished between two polls" inference and no #731/#734
// class of race to guard against.
export function handleSyncProgressEvent({ machineId, current, total }) {
  _pushSyncProgress.set(machineId, { current, total });
  renderSyncProgressBar(_pickPushEntry());

  // #742 review: per-machine sequence detection (a fresh backfill for THIS
  // machine, either never tracked before or `current` resetting lower than
  // previously seen -- e.g. it restarted without a SYNC_COMPLETE ever
  // arriving for the prior attempt) is still needed, but must never disturb
  // another machine's already-in-flight contribution.
  const prevCurrent = _midSyncCurrent.get(machineId);
  if (prevCurrent === undefined) {
    // Only resample the shared base when NOTHING is currently mid-sync --
    // otherwise this machine is simply joining an already-active round.
    if (_midSyncCurrent.size === 0) _globalBaseline = S.shots.length;
  } else if (current < prevCurrent) {
    // This machine restarted its own sequence without ever completing the
    // previous one -- fold what it had already contributed into the shared
    // base (so the total never visibly regresses), then start it fresh.
    _globalBaseline = (_globalBaseline ?? S.shots.length) + prevCurrent;
  }
  _midSyncCurrent.set(machineId, current);
  displaySyncCount();
}

export function handleSyncCompleteEvent({ machineId, total, success }) {
  _pushSyncProgress.delete(machineId);
  // #742 review: fold this machine's final `current` into the shared base
  // instead of just dropping its entry -- those shots are already saved to
  // the DB (bumpSyncProgress() only fires per successfully-saved shot, see
  // lib/sync.js), so removing its contribution outright would make the
  // displayed count visibly drop by exactly that amount the moment it
  // finishes, even though nothing was actually lost.
  const finalCurrent = _midSyncCurrent.get(machineId) ?? 0;
  _midSyncCurrent.delete(machineId);
  _globalBaseline = (_globalBaseline ?? S.shots.length) + finalCurrent;
  displaySyncCount();
  renderSyncProgressBar(_pickPushEntry());
  // #737 review: the polling fallback above always toasts on completion
  // (it has no success/failure signal to work with) -- mirror that here so
  // an aborted backfill (success:false, e.g. a non-404 network error mid-
  // loop, see lib/sync.js) isn't silently swallowed just because SSE
  // happened to be the active transport this session.
  if (window.showToast) {
    window.showToast(success ? t('sync_complete_toast', total) : t('sync_failed_toast'));
  }
  // #742: on success, reconcile the exact DB count/shot list against the
  // baseline+current running total shown during the backfill above -- which
  // can drift from the truth (interleaved multi-machine backfills, a missed
  // tick) -- window.loadData() also calls renderSidebar() internally, so
  // this corrects the displayed count too, not just S.shots itself.
  if (success && window.loadData) window.loadData();
}

// Same "prefer the active machine, fall back to the first active entry"
// convention pollSyncProgressFallback() above uses for the REST list.
function _pickPushEntry() {
  if (!_pushSyncProgress.size) return null;
  return _pushSyncProgress.get(S.activeMachineId) ?? _pushSyncProgress.values().next().value;
}

// #734 review: updateStatus() can now be triggered from three independent
// places (the 30s setInterval, applyActiveMachineChange() on a machine
// switch, and #733's visibilitychange refocus handler) with no ordering
// guarantee between them. Two overlapping calls both read+mutate
// _lastSyncProgress without synchronization -- if a machine's import
// finishes in the gap between two in-flight calls' fetches, both can pass
// the "entry just disappeared" check and double-fire its completion toast.
// A plain in-flight guard turns a same-tick collision into "skip, the other
// call's result already covers this tick" rather than a race -- the
// skipped call's data is never more than one poll interval stale.
let _statusUpdateInFlight = false;

// #464: an explicit machineId scopes the status-dot/hostname fields below to
// that machine (see routes/system.js's /api/status). 'all'/null/undefined
// fall back to the unscoped call (default machine), mirroring the same
// convention views/live.js and views/maintenance.js already use for the
// 'all' switcher value — so single-machine installs and the unparameterized
// 30s poll are unaffected.
export async function updateStatus(machineId) {
  if (_statusUpdateInFlight) return;
  _statusUpdateInFlight = true;
  try {
    const qs = (machineId != null && machineId !== 'all') ? `?machineId=${encodeURIComponent(machineId)}` : '';
    const [statusRes, switchRes] = await Promise.all([
      apiFetch(`api/status${qs}`),
      apiFetch('api/switch').catch(() => null)
    ]);
    if (!statusRes.ok) return;
    const s = await statusRes.json();
    // Update the machine-unreachable banner and onboarding panel first, right after
    // the status response is parsed, so a later exception in this function (e.g. from
    // DOM lookups or JSON parsing further below) can never leave them stuck in a stale
    // state — see #288.
    updateMachineBanner(s);
    updateLegacyMachineOptionsBanner(s);
    updateOnboardingPanel();
    // #750: must run before main.js's shouldOpenSetupWizard() check on the
    // very first status poll after boot -- see syncInstallId()'s own comment.
    syncInstallId(s.installId);
    if (typeof s.shotCount === 'number') {
      if (knownShotCount !== null && s.shotCount > knownShotCount && window.loadData) {
        window.loadData();
      }
      knownShotCount = s.shotCount;
    }
    // #729/#730/#735: shot-import progress bar next to the flap-board shot
    // counter. Preferred path is SSE push (handleSyncProgressEvent/
    // handleSyncCompleteEvent, wired once in main.js's bootstrap,
    // independent of this poll). This polling fallback only runs when SSE
    // hasn't (yet, or ever) taken over for this session -- see
    // public-src/sse.js's fallback detection -- so it doesn't fight the
    // push path over which entry is currently shown.
    if (!S.sseActive) {
      const list = Array.isArray(s.syncProgress) ? s.syncProgress : [];
      pollSyncProgressFallback(list, machineId);
    }
    // Token is no longer returned by /api/status — it comes from /api/token (initToken)
    // #803: exposeApiPort mirrors the add-on option of the same name (default
    // true if the field is somehow missing, e.g. an older server -- matches
    // the option's own default). main.js's renderApiTokenCard() reads this to
    // tell "no token because expose_api_port is off" apart from "no token yet".
    S.apiPortExposed = s.exposeApiPort !== false;
    const dot = document.getElementById('statusDot');
    const railDot = document.getElementById('railStatusDot');
    const timeEl = document.getElementById('syncTime');
    // #681: while the machine is on, show how long it's been on instead of
    // the last shot-sync clock time -- machineOnSince is the same
    // runtime.switchOnAt lib/preheat.js already tracks for its elapsed-time
    // math, reused here rather than adding a second timestamp. Falls back
    // to the previous last-sync display whenever the machine is off (or on
    // a GLP version too old to send these fields, since they're only new
    // additive fields on this response).
    if (s.machineOn && s.machineOnSince) {
      const totalMin = Math.max(0, Math.floor((Date.now() - s.machineOnSince) / 60000));
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      timeEl.textContent = h > 0 ? t('machine_on_duration_hours', h, m) : t('machine_on_duration', m);
    } else if (s.lastSync) {
      timeEl.textContent = new Date(s.lastSync)
        .toLocaleTimeString(localeFor(S.currentLang), { hour: '2-digit', minute: '2-digit' });
    }
    // #655: machineReachable === false is the strongest, most direct signal
    // (the 1s backend poll in lib/poll.js) and must win regardless of
    // lastSync/lastSyncError — those two are only updated by the 5-minute
    // shot sync (lib/sync.js's syncShots()), which short-circuits without
    // touching either field whenever a configured switch entity reports the
    // machine off. Without this, the dot stayed green for days after the
    // machine was switched off. machineReachable === true does NOT force
    // 'ok', though: a sync can still fail for other reasons while the
    // machine itself is reachable, so lastSyncError still applies then.
    const dotClass = s.machineReachable === false ? 'status-dot error'
                    : s.lastSyncError ? 'status-dot error'
                    : (s.lastSync ? 'status-dot ok' : 'status-dot unknown');
    const dotTitle = s.machineReachable === false ? t('machine_unreachable_title') : (s.lastSyncError || '');
    dot.className = dotClass;
    dot.title = dotTitle;
    // #411: the rail footer mirrors the same status dot rather than tracking
    // its own state — no second source of truth for machine reachability.
    // #655: must mirror dotTitle too, not just dotClass — otherwise the rail
    // dot shows the correct error color but a blank tooltip on hover.
    if (railDot) { railDot.className = dotClass; railDot.title = dotTitle; }
    // Skip machineSubtitle while a shot is being viewed (#344): updateView()
    // (views/shots/index.js) owns it in that case, showing the machine that
    // actually owns the viewed shot — this global/default-machine value
    // would otherwise clobber it on the next 30s poll tick regardless of
    // which machine's shot is on screen.
    if (s.machineHostname) {
      if (!S.primaryShotId) {
        const el = document.getElementById('machineSubtitle');
        if (el) el.textContent = s.machineVersion
          ? `${s.machineHostname} · ${s.machineVersion}`
          : s.machineHostname;
      }
      // #447: railMachineName (topbar) is the active/default machine, not
      // the viewed shot's machine — it must always reflect s.machineHostname,
      // unlike machineSubtitle above. Since mobile opens straight into shot
      // detail (#431), S.primaryShotId is almost always set, so bundling this
      // into the same guard left it permanently blank on mobile.
      const railNameEl = document.getElementById('railMachineName');
      if (railNameEl) railNameEl.textContent = s.machineHostname;
    }
    if (s.glpVersion) {
      const vEl = document.getElementById('glpVersionBadge');
      // s.devBuild is only ever present on the dev-channel image (see
      // routes/system.js's /api/status and the Dockerfile's GLP_DEV_BUILD
      // build-arg) -- appending it here is a no-op for every real install.
      if (vEl) vEl.textContent = `v${s.glpVersion}` + (s.devBuild ? ` (${s.devBuild})` : '');
    }
    // #683: same devBuild signal as the version-badge suffix above, but as a
    // persistent top-of-page banner -- much harder to miss than the small
    // badge text alone.
    if (s.devBuild) showDevBuildBanner(s.devBuild);
    // #722: raw-DB export button (Settings) is gated on the exact same
    // devBuild signal as the banner above -- never shown on a real install.
    // The backend route (routes/debug.js) independently 404s regardless of
    // this, so this toggle is UI hygiene, not the safety mechanism.
    const devToolsCard = document.getElementById('devToolsCard');
    if (devToolsCard) devToolsCard.style.display = s.devBuild ? '' : 'none';
    const ordersBtn = document.getElementById('btnOrders');
    if (ordersBtn) ordersBtn.style.display = s.ordersFeature ? '' : 'none';
    // Bottom nav "Mehr" sheet (#403, mobile) mirrors the same feature gate.
    const bnOrders = document.getElementById('bnOrders');
    if (bnOrders) bnOrders.style.display = s.ordersFeature ? '' : 'none';
    if ('isDemo' in s) updateDemoBadge(s.isDemo);
    if (switchRes?.ok) updatePowerButton(await switchRes.json());
    else updatePowerButton({ configured: false });
  } catch { /* ignore */ }
  // eslint-disable-next-line require-atomic-updates -- intentional single-flight guard; last-writer-wins reset is fine, the guard only needs to be false again once no call is in flight
  finally { _statusUpdateInFlight = false; }
}

// #722: the devToolsCard button's click handler -- deliberately goes through
// apiFetch (adds X-GLP-Token) rather than a plain <a href>, since a plain
// anchor navigation wouldn't carry that header for non-Ingress direct-port
// access, only for HA Ingress traffic (which bypasses auth by Supervisor IP,
// see server.js isIngressRequest()). The route itself (routes/debug.js)
// still 404s outright on any real install regardless of how it's called.
export async function exportDevDb() {
  try {
    const r = await apiFetch('api/debug/export-db');
    if (!r.ok) return;
    const blob = await r.blob();
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const filename = `glp-db-export-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
      `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.db`;
    await shareOrDownloadBlob(blob, filename, { title: filename });
  } catch { /* ignore -- dev-only diagnostic tool, no user-facing error UI needed */ }
}

// #755: counterpart to exportDevDb() above -- uploads a raw .db file to
// replace the whole database. Destructive and irreversible from the UI's
// point of view (the backend keeps a timestamped safety-copy on disk, but
// there's no in-app undo), so this confirms before sending, unlike the
// export button. The backend swaps the file via a rename rather than an
// in-place write specifically so the currently-running server keeps serving
// from its already-open handle untouched -- the import only takes effect
// after a manual restart of the add-on, which this tells the user about
// via alert() since there's no toast/notification system wired into this
// dev-only diagnostic card.
export async function importDevDb(file) {
  if (!file) return;
  if (!confirm(t('settings_devtools_import_db_confirm'))) return;
  try {
    const r = await apiFetch('api/debug/import-db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await file.arrayBuffer(),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { alert(body.error || t('settings_devtools_import_db_failed')); return; }
    alert(t('settings_devtools_import_db_done'));
  } catch { alert(t('settings_devtools_import_db_failed')); }
}

export function updatePowerButton(sw) {
  const btn = document.getElementById('powerBtn');
  const liveBtn = document.getElementById('btnLive');
  const bnLive  = document.getElementById('bnLive');
  if (!sw.configured) {
    btn.style.display = 'none';
    S.machinePowerState = null;
    liveBtn.style.display = '';
    liveBtn.disabled = false;
    liveBtn.title = '';
    if (bnLive) bnLive.style.display = '';
    return;
  }
  btn.style.display = '';
  S.machinePowerState = sw.state;
  btn.className = sw.state === true  ? 'machine-on'
                : sw.state === false ? 'machine-off' : '';
  btn.title = sw.state === true  ? 'Maschine AN – zum Ausschalten klicken'
            : sw.state === false ? 'Maschine AUS – zum Einschalten klicken'
            : 'Schalter-Status unbekannt';

  const machineOff = sw.state === false;
  liveBtn.style.display = machineOff ? 'none' : '';
  liveBtn.disabled = false;
  liveBtn.title = '';
  // Bottom nav (#403, mobile) mirrors the same capability gate.
  if (bnLive) bnLive.style.display = machineOff ? 'none' : '';
  if (machineOff && S.currentMode === 'live') {
    if (window.switchMode) window.switchMode('shots');
  }
}

export async function toggleMachinePower() {
  const btn = document.getElementById('powerBtn');
  btn.disabled = true;
  try {
    const r = await apiFetch('api/switch/toggle', { method: 'POST' });
    if (r.ok) {
      const result = await r.json();
      updatePowerButton({ configured: true, state: result.state });
      setTimeout(async () => {
        const sr = await apiFetch('api/switch').catch(() => null);
        if (sr?.ok) updatePowerButton(await sr.json());
      }, 2000);
    }
  } catch (e) { console.error('Power toggle Fehler:', e); }
  finally { btn.disabled = false; }
}

export async function triggerSync() {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = '↻ …';
  try {
    const r = await apiFetch('api/sync', { method: 'POST' });
    if (r.status === 429) {
      const d = await r.json();
      btn.textContent = d.error || t('please_wait');
      setTimeout(() => { btn.textContent = t('btn_sync'); btn.disabled = false; }, 3000);
      return;
    }
    await new Promise(res => setTimeout(res, 2500));
    if (window.loadData) await window.loadData();
    await updateStatus();
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn_sync');
  }
}
