// Live-data transport Settings card (#598) — WebSocket (default) / MQTT
// toggle, backed by routes/mqtt.js. Broker connection fields are pre-filled
// from Supervisor auto-discovery (GET /api/mqtt/discovery) whenever a saved
// host isn't already set, editable either way for setups where no MQTT
// service is registered (manual entry fallback). The transport radio choice
// is only applied on explicit "Speichern" (not live-toggled) so switching to
// MQTT can't take effect with a still-blank host mid-edit.
import { apiFetch } from '../api.js';
import { t } from '../i18n.js';

let _selectedTransport = 'websocket';
let _discovery = null;

export async function loadMqttSettings() {
  try {
    const [settingsRes, discoveryRes] = await Promise.all([
      apiFetch('api/mqtt/settings'),
      apiFetch('api/mqtt/discovery'),
    ]);
    if (!settingsRes.ok) return;
    const settings = await settingsRes.json();
    _discovery = discoveryRes.ok ? await discoveryRes.json() : { available: false };
    _selectedTransport = settings.transport || 'websocket';

    document.getElementById('mqttHost').value     = settings.host || (_discovery.available ? _discovery.host : '') || '';
    document.getElementById('mqttPort').value      = settings.port || (_discovery.available ? _discovery.port : '') || 1883;
    document.getElementById('mqttUsername').value  = settings.username || (_discovery.available ? _discovery.username : '') || '';
    document.getElementById('mqttPassword').value   = settings.password || (_discovery.available ? _discovery.password : '') || '';
    document.getElementById('mqttPrefix').value    = settings.prefix || 'gaggiuino';

    const hint = document.getElementById('mqttDiscoveryHint');
    if (hint) hint.textContent = _discovery.available ? t('settings_mqtt_discovered') : t('settings_mqtt_not_discovered');

    renderMqttSettingsCard();
  } catch { /* offline/first-run — card just stays at its default state */ }
}

export function renderMqttSettingsCard() {
  document.querySelectorAll('#mqttTransportToggle [data-mqtt-transport]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mqttTransport === _selectedTransport);
  });
  const fields = document.getElementById('mqttConnFields');
  if (fields) fields.style.display = _selectedTransport === 'mqtt' ? '' : 'none';
}

export function setMqttTransport(value) {
  _selectedTransport = value;
  renderMqttSettingsCard();
}

export async function saveMqttSettings() {
  const resultEl = document.getElementById('mqttSettingsResult');
  const payload = {
    transport: _selectedTransport,
    host:      document.getElementById('mqttHost').value.trim(),
    port:      parseInt(document.getElementById('mqttPort').value, 10) || 1883,
    username:  document.getElementById('mqttUsername').value.trim(),
    password:  document.getElementById('mqttPassword').value,
    prefix:    document.getElementById('mqttPrefix').value.trim() || 'gaggiuino',
  };
  if (payload.transport === 'mqtt' && !payload.host) {
    if (resultEl) resultEl.textContent = t('settings_mqtt_host_required');
    return;
  }
  try {
    const r = await apiFetch('api/mqtt/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (r.ok) { if (resultEl) resultEl.textContent = t('settings_mqtt_saved'); return; }
    const data = await r.json().catch(() => ({}));
    if (resultEl) resultEl.textContent = t('settings_mqtt_save_error', data.error || r.status);
  } catch {
    if (resultEl) resultEl.textContent = t('settings_mqtt_save_error', '');
  }
}

export async function applyMqttToMachine() {
  const resultEl = document.getElementById('mqttSettingsResult');
  if (resultEl) resultEl.textContent = t('settings_mqtt_applying');
  try {
    const r = await apiFetch('api/mqtt/apply-to-machine', { method: 'POST' });
    if (r.ok) { if (resultEl) resultEl.textContent = t('settings_mqtt_applied'); return; }
    const data = await r.json().catch(() => ({}));
    if (resultEl) resultEl.textContent = t('settings_mqtt_apply_error', data.error || r.status);
  } catch {
    if (resultEl) resultEl.textContent = t('settings_mqtt_apply_error', '');
  }
}
