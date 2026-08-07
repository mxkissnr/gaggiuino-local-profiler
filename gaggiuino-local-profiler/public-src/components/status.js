import { S } from '../state.js';
import { t } from '../i18n.js';
import { localeFor } from '../constants.js';
import { apiFetch } from '../api.js';
import { updateMachineBanner, updateOnboardingPanel, updateDemoBadge } from './onboarding.js';
import { showDevBuildBanner } from './dev-banner.js';

// Tracks the server-side shot count as of the last status poll, so the periodic
// poll below can detect a newly-finished shot even when the user isn't on the
// shots view (and thus never got the live.js post-brew loadData() trigger) —
// see #296.
let knownShotCount = null;

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
    updateOnboardingPanel();
    if (typeof s.shotCount === 'number') {
      if (knownShotCount !== null && s.shotCount > knownShotCount && window.loadData) {
        window.loadData();
      }
      knownShotCount = s.shotCount;
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
    if (s.devBuild) showDevBuildBanner();
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
