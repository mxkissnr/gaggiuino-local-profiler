import { S } from '../state.js';
import { t } from '../i18n.js';
import { LOCALE_MAP } from '../constants.js';
import { apiFetch } from '../api.js';

export async function updateStatus() {
  try {
    const [statusRes, switchRes] = await Promise.all([
      apiFetch('api/status'),
      apiFetch('api/switch').catch(() => null)
    ]);
    if (!statusRes.ok) return;
    const s = await statusRes.json();
    if (s.apiToken && s.apiToken !== S.glpToken) {
      S.glpToken = s.apiToken;
      localStorage.setItem('glp_token', S.glpToken);
    }
    const dot = document.getElementById('statusDot');
    const timeEl = document.getElementById('syncTime');
    if (s.lastSync) {
      timeEl.textContent = new Date(s.lastSync)
        .toLocaleTimeString(LOCALE_MAP[S.currentLang] || 'de-DE', { hour: '2-digit', minute: '2-digit' });
    }
    dot.className = s.lastSyncError ? 'status-dot error' : (s.lastSync ? 'status-dot ok' : 'status-dot unknown');
    dot.title = s.lastSyncError || '';
    if (s.machineHostname) {
      const el = document.getElementById('machineSubtitle');
      if (el) el.textContent = s.machineVersion
        ? `${s.machineHostname} · ${s.machineVersion}`
        : s.machineHostname;
    }
    if (s.glpVersion) {
      const vEl = document.getElementById('glpVersionBadge');
      if (vEl) vEl.textContent = `v${s.glpVersion}`;
    }
    const ordersBtn = document.getElementById('btnOrders');
    if (ordersBtn) ordersBtn.style.display = s.ordersFeature ? '' : 'none';
    if (switchRes?.ok) updatePowerButton(await switchRes.json());
    else updatePowerButton({ configured: false });
  } catch (e) {}
}

export function updatePowerButton(sw) {
  const btn = document.getElementById('powerBtn');
  const liveBtn = document.getElementById('btnLive');
  if (!sw.configured) {
    btn.style.display = 'none';
    S.machinePowerState = null;
    liveBtn.style.display = '';
    liveBtn.disabled = false;
    liveBtn.title = '';
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
      btn.textContent = d.error || 'Warten …';
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
