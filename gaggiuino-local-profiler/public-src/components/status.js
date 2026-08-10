import { S } from '../state.js';
import { t } from '../i18n.js';
import { localeFor } from '../constants.js';
import { apiFetch } from '../api.js';
import { shareOrDownloadBlob } from '../utils.js';
import { updateMachineBanner, updateOnboardingPanel, updateDemoBadge, updateLegacyMachineOptionsBanner } from './onboarding.js';
import { showDevBuildBanner } from './dev-banner.js';

// Tracks the server-side shot count as of the last status poll, so the periodic
// poll below can detect a newly-finished shot even when the user isn't on the
// shots view (and thus never got the live.js post-brew loadData() trigger) —
// see #296.
let knownShotCount = null;

// #731: active shot-import progress entries (see the syncProgress block in
// updateStatus() below), keyed by machineId -- kept only so the poll that
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
// session opened).
let _lastSyncProgress = new Map();

// #464: an explicit machineId scopes the status-dot/hostname fields below to
// that machine (see routes/system.js's /api/status). 'all'/null/undefined
// fall back to the unscoped call (default machine), mirroring the same
// convention views/live.js and views/maintenance.js already use for the
// 'all' switcher value — so single-machine installs and the unparameterized
// 30s poll are unaffected.
export async function updateStatus(machineId) {
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
    if (typeof s.shotCount === 'number') {
      if (knownShotCount !== null && s.shotCount > knownShotCount && window.loadData) {
        window.loadData();
      }
      knownShotCount = s.shotCount;
    }
    // #729/#730: shot-import progress bar next to the flap-board shot
    // counter -- only present in the response while at least one backfill
    // is actively tracking progress (see lib/state.js's syncProgress),
    // hidden the rest of the time. Rides the existing 30s updateStatus()
    // poll, no separate interval. s.syncProgress is a list -- more than one
    // machine can be backfilling at once, see _lastSyncProgress's comment.
    const syncProgressBar = document.getElementById('syncProgressBar');
    if (syncProgressBar) {
      const list = Array.isArray(s.syncProgress) ? s.syncProgress : [];
      // #731: toast every previously-tracked machine whose entry is gone
      // from this poll's list -- independent of whichever single entry the
      // bar itself ends up showing below, so machine B finishing while A is
      // still backfilling still gets its own toast right away, not only
      // once A also finishes (or never, if A finished first and B's entry
      // never got picked as "the" entry to track).
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
      if (entry) {
        const { current, total } = entry;
        const label = document.getElementById('syncProgressLabel');
        const fill  = syncProgressBar.querySelector('.sync-progress-fill');
        if (label) label.textContent = t('sync_progress_label', current, total);
        if (fill) fill.style.width = `${Math.min(100, (current / total) * 100)}%`;
        syncProgressBar.style.display = '';
      } else {
        syncProgressBar.style.display = 'none';
      }
    }
    // Token is no longer returned by /api/status — it comes from /api/token (initToken)
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
