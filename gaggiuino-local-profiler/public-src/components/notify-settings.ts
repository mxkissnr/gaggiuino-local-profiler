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
import { getOrdersSettings, postOrdersSettings } from '../api/orders.js';
import type { OrdersSettings, OrdersSettingsUpdate } from '../api/types.js';
import { t } from '../i18n.js';
import { CHECK_ICON_SVG } from '../icons.js';

// The boolean toggles this card owns (the remaining order-specific ones live
// in views/orders.js's saveNotifyToggles()).
type NotifyKey =
  | 'notify_preheat_ready'
  | 'notify_low_stock'
  | 'notify_shop_state'
  | 'notify_new_order'
  | 'notify_order_status';

const KEYS: NotifyKey[] = ['notify_preheat_ready', 'notify_low_stock'];

export async function loadNotifySettingsCard(): Promise<void> {
  const list = document.getElementById('notifySettingsList');
  if (!list) return;
  const settings: OrdersSettings = await getOrdersSettings().catch(() => ({}));
  KEYS.forEach(key => {
    const cb = list.querySelector<HTMLInputElement>(`[data-notify-key="${key}"]`);
    if (cb) cb.checked = settings[key] !== false;
  });
}

export async function saveNotifySettings(): Promise<void> {
  const list = document.getElementById('notifySettingsList');
  if (!list) return;
  const settings: OrdersSettings = await getOrdersSettings().catch(() => ({}));
  const body: OrdersSettingsUpdate = { ...settings, enabled: settings.enabled ?? true };
  list.querySelectorAll<HTMLInputElement>('[data-notify-key]').forEach(cb => {
    const key = cb.dataset.notifyKey as NotifyKey;
    body[key] = cb.checked;
  });
  await postOrdersSettings(body);
  const btn = document.getElementById('notifySettingsSaveBtn');
  if (btn) {
    btn.innerHTML = `${CHECK_ICON_SVG} ${t('orders_types_saved')}`;
    setTimeout(() => { btn.textContent = t('orders_types_save'); }, 2000);
  }
}
