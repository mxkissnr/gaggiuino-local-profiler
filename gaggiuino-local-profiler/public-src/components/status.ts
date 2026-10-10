import { S } from '../state/index.js';
import { t } from '../i18n.js';
import { localeFor } from '../constants.js';
import {
  getStatus, getSwitch, toggleSwitch,
  triggerSync as triggerSyncRequest,
  exportDevDb as exportDevDbRequest,
  importDevDb as importDevDbRequest,
} from '../api/system.js';
import { shareOrDownloadBlob, syncInstallId } from '../utils.js';
import { noteServerRevs } from '../live-sync.js';
import { updateMachineBanner, updateOnboardingPanel, updateDemoBadge, updateLegacyMachineOptionsBanner } from './onboarding.js';
import { updateApiPortClosedBanner } from './api-port-notice.js';
import { showDevBuildBanner } from './dev-banner.js';
import { syncTopbarMachineIconFallback } from './topbar-machine-icon.js';

// /api/status and /api/switch responses are plain fetch Responses, so their
// parsed bodies are named here rather than left as `any`.
interface ProgressButton { textContent: string | null; disabled: boolean }
interface SwitchPayload { configured?: boolean | undefined; state?: boolean | null | undefined }

// One entry of /api/status's machines[] array (#317) — only the fields the
// topbar display-name logic reads.
interface StatusMachineEntry {
  id?: number;
  name?: string;
  isDefault?: boolean;
  firmwareName?: string | null;
}

// Shape of the /api/status body this module reads (Response.json() is `any`,
// so naming it here keeps the untyped boundary in one place).
interface StatusPayload {
  installId?: string | null;
  shotCount?: number;
  exposeApiPort?: boolean;
  machineOn?: boolean;
  machineOnSince?: number | null;
  lastSync?: string | number | null;
  lastSyncError?: string | null;
  machineReachable?: boolean | null;
  machineHostname?: string | null;
  machineVersion?: string | null;
  machines?: StatusMachineEntry[];
  glpVersion?: string | null;
  devBuild?: string | null;
  ordersFeature?: boolean;
  isDemo?: boolean;
  legacyMachineOptionsPending?: boolean;
  // #1539 slice 2/3: the SSE data-change tracker's epoch and per-kind
  // revisions, so a reconnecting client can tell which kinds it missed.
  dataEpoch?: string;
  dataRevs?: Record<string, number>;
}

// Tracks the server-side shot count as of the last status poll, so the periodic
// poll below can detect a newly-finished shot even when the user isn't on the
// shots view (and thus never got the live.js post-brew loadData() trigger) —
// see #296.
let knownShotCount: number | null = null;

// #734 review: updateStatus() can be triggered from three independent places
// (the 30s setInterval, applyActiveMachineChange() on a machine switch, and
// #733's visibilitychange refocus handler) with no ordering guarantee between
// them, so a plain in-flight guard keeps overlapping calls from each running
// a redundant fetch+render in the same tick.
let _statusUpdateInFlight = false;

// #464: an explicit machineId scopes the status-dot/hostname fields below to
// that machine (see go/internal/system's /api/status). 'all'/null/undefined
// fall back to the unscoped call (default machine), mirroring the same
// convention views/live.js and views/maintenance.js already use for the
// 'all' switcher value — so single-machine installs and the unparameterized
// 30s poll are unaffected.
export async function updateStatus(machineId?: string | number | null): Promise<void> {
  if (_statusUpdateInFlight) return;
  _statusUpdateInFlight = true;
  try {
    const [statusRes, switchRes] = await Promise.all([
      getStatus(machineId),
      getSwitch().catch(() => null)
    ]);
    if (!statusRes.ok) return;
    const s = await statusRes.json() as StatusPayload;
    // Update the machine-unreachable banner and onboarding panel first, right after
    // the status response is parsed, so a later exception in this function (e.g. from
    // DOM lookups or JSON parsing further below) can never leave them stuck in a stale
    // state — see #288.
    updateMachineBanner(s);
    updateLegacyMachineOptionsBanner(s);
    updateOnboardingPanel();
    // #1539 slice 3: feed the server's data-change epoch/revisions to the
    // live-sync tracker, so a reconnect (or a missed SSE event) shows up as a
    // refetch on the next poll.
    if (s.dataEpoch != null && s.dataRevs != null) noteServerRevs(s.dataEpoch, s.dataRevs);
    // #750: must run before main.js's shouldOpenSetupWizard() check on the
    // very first status poll after boot -- see syncInstallId()'s own comment.
    syncInstallId(s.installId);
    if (typeof s.shotCount === 'number') {
      if (knownShotCount !== null && s.shotCount > knownShotCount && window.loadData) {
        void window.loadData();
      }
      knownShotCount = s.shotCount;
    }
    // Token is no longer returned by /api/status — it comes from /api/token (initToken)
    // #803: exposeApiPort mirrors the add-on option of the same name (default
    // true if the field is somehow missing, e.g. an older server -- matches
    // the option's own default). main.js's renderApiTokenCard() reads this to
    // tell "no token because expose_api_port is off" apart from "no token yet".
    S.apiPortExposed = s.exposeApiPort !== false;
    // #807: the app-wide banner for that state -- re-evaluated on every poll
    // (it removes itself again if the option is turned back on and a token
    // arrives), same always-run/self-correct convention as the banners above.
    updateApiPortClosedBanner();
    const dot = document.getElementById('statusDot') as HTMLElement;
    const railDot = document.getElementById('railStatusDot');
    const timeEl = document.getElementById('syncTime') as HTMLElement;
    // #681: while the machine is on, show how long it's been on instead of
    // the last shot-sync clock time -- machineOnSince is the same
    // runtime.switchOnAt the backend already tracks for its elapsed-time
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
    // (the 1s backend poll) and must win regardless of
    // lastSync/lastSyncError — those two are only updated by the 5-minute
    // shot sync, which short-circuits without
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
    // #837: the topbar's ambient machine icon mirrors the same reachability
    // signal as its SSE-less fallback — a no-op whenever SSE is already
    // driving it with richer detail (see syncTopbarMachineIconFallback()).
    syncTopbarMachineIconFallback(s.machineReachable);
    // Skip machineSubtitle while a shot is being viewed (#344): updateView()
    // (views/shots/index.js) owns it in that case, showing the machine that
    // actually owns the viewed shot — this global/default-machine value
    // would otherwise clobber it on the next 30s poll tick regardless of
    // which machine's shot is on screen.
    //
    // #1454: the display name prefers the name the machine reports in its own
    // firmware settings, then the name configured in GLP, and only falls back
    // to the hostname. The machines[] entries (unlike machineHostname) need no
    // auth token, so a name still renders on an unauthenticated response.
    const machineEntries = s.machines ?? [];
    const displayNameFor = (targetId?: string | number | null): string | null => {
      const wanted = targetId != null && targetId !== 'all' ? String(targetId) : null;
      const scoped = wanted ? machineEntries.find(m => String(m.id) === wanted) : undefined;
      const entry = scoped ?? machineEntries.find(m => m.isDefault);
      if (entry) {
        const name = entry.firmwareName || entry.name;
        if (name) return name;
      }
      return s.machineHostname ?? null;
    };
    const subtitleName = displayNameFor(machineId);
    if (subtitleName && !S.primaryShotId) {
      const el = document.getElementById('machineSubtitle');
      if (el) el.textContent = s.machineVersion
        ? `${subtitleName} · ${s.machineVersion}`
        : subtitleName;
    }
    // #447: railMachineName (topbar) is the active/default machine, not
    // the viewed shot's machine — it must always reflect the default machine,
    // unlike machineSubtitle above. Since mobile opens straight into shot
    // detail (#431), S.primaryShotId is almost always set, so bundling this
    // into the same guard left it permanently blank on mobile.
    const railName = displayNameFor(null);
    const railNameEl = document.getElementById('railMachineName');
    if (railNameEl && railName) railNameEl.textContent = railName;
    if (s.glpVersion) {
      const vEl = document.getElementById('glpVersionBadge');
      // s.devBuild is only ever present on the dev-channel image (see
      // go/internal/system's /api/status and the Dockerfile's GLP_DEV_BUILD
      // build-arg) -- appending it here is a no-op for every real install.
      if (vEl) vEl.textContent = `v${s.glpVersion}` + (s.devBuild ? ` (${s.devBuild})` : '');
    }
    // #683: same devBuild signal as the version-badge suffix above, but as a
    // persistent top-of-page banner -- much harder to miss than the small
    // badge text alone.
    if (s.devBuild) showDevBuildBanner(s.devBuild);
    // #722: raw-DB export button (Settings) is gated on the exact same
    // devBuild signal as the banner above -- never shown on a real install.
    // The backend route (go/internal/debug) independently 404s regardless of
    // this, so this toggle is UI hygiene, not the safety mechanism.
    const devToolsCard = document.getElementById('devToolsCard');
    if (devToolsCard) devToolsCard.style.display = s.devBuild ? '' : 'none';
    const ordersBtn = document.getElementById('btnOrders');
    if (ordersBtn) ordersBtn.style.display = s.ordersFeature ? '' : 'none';
    // Bottom nav "Mehr" sheet (#403, mobile) mirrors the same feature gate.
    const bnOrders = document.getElementById('bnOrders');
    if (bnOrders) bnOrders.style.display = s.ordersFeature ? '' : 'none';
    if ('isDemo' in s) updateDemoBadge(s.isDemo);
    if (switchRes?.ok) updatePowerButton(await switchRes.json() as SwitchPayload);
    else updatePowerButton({ configured: false });
  } catch { /* ignore */ }
  // Single-flight guard (#734): the reset below runs on every path, and last-writer-wins is fine -- the guard only needs to be false again once no call is in flight.
  finally { _statusUpdateInFlight = false; }
}

// #722: the devToolsCard button's click handler -- deliberately goes through
// apiFetch (adds X-GLP-Token) rather than a plain <a href>, since a plain
// anchor navigation wouldn't carry that header for non-Ingress direct-port
// access, only for HA Ingress traffic (which bypasses auth by Supervisor IP,
// see the backend's ingress-trust check (go/internal/auth)). The route itself (go/internal/debug)
// still 404s outright on any real install regardless of how it's called.
// #960: the Dev Tools card has no room for a progress bar, so the transfer
// state shows as the button's own label ("Downloading… 42%") while the
// button is disabled — the minimal idiomatic choice for a dev-only card.
// Restores the button's text/disabled state on every exit.
function withButtonProgress<T>(btn: ProgressButton, work: (setLabel: (text: string) => void) => Promise<T>): Promise<T> {
  const prevText = btn.textContent;
  const prevDisabled = btn.disabled;
  btn.disabled = true;
  const restore = () => { btn.textContent = prevText; btn.disabled = prevDisabled; };
  // Promise chain rather than async/await + finally so the snapshot restore
  // isn't flagged by require-atomic-updates (nothing else writes this
  // button while it's disabled anyway).
  return Promise.resolve(work((text) => { btn.textContent = text; }))
    .then((v) => { restore(); return v; }, (err) => { restore(); throw err; });
}

export async function exportDevDb(): Promise<void> {
  const btn = (document.getElementById('devExportDbBtn') || { textContent: '', disabled: false }) as ProgressButton;
  try {
    await withButtonProgress(btn, async (setLabel) => {
      const res = await exportDevDbRequest((received, total) => setLabel(total
        ? t('backup_progress_download', Math.floor((received / total) * 100))
        : t('backup_progress_preparing')));
      if (!res.ok) {
        if (window.showToast) window.showToast(t('settings_devtools_export_db_failed'));
        return;
      }
      const d = new Date();
      const pad = (n: number): string => String(n).padStart(2, '0');
      const filename = `glp-db-export-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
        `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.db`;
      await shareOrDownloadBlob(res.blob, filename, { title: filename });
      if (window.showToast) window.showToast(t('backup_progress_done'));
    });
  } catch {
    if (window.showToast) window.showToast(t('settings_devtools_export_db_failed'));
  }
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
export async function importDevDb(file: File): Promise<void> {
  if (!file) return;
  if (!confirm(t('settings_devtools_import_db_confirm'))) return;
  const input = document.getElementById('devImportDbInput') as HTMLInputElement | null;
  const label = (document.querySelector('#devToolsCard label span[data-i18n="settings_devtools_import_db"]')
    || { textContent: '', disabled: false }) as ProgressButton;
  if (input) input.disabled = true;
  try {
    await withButtonProgress(label, async (setLabel) => {
      const res = await importDevDbRequest(await file.arrayBuffer(), (sent, total) => setLabel(sent >= total
        ? t('backup_progress_restoring')
        : t('backup_progress_upload', Math.floor((sent / total) * 100))));
      let body: { error?: string } = {};
      try { body = JSON.parse(res.text || '{}') as { error?: string }; } catch { /* non-JSON body */ }
      if (!res.ok) { alert(body.error || t('settings_devtools_import_db_failed')); return; }
      alert(t('settings_devtools_import_db_done'));
    });
  } catch {
    alert(t('settings_devtools_import_db_failed'));
  } finally {
    if (input) input.disabled = false;
  }
}

export function updatePowerButton(sw: SwitchPayload): void {
  const btn = document.getElementById('powerBtn') as HTMLButtonElement;
  // #914: mobile topbar duplicate of #powerBtn -- see index.html comment.
  const railBtn = document.getElementById('railPowerBtn') as HTMLButtonElement | null;
  const liveBtn = document.getElementById('btnLive') as HTMLButtonElement;
  const bnLive  = document.getElementById('bnLive');
  if (!sw.configured) {
    btn.style.display = 'none';
    if (railBtn) railBtn.style.display = 'none';
    S.machinePowerState = null;
    liveBtn.style.display = '';
    liveBtn.disabled = false;
    liveBtn.title = '';
    if (bnLive) bnLive.style.display = '';
    return;
  }
  btn.style.display = '';
  if (railBtn) railBtn.style.display = '';
  S.machinePowerState = sw.state ?? null;
  btn.className = sw.state === true  ? 'machine-on'
                : sw.state === false ? 'machine-off' : '';
  btn.title = sw.state === true  ? 'Maschine AN – zum Ausschalten klicken'
            : sw.state === false ? 'Maschine AUS – zum Einschalten klicken'
            : 'Schalter-Status unbekannt';
  if (railBtn) { railBtn.className = btn.className; railBtn.title = btn.title; }

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

export async function toggleMachinePower(): Promise<void> {
  const btn = document.getElementById('powerBtn') as HTMLButtonElement;
  // #914: mobile topbar duplicate of #powerBtn -- kept disabled in lockstep
  // so a tap on either surface can't double-fire the toggle.
  const railBtn = document.getElementById('railPowerBtn') as HTMLButtonElement | null;
  btn.disabled = true;
  if (railBtn) railBtn.disabled = true;
  try {
    const r = await toggleSwitch();
    if (r.ok) {
      const result = await r.json() as SwitchPayload;
      updatePowerButton({ configured: true, state: result.state });
      setTimeout(() => { void (async () => {
        const sr = await getSwitch().catch(() => null);
        if (sr?.ok) updatePowerButton(await sr.json() as SwitchPayload);
      })(); }, 2000);
    }
  } catch (e) { console.error('Power toggle Fehler:', e); }
  finally {
    btn.disabled = false;
    if (railBtn) railBtn.disabled = false;
  }
}

export async function triggerSync(): Promise<void> {
  const btn = document.getElementById('syncBtn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = '↻ …';
  try {
    const r = await triggerSyncRequest();
    if (r.status === 429) {
      const d = await r.json() as { error?: string };
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
