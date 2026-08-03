// Machine/library notification toggles — Settings page card (#614).
// notify_preheat_ready (lib/preheat.js) and notify_low_stock
// (lib/services/LibraryService.js) fire regardless of enable_orders, but
// #603 originally placed their toggles inside the Orders admin panel's
// "Benachrichtigungstypen" section, which only renders when Orders is
// enabled — users without Orders had no way to reach them. This card is
// always visible and reads/writes the same /api/orders/settings blob as
// views/orders.js's saveNotifyToggles() for the remaining 3 order-specific
// toggles; that route isn't gated on enable_orders, only the Orders nav
// tab/panel is. Loaded once at app init (main.js), same as mqtt-settings.js,
// so it doesn't depend on views/orders.js's code ever having run.
import { apiFetch } from '../api.js';
import { t } from '../i18n.js';

const KEYS = ['notify_preheat_ready', 'notify_low_stock'];

export async function loadNotifySettingsCard() {
  const list = document.getElementById('notifySettingsList');
  if (!list) return;
  const settings = await apiFetch('api/orders/settings').then(r => r.json()).catch(() => ({}));
  KEYS.forEach(key => {
    const cb = list.querySelector(`[data-notify-key="${key}"]`);
    if (cb) cb.checked = settings[key] !== false;
  });
}

export async function saveNotifySettings() {
  const list = document.getElementById('notifySettingsList');
  if (!list) return;
  const settings = await apiFetch('api/orders/settings').then(r => r.json()).catch(() => ({}));
  const body = { enabled: settings.enabled ?? true };
  list.querySelectorAll('[data-notify-key]').forEach(cb => {
    body[cb.dataset.notifyKey] = cb.checked;
  });
  await apiFetch('api/orders/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const btn = document.getElementById('notifySettingsSaveBtn');
  if (btn) {
    btn.textContent = t('orders_types_saved');
    setTimeout(() => { btn.textContent = t('orders_types_save'); }, 2000);
  }
}
