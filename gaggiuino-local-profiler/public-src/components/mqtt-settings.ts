// Live-data transport Settings card (#598) — WebSocket (default) / MQTT
// toggle, backed by go/internal/mqtt. Broker connection fields are pre-filled
// from Supervisor auto-discovery (GET /api/mqtt/discovery) whenever a saved
// host isn't already set, editable either way for setups where no MQTT
// service is registered (manual entry fallback). The transport radio choice
// is only applied on explicit "Speichern" (not live-toggled) so switching to
// MQTT can't take effect with a still-blank host mid-edit.
import {
  getMqttSettings, getMqttDiscovery,
  saveMqttSettings as saveMqttSettingsRequest,
  applyMqttToMachine as applyMqttToMachineRequest,
} from '../api/mqtt.js';
import { t, tHtml } from '../i18n.js';
import { html } from '../utils.js';
import { CHECK_ICON_SVG } from '../icons.js';
import { S } from '../state/index.js';
import type { MqttSettings, MqttSettingsInput } from '../api/types.js';

interface MqttDiscovery {
  available?: boolean;
  host?: string;
  port?: number;
  username?: string;
  hasPassword?: boolean;
}

let _selectedTransport: MqttSettings['transport'] = 'websocket';
let _discovery: MqttDiscovery = {};
// #1050/#1062: GET /api/mqtt/settings no longer echoes the stored broker
// password back (it reports `hasPassword` instead), so the form cannot
// pre-fill the field. This tracks whether one is stored, so
// saveMqttSettings() can tell "the user left it alone" (omit the key ->
// backend keeps the stored value) apart from "there was never one" (send
// the empty string), and so the "Remove password" toggle only shows up
// when there is something to remove.
let _hasStoredPassword = false;

export async function loadMqttSettings(): Promise<void> {
  try {
    const [settingsRes, discoveryRes] = await Promise.all([
      getMqttSettings(),
      getMqttDiscovery(),
    ]);
    if (!settingsRes.ok) return;
    const settings = await settingsRes.json() as MqttSettings;
    _discovery = discoveryRes.ok ? await discoveryRes.json() as MqttDiscovery : { available: false };
    _selectedTransport = settings.transport || 'websocket';

    (document.getElementById('mqttHost') as HTMLInputElement).value     = settings.host || (_discovery.available ? _discovery.host : '') || '';
    (document.getElementById('mqttPort') as HTMLInputElement).value      = String(settings.port || (_discovery.available ? _discovery.port : '') || 1883);
    (document.getElementById('mqttUsername') as HTMLInputElement).value  = settings.username || (_discovery.available ? _discovery.username : '') || '';
    _hasStoredPassword = !!settings.hasPassword;
    // #1431: neither the stored password nor the Supervisor-discovered one is
    // ever sent to the client, so the field is never pre-filled; the placeholder
    // tells the user a discovered password will be reused if they leave it blank.
    const pwEl = document.getElementById('mqttPassword') as HTMLInputElement;
    pwEl.value = '';
    pwEl.placeholder = _hasStoredPassword
      ? t('settings_mqtt_password_stored')
      : (_discovery.available && _discovery.hasPassword ? t('settings_mqtt_password_discovered') : '');
    const removeRow = document.getElementById('mqttPasswordRemoveRow');
    if (removeRow) removeRow.style.display = _hasStoredPassword ? '' : 'none';
    const removeCb = document.getElementById('mqttPasswordRemove') as HTMLInputElement | null;
    if (removeCb) removeCb.checked = false;
    (document.getElementById('mqttPrefix') as HTMLInputElement).value    = settings.prefix || 'gaggiuino';

    const hint = document.getElementById('mqttDiscoveryHint');
    if (hint) hint.innerHTML = _discovery.available ? html`${CHECK_ICON_SVG} ${tHtml('settings_mqtt_discovered')}` : tHtml('settings_mqtt_not_discovered');

    renderMqttSettingsCard();
  } catch { /* offline/first-run — card just stays at its default state */ }
}

export function renderMqttSettingsCard(): void {
  const defaultMachine = (S.machines || []).find(m => m.isDefault) || (S.machines || [])[0];
  const isGaggiMate = defaultMachine?.type === 'gaggimate';
  const card = document.getElementById('mqttSettingsCard');
  if (card) card.style.display = isGaggiMate ? 'none' : '';

  document.querySelectorAll<HTMLElement>('#mqttTransportToggle [data-mqtt-transport]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mqttTransport === _selectedTransport);
  });
  const fields = document.getElementById('mqttConnFields');
  if (fields) fields.style.display = _selectedTransport === 'mqtt' ? '' : 'none';
}

export function setMqttTransport(value: string): void {
  _selectedTransport = value as MqttSettings['transport'];
  renderMqttSettingsCard();
}

export async function saveMqttSettings(): Promise<void> {
  const resultEl = document.getElementById('mqttSettingsResult');
  const payload: MqttSettingsInput = {
    transport: _selectedTransport,
    host:      (document.getElementById('mqttHost') as HTMLInputElement).value.trim(),
    port:      parseInt((document.getElementById('mqttPort') as HTMLInputElement).value, 10) || 1883,
    username:  (document.getElementById('mqttUsername') as HTMLInputElement).value.trim(),
    prefix:    (document.getElementById('mqttPrefix') as HTMLInputElement).value.trim() || 'gaggiuino',
  };
  const removeCb = document.getElementById('mqttPasswordRemove') as HTMLInputElement | null;
  if (removeCb && removeCb.checked) {
    // #1062: explicit removal, independent of whatever's left in the field.
    payload.clearPassword = true;
  } else {
    const pw = (document.getElementById('mqttPassword') as HTMLInputElement).value;
    if (pw !== '') {
      payload.password = pw;
    } else if (_hasStoredPassword) {
      // #1050: an empty field while a password is stored means "unchanged" —
      // omitting the key tells the backend to keep it. Sending "" would wipe it.
    } else if (_discovery.available && _discovery.hasPassword) {
      // #1431: the discovered password is never sent to the client, so the
      // opt-in flag is the only way to reuse it.
      payload.useDiscoveredPassword = true;
    } else {
      payload.password = '';
    }
  }
  if (payload.transport === 'mqtt' && !payload.host) {
    if (resultEl) resultEl.textContent = t('settings_mqtt_host_required');
    return;
  }
  try {
    const r = await saveMqttSettingsRequest(payload);
    if (r.ok) { if (resultEl) resultEl.innerHTML = html`${CHECK_ICON_SVG} ${tHtml('settings_mqtt_saved')}`; return; }
    const data = await r.json().catch(() => ({})) as { error?: string };
    if (resultEl) resultEl.textContent = t('settings_mqtt_save_error', data.error || r.status);
  } catch {
    if (resultEl) resultEl.textContent = t('settings_mqtt_save_error', '');
  }
}

export async function applyMqttToMachine(): Promise<void> {
  const resultEl = document.getElementById('mqttSettingsResult');
  if (resultEl) resultEl.textContent = t('settings_mqtt_applying');
  try {
    const r = await applyMqttToMachineRequest();
    if (r.ok) { if (resultEl) resultEl.innerHTML = html`${CHECK_ICON_SVG} ${tHtml('settings_mqtt_applied')}`; return; }
    const data = await r.json().catch(() => ({})) as { error?: string };
    if (resultEl) resultEl.textContent = t('settings_mqtt_apply_error', data.error || r.status);
  } catch {
    if (resultEl) resultEl.textContent = t('settings_mqtt_apply_error', '');
  }
}
