import { S } from '../state/index.js';
import * as timerRegistry from '../state/timers.js';
import { t, tHtml } from '../i18n.js';
import { getSwitch } from '../api/system.js';
import {
  getOrdersSettings, postOrdersSettings, listOrders, getOrdersMenu, getQueueEta, getMilkStock,
  getOrdersStats, postOrderAccept, postOrderDecline, postOrderComplete, deleteOrderById,
  deleteOrderHistory, putMenuItem, deleteMenuItem, postOrdersMenu, getNotifyServices,
  getNotifyMapping, postNotifyMapping,
} from '../api/orders.js';
import type {
  MenuItem, MilkStock, NotifyMappingView, NotifyService, Order, OrderStats,
  OrdersSettings, OrdersSettingsUpdate, QueueEta,
} from '../api/types.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { localeFor } from '../constants.js';
// #416: stroke-SVG replacements for the 🫘/🥛 decorative glyphs (same
// .rail-icon treatment as the 🔥 trend toggle, #415). Used both in the
// use-beans/use-milks toggle buttons and their inline notes below.
// BEAN_ICON_SVG now lives in ../icons.js (also used by main.js's bean-age
// hint, #419 follow-up); MILK_ICON_SVG moved there too once the library
// and annotation milk pickers reused it as their no-emoji fallback (#1328).
import { CLOCK_ICON_SVG, BELL_ICON_SVG, BEAN_ICON_SVG, MILK_ICON_SVG, CLOSE_ICON_SVG, CHECK_ICON_SVG } from '../icons.js';

// Two orders-runtime fields that state/index.ts's OrdersSlice does not
// declare: they are written and read only by this view, so they get a local
// view of S rather than widening the shared state slice.
type OrdersRuntimeState = typeof S & {
  _knownPendingIds?: Set<string> | null;
  _ordersQueueEta?: QueueEta | null;
};
const SO = S as OrdersRuntimeState;

// Hand-built view of GET /api/switch as loadOrdersView reads it.
interface SwitchState { configured?: boolean; state?: boolean }

// S._ordersEtaSelected / S._ordersDeclineOpen are keyed by the order id that
// arrives as a dataset string — keep the runtime key a string and type the
// lookup accordingly (object keys are strings at runtime either way).
const _idKey = (id: string | undefined): string => id as string;

// addEventListener's handler is typed void-returning; async click/change work
// goes through this helper, which makes the fire-and-forget explicit.
function _onAsync(el: Element | null | undefined, type: string, fn: () => Promise<void>): void {
  el?.addEventListener(type, () => { void fn(); });
}

// #603: one mute switch per automatic notification type. Stored as
// settings[key] === false (absent/true both mean "on") so pre-#603 installs
// keep sending every notification they already were.
// #614: notify_preheat_ready/notify_low_stock moved to the always-visible
// Settings page card (components/notify-settings.js) — they fire regardless
// of enable_orders, so this
// panel (which only exists when Orders is enabled) is the wrong home for
// them. Only the genuinely Orders-only types stay here.
const NOTIFY_TYPE_KEYS = [
  { key: 'notify_shop_state',    i18nKey: 'orders_type_shop_state' },
  { key: 'notify_new_order',     i18nKey: 'orders_type_new_order' },
  { key: 'notify_order_status',  i18nKey: 'orders_type_order_status' },
] as const;

// Typed "value or fallback" wrappers: the API helpers already fall back to
// empty values at each call site, but a bare .catch(() => ({})) widens the
// Promise.all result to {} and needs a cast to read again — these keep the
// fallback explicit and the result typed.
async function _getSwitchState(): Promise<SwitchState> {
  try {
    const raw: unknown = await getSwitch().then(r => r.json());
    return raw as SwitchState;
  } catch { return {}; }
}

async function _getSettingsOr(fallback: OrdersSettings): Promise<OrdersSettings> {
  try { return await getOrdersSettings(); } catch { return fallback; }
}

async function _getNotifyMappingOrEmpty(): Promise<NotifyMappingView> {
  try { return await getNotifyMapping(); } catch { return { mapping: {}, customers: {} }; }
}

async function _getNotifyServicesOrNull(): Promise<NotifyService[] | null> {
  try { return await getNotifyServices(); } catch { return null; }
}

export function toggleOrdersMenu(): void {
  S._ordersMenuOpen = !S._ordersMenuOpen;
  (document.getElementById('ordersMenuBody') as HTMLElement).style.display = S._ordersMenuOpen ? '' : 'none';
  (document.getElementById('ordersMenuToggle') as HTMLElement).textContent = S._ordersMenuOpen ? '▾' : '▸';
}

function _playOrderChime(): void {
  try {
    const Ctor = (window.AudioContext
      || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    const ctx  = new Ctor();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.45);
  } catch { /* ignore */ }
}

function _notifyNewOrders(newOrders: Order[]): void {
  _playOrderChime();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = newOrders.length;
  new Notification(`${n} neue Bestellung${n > 1 ? 'en' : ''}`, {
    body: newOrders.map(o => `${o.customer}: ${o.item}`).join('\n'),
    tag: 'glp-new-order',
    silent: true,
  });
}

export function startOrdersPolling(): void {
  stopOrdersPolling();
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
  SO._knownPendingIds = null; // reset so first load doesn't trigger notify
  void loadOrdersView();
  timerRegistry.set('_ordersPollTimer', window.setInterval(() => { void loadOrdersView(); }, 10000));
}

export function stopOrdersPolling(): void {
  timerRegistry.dispose('_ordersPollTimer');
}

export async function setOrdersEnabled(enabled: boolean): Promise<void> {
  try {
    const res = await postOrdersSettings({ enabled });
    if (!res.ok) throw new Error('save failed');
    _updateOrdersToggleUI(enabled);
  } catch {
    // Save failed — reload actual state from server so toggle reflects reality
    try {
      const settings = await getOrdersSettings();
      _updateOrdersToggleUI(!!settings.enabled);
    } catch { /* ignore */ }
  }
}

export function _updateOrdersToggleUI(enabled: boolean): void {
  const toggle = document.getElementById('ordersEnabledToggle') as HTMLInputElement | null;
  const label  = document.getElementById('ordersEnabledLabel');
  if (toggle) toggle.checked = enabled;
  if (label) {
    label.textContent = t(enabled ? 'orders_accept_on' : 'orders_accept_off');
    label.className   = 'orders-toggle-state ' + (enabled ? 'on' : 'off');
  }
}

export async function loadOrdersView(): Promise<void> {
  const [sw, settings] = await Promise.all([
    _getSwitchState(),
    _getSettingsOr({ enabled: true }),
  ]);
  const machineOff = sw.configured && sw.state === false;
  const banner = document.getElementById('orders-machine-off-banner');
  if (banner) { banner.style.display = machineOff ? '' : 'none'; banner.textContent = t('orders_machine_off'); }
  _updateOrdersToggleUI(!!settings.enabled);

  const [orders, menu, queueEta, milkStock] = await Promise.all([
    listOrders().catch(() => [] as Order[]),
    getOrdersMenu().catch(() => [] as MenuItem[]),
    getQueueEta().catch(() => null),
    getMilkStock().catch(() => [] as MilkStock[]),
  ]);
  SO._ordersQueueEta = queueEta;

  renderOrdersList(orders);
  renderOrdersMenuAdmin(menu);
  renderMilkStock(milkStock);
  if (S._ordersStatsOpen) {
    getOrdersStats().then(renderOrdersStats).catch(() => {});
  }

  const pendingOrders = orders.filter(o => o.status === 'pending');
  const badge = document.getElementById('ordersBadge');
  if (badge) badge.style.display = pendingOrders.length > 0 ? '' : 'none';

  // Browser notification for new pending orders
  const knownPendingIds = SO._knownPendingIds;
  if (knownPendingIds !== null && knownPendingIds !== undefined) {
    const newOnes = pendingOrders.filter(o => !knownPendingIds.has(o.id));
    if (newOnes.length > 0) _notifyNewOrders(newOnes);
  }
  SO._knownPendingIds = new Set(pendingOrders.map(o => o.id));
}

// Tiered relative time (#320) — raw minutes was unreadable once an order
// sat for hours/days (e.g. "Vor 3904 Min"): minutes under an hour, hours
// under a day, days beyond that.
export function _orderTimeAgo(ts: number): Html {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return tHtml('orders_just_now');
  if (min < 60) return tHtml('orders_ago', min);
  const hours = Math.round(min / 60);
  if (hours < 24) return tHtml('orders_ago_hours', hours);
  const days = Math.round(hours / 24);
  return tHtml('orders_ago_days', days);
}

export function renderMilkStock(milks: MilkStock[]): void {
  const el = document.getElementById('orders-milk-stock');
  if (!el) return;
  if (!milks?.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = html`<p class="orders-milk-title">${MILK_ICON_SVG} ${tHtml('orders_milk_title')}</p>${joinHtml(
    milks.map(m => {
      const cls = (m.stockMl as number) <= 0 ? 'empty' : m.remaining < 300 ? 'low' : 'ok';
      const label = (m.stockMl as number) <= 0 ? tHtml('lib_milk_empty')
        : m.remaining < 300 ? html`${esc(m.remaining)} ml`
        : html`${esc(m.remaining)} ml`;
      return html`<div class="orders-milk-row">
        <span class="orders-milk-emoji">${m.emoji ? esc(m.emoji) : MILK_ICON_SVG}</span>
        <span class="orders-milk-name">${esc(m.name)}</span>
        ${m.demand > 0 ? html`<span style="font-size:.72rem;color:var(--gray-500)">${tHtml('lib_milk_demand', m.demand)}</span>` : html``}
        <span class="orders-milk-badge ${esc(cls)}">${label}</span>
      </div>`;
    }))}`;
}

export function renderOrdersList(orders: Order[]): void {
  const pending  = orders.filter(o => o.status === 'pending');
  const accepted = orders.filter(o => o.status === 'accepted');
  const history  = orders.filter(o => ['done', 'declined'].includes(o.status)).slice(0, 20);

  const pendingEl  = document.getElementById('orders-pending-list');
  const acceptedEl = document.getElementById('orders-accepted-list');
  const historyEl   = document.getElementById('orders-history-list');
  const clearHistBtn = document.getElementById('orders-clear-history');
  if (!pendingEl) return;

  // Queue banner — only when 2+ orders active
  const totalActive = pending.length + accepted.length;
  const totalEta = SO._ordersQueueEta
    ? Math.ceil((SO._ordersQueueEta.acceptedRemaining || 0) + (SO._ordersQueueEta.pendingCount || 0) * (SO._ordersQueueEta.prepTime || 4))
    : 0;
  const queueBanner = totalActive >= 2 && totalEta > 0
    ? html`<div class="orders-queue-banner">${CLOCK_ICON_SVG} ${tHtml('orders_queue_banner', totalActive, totalEta)}</div>`
    : html``;

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  pendingEl.innerHTML = html`${queueBanner}${pending.length ? joinHtml(pending.map(o => renderOrderCard(o, 'pending'))) :
    html`<div class="orders-empty">${tHtml('orders_empty')}</div>`}`;

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  (acceptedEl as HTMLElement).innerHTML = accepted.length ? joinHtml(accepted.map(o => renderOrderCard(o, 'accepted'))) :
    html`<div class="orders-empty">${tHtml('orders_empty')}</div>`;

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  (historyEl as HTMLElement).innerHTML = history.length ? joinHtml(history.map(o => renderOrderCard(o, 'history'))) : html``;
  if (clearHistBtn) clearHistBtn.style.display = history.length ? '' : 'none';

  // Bind buttons after render
  pendingEl.querySelectorAll<HTMLElement>('[data-order-accept]').forEach(btn => {
    btn.addEventListener('click', () => { void acceptOrder(btn.dataset.orderAccept as string); });
  });
  pendingEl.querySelectorAll<HTMLElement>('[data-order-decline-toggle]').forEach(btn => {
    btn.addEventListener('click', () => toggleDeclineRow(btn.dataset.orderDeclineToggle as string));
  });
  pendingEl.querySelectorAll<HTMLElement>('[data-order-decline-submit]').forEach(btn => {
    btn.addEventListener('click', () => { void submitDecline(btn.dataset.orderDeclineSubmit as string); });
  });
  pendingEl.querySelectorAll<HTMLElement>('[data-eta-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id  = btn.dataset.orderId as string;
      const val = parseInt(btn.dataset.etaBtn as string);
      S._ordersEtaSelected[_idKey(id)] = val;
      btn.closest('.order-eta-picker')?.querySelectorAll('.order-eta-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const inp = document.getElementById(`etaCustom_${id}`) as HTMLInputElement | null;
      if (inp) inp.value = String(val);
    });
  });
  pendingEl.querySelectorAll<HTMLInputElement>('.order-eta-custom').forEach(inp => {
    inp.addEventListener('input', () => {
      const id = inp.id.replace('etaCustom_', '');
      S._ordersEtaSelected[_idKey(id)] = parseInt(inp.value) || 5;
      inp.closest('.order-eta-picker')?.querySelectorAll('.order-eta-btn').forEach(b => b.classList.remove('selected'));
    });
  });
  (acceptedEl as HTMLElement).querySelectorAll<HTMLElement>('[data-order-complete]').forEach(btn => {
    btn.addEventListener('click', () => { void completeOrder(btn.dataset.orderComplete as string); });
  });
  (acceptedEl as HTMLElement).querySelectorAll<HTMLElement>('[data-order-decline-toggle]').forEach(btn => {
    btn.addEventListener('click', () => toggleDeclineRow(btn.dataset.orderDeclineToggle as string));
  });
  (acceptedEl as HTMLElement).querySelectorAll<HTMLElement>('[data-order-decline-submit]').forEach(btn => {
    btn.addEventListener('click', () => { void submitDecline(btn.dataset.orderDeclineSubmit as string); });
  });
  (historyEl as HTMLElement).querySelectorAll<HTMLElement>('[data-order-delete]').forEach(btn => {
    btn.addEventListener('click', () => { void deleteOrder(btn.dataset.orderDelete as string); });
  });
  if (clearHistBtn) {
    clearHistBtn.onclick = () => { void clearOrderHistory(); };
  }
}

export function renderOrderCard(o: Order, ctx: string): Html {
  const etaBtns    = [2, 5, 10, 15, 20];
  // Use queue-suggested ETA if barista hasn't manually overridden
  const queuePos  = SO._ordersQueueEta?.positions?.[String(o.id)];
  const suggested = queuePos?.suggestedEta ?? 5;
  const selectedEta = S._ordersEtaSelected[_idKey(String(o.id))] ?? suggested;
  const isNew = (Date.now() - o.createdAt) < 60000;

  if (ctx === 'pending') {
    const declineOpen = S._ordersDeclineOpen[_idKey(String(o.id))];
    const queueHint = queuePos
      ? html`<span class="order-queue-hint">${tHtml('orders_queue_pos', queuePos.position, queuePos.suggestedEta)}</span>`
      : html``;
    return html`<div class="order-card status-pending">
      <div class="order-card-top">
        <span class="order-item-name">${esc(o.item)}${o.variant ? html` <span class="order-variant-badge">· ${esc(o.variant)}</span>` : html``}${isNew ? html`<span class="orders-new-badge">${tHtml('orders_new_badge')}</span>` : html``}</span>
        <span class="order-meta">${_orderTimeAgo(o.createdAt)}${queueHint}</span>
      </div>
      <div class="order-customer">${tHtml('orders_for')} <b>${esc(o.customer)}</b>${o.note ? html` · <span class="order-note">${esc(o.note)}</span>` : html``}</div>
      <div class="order-eta-picker">
        ${joinHtml(etaBtns.map(m => html`<button class="order-eta-btn${selectedEta === m ? html` selected` : html``}" data-order-id="${esc(o.id)}" data-eta-btn="${esc(m)}">${esc(m)} min</button>`))}
        <input class="order-eta-custom" type="number" min="1" max="60" value="${esc(selectedEta)}" id="etaCustom_${esc(o.id)}" placeholder="min">
        ${queuePos ? html`<span class="order-eta-suggest">${tHtml('orders_suggested_eta', queuePos.suggestedEta)}</span>` : html``}
      </div>
      <div class="order-actions">
        <button class="order-btn accept" data-order-accept="${esc(o.id)}">${tHtml('orders_accept')}</button>
        <button class="order-btn decline" data-order-decline-toggle="${esc(o.id)}">${tHtml('orders_decline')}</button>
      </div>
      ${declineOpen ? html`<div class="order-actions">
        <input class="order-decline-input" id="declineReason_${esc(o.id)}" placeholder="${tHtml('orders_decline_ph')}">
        <button class="order-btn decline" data-order-decline-submit="${esc(o.id)}">${tHtml('orders_decline')}</button>
      </div>` : html``}
    </div>`;
  }

  if (ctx === 'accepted') {
    const etaDone  = (o.acceptedAt as number) + (o.eta as number) * 60000;
    const minsLeft = Math.max(0, Math.ceil((etaDone - Date.now()) / 60000));
    const declineOpen = S._ordersDeclineOpen[_idKey(String(o.id))];
    return html`<div class="order-card status-accepted">
      <div class="order-card-top">
        <span class="order-item-name">${esc(o.item)}${o.variant ? html` <span class="order-variant-badge">· ${esc(o.variant)}</span>` : html``}</span>
        <span class="order-eta-tag">${tHtml('orders_eta_in', minsLeft)}</span>
      </div>
      <div class="order-customer">${tHtml('orders_for')} <b>${esc(o.customer)}</b>${o.note ? html` · <span class="order-note">${esc(o.note)}</span>` : html``}</div>
      <div class="order-actions">
        <button class="order-btn complete" data-order-complete="${esc(o.id)}">${CHECK_ICON_SVG} ${tHtml('orders_complete')}</button>
        <button class="order-btn decline" data-order-decline-toggle="${esc(o.id)}">${tHtml('orders_decline')}</button>
      </div>
      ${declineOpen ? html`<div class="order-actions">
        <input class="order-decline-input" id="declineReason_${esc(o.id)}" placeholder="${tHtml('orders_decline_ph')}">
        <button class="order-btn decline" data-order-decline-submit="${esc(o.id)}">${tHtml('orders_decline')}</button>
      </div>` : html``}
    </div>`;
  }

  // history
  const statusLabel = o.status === 'done' ? tHtml('orders_done') : tHtml('orders_declined');
  return html`<div class="order-card status-${esc(o.status)}">
    <div class="order-card-top">
      <span class="order-item-name">${esc(o.item)}${o.variant ? html` <span class="order-variant-badge">· ${esc(o.variant)}</span>` : html``}</span>
      <span class="order-history-right">
        <span class="order-meta">${statusLabel} · ${_orderTimeAgo(o.completedAt || o.createdAt)}</span>
        <button class="order-hist-del" data-order-delete="${esc(o.id)}" title="${tHtml('orders_delete_entry')}"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg></button>
      </span>
    </div>
    <div class="order-customer">${tHtml('orders_for')} <b>${esc(o.customer)}</b>${o.declineReason ? html` · <span class="order-decline-tag">${esc(o.declineReason)}</span>` : html``}${o.shotId != null ? html` <span class="order-shot-link" data-action="goto-shot" data-id="${esc(o.shotId)}">Shot #${esc(o.shotId)}</span>` : html``}</div>
  </div>`;
}

export async function acceptOrder(id: string): Promise<void> {
  const etaCustom = document.getElementById(`etaCustom_${id}`) as HTMLInputElement | null;
  const eta = etaCustom ? (parseInt(etaCustom.value) || S._ordersEtaSelected[_idKey(id)] || 5) : (S._ordersEtaSelected[_idKey(id)] || 5);
  await postOrderAccept(id, eta);
  void loadOrdersView();
}

export function toggleDeclineRow(id: string): void {
  S._ordersDeclineOpen[_idKey(id)] = !S._ordersDeclineOpen[_idKey(id)];
  void loadOrdersView();
}

export async function submitDecline(id: string): Promise<void> {
  const input  = document.getElementById(`declineReason_${id}`) as HTMLInputElement | null;
  const reason = input ? input.value.trim() : '';
  await postOrderDecline(id, reason);
  delete S._ordersDeclineOpen[_idKey(id)];
  void loadOrdersView();
}

export async function completeOrder(id: string): Promise<void> {
  await postOrderComplete(id);
  void loadOrdersView();
}

export function renderOrdersMenuAdmin(menu: MenuItem[]): void {
  const list = document.getElementById('ordersMenuList');
  if (!list) return;
  list.innerHTML = joinHtml(menu.map(item => {
    const variants   = item.variants || [];
    const useBeans   = !!item.useBeans;
    const useMilks   = !!item.useMilks;
    const chipHtml   = joinHtml(variants.map(v =>
      html`<span class="orders-menu-variant-chip">${esc(v)}<button class="orders-menu-variant-del" data-menu-id="${esc(item.id)}" data-variant="${esc(v)}">×</button></span>`
    ));
    const variantSection = useBeans
      ? html`<span class="orders-use-beans-note">${BEAN_ICON_SVG} ${tHtml('orders_use_beans_note')}</span>`
      : useMilks
      ? html`<span class="orders-use-beans-note">${MILK_ICON_SVG} ${tHtml('orders_use_milks_note')}</span>`
      : html`${chipHtml}
         <input class="orders-menu-variant-input" id="variantInput_${esc(item.id)}" placeholder="${tHtml('orders_variant_ph')}">
         <button class="orders-menu-variant-btn" data-variant-add="${esc(item.id)}">${tHtml('orders_variant_add_btn')}</button>`;
    const milkMl = item.milkMl || '';
    return html`
    <div class="orders-menu-item">
      <div class="orders-menu-item-top">
        <span>${esc(item.emoji)}</span>
        <span class="orders-menu-item-name">${esc(item.name)}</span>
        <button class="orders-menu-use-beans${useBeans ? html` active` : html``}" data-menu-use-beans="${esc(item.id)}" title="${tHtml('orders_use_beans_toggle')}">${BEAN_ICON_SVG}</button>
        <button class="orders-menu-use-milks${useMilks ? html` active` : html``}" data-menu-use-milks="${esc(item.id)}" title="${tHtml('orders_use_milks_toggle')}">${MILK_ICON_SVG}</button>
        <button class="orders-menu-trend${item.trending ? html` active` : html``}" data-menu-trend="${esc(item.id)}" title="${tHtml('orders_trending_toggle')}"><svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg></button>
        <button class="orders-menu-del" data-menu-del="${esc(item.id)}" title="${tHtml('orders_confirm_delete_item')}">${CLOSE_ICON_SVG}</button>
      </div>
      <div class="orders-menu-variants">${variantSection}</div>
      <div class="orders-menu-milk-row">
        ${MILK_ICON_SVG} <input class="orders-menu-milk-input" type="number" id="milkMl_${esc(item.id)}" value="${esc(milkMl)}" placeholder="0" min="0" step="10" data-milk-ml="${esc(item.id)}"> ${tHtml('orders_milk_per_order')}
      </div>
    </div>`;
  }));
  list.querySelectorAll<HTMLElement>('[data-menu-trend]').forEach(btn => {
    _onAsync(btn, 'click', async () => {
      const id   = btn.dataset.menuTrend as string;
      const item = menu.find(m => m.id === id);
      if (!item) return;
      await putMenuItem(id, { trending: !item.trending });
      void loadOrdersView();
    });
  });
  list.querySelectorAll<HTMLElement>('[data-menu-del]').forEach(btn => {
    _onAsync(btn, 'click', async () => {
      if (!confirm(t('orders_confirm_delete_item'))) return;
      await deleteMenuItem(btn.dataset.menuDel as string);
      void loadOrdersView();
    });
  });
  list.querySelectorAll<HTMLInputElement>('[data-milk-ml]').forEach(inp => {
    _onAsync(inp, 'change', async () => {
      const id = inp.dataset.milkMl as string;
      await putMenuItem(id, { milkMl: parseFloat(inp.value) || null });
    });
  });
  list.querySelectorAll<HTMLElement>('[data-menu-use-beans]').forEach(btn => {
    _onAsync(btn, 'click', async () => {
      const id   = btn.dataset.menuUseBeans as string;
      const item = menu.find(m => m.id === id);
      if (!item) return;
      await putMenuItem(id, { useBeans: !item.useBeans });
      void loadOrdersView();
    });
  });
  list.querySelectorAll<HTMLElement>('[data-menu-use-milks]').forEach(btn => {
    _onAsync(btn, 'click', async () => {
      const id   = btn.dataset.menuUseMilks as string;
      const item = menu.find(m => m.id === id);
      if (!item) return;
      await putMenuItem(id, { useMilks: !item.useMilks });
      void loadOrdersView();
    });
  });
  list.querySelectorAll<HTMLElement>('[data-variant-add]').forEach(btn => {
    _onAsync(btn, 'click', async () => {
      const id    = btn.dataset.variantAdd;
      if (!id) return;
      const input = list.querySelector<HTMLInputElement>(`#variantInput_${id}`);
      const val   = input?.value?.trim();
      if (!val) return;
      const item  = menu.find(m => m.id === id);
      if (!item) return;
      const variants = [...(item.variants || []), val];
      await putMenuItem(id, { variants });
      void loadOrdersView();
    });
  });
  list.querySelectorAll<HTMLElement>('.orders-menu-variant-del').forEach(btn => {
    _onAsync(btn, 'click', async () => {
      const id      = btn.dataset.menuId as string;
      const variant = btn.dataset.variant as string;
      const item    = menu.find(m => m.id === id);
      if (!item) return;
      const variants = (item.variants || []).filter(v => v !== variant);
      await putMenuItem(id, { variants });
      void loadOrdersView();
    });
  });
}

export function toggleOrdersStats(): void {
  S._ordersStatsOpen = !S._ordersStatsOpen;
  (document.getElementById('ordersStatsBody') as HTMLElement).style.display = S._ordersStatsOpen ? '' : 'none';
  (document.getElementById('ordersStatsToggle') as HTMLElement).textContent = S._ordersStatsOpen ? '▾' : '▸';
  if (S._ordersStatsOpen) void loadOrdersView();
}

export function renderOrdersStats(stats: OrderStats | null | undefined): void {
  const el = document.getElementById('ordersStatsContent');
  if (!el) return;
  if (!stats?.total) {
    el.innerHTML = html`<div style="color:#52525b;font-size:.8rem;padding:8px 0">${tHtml('orders_stats_no_data')}</div>`;
    return;
  }

  const fmtDate = (ts: number | null | undefined): Html => esc(ts ? new Date(ts).toLocaleDateString(localeFor(S.currentLang), { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–');
  const cards = joinHtml((stats.customers || []).map(c => html`<div class="orders-stats-card">
      <div class="orders-stats-name" title="${esc(c.name)}">${esc(c.name)}</div>
      <div class="orders-stats-row"><span>${tHtml('orders_stats_total')}</span><span class="orders-stats-val">${esc(c.count)} ${tHtml('orders_stats_orders')}</span></div>
      <div class="orders-stats-row"><span>${tHtml('orders_stats_fav')}</span><span class="orders-stats-val">${c.favItem ? esc(c.favItem) : html`–`}</span></div>
      <div class="orders-stats-row"><span>${tHtml('orders_stats_last')}</span><span class="orders-stats-val">${fmtDate(c.lastAt)}</span></div>
    </div>`));
  el.innerHTML = html`
    <div class="orders-stats-global">
      <div class="orders-stats-global-item">
        <span class="orders-stats-global-label">${tHtml('orders_stats_total')}</span>
        <span class="orders-stats-global-val">${esc(stats.total)}</span>
      </div>
      <div class="orders-stats-global-item">
        <span class="orders-stats-global-label">${tHtml('orders_stats_popular')}</span>
        <span class="orders-stats-global-val">${stats.mostPopular ? html`${esc(stats.mostPopular.item)} ×${esc(stats.mostPopular.count)}` : html`–`}</span>
      </div>
    </div>
    <div class="orders-stats-grid">${cards}</div>`;
}

export async function deleteOrder(id: string): Promise<void> {
  await deleteOrderById(id);
  void loadOrdersView();
}

export async function clearOrderHistory(): Promise<void> {
  if (!confirm(t('orders_confirm_clear_history'))) return;
  await deleteOrderHistory();
  void loadOrdersView();
}

export async function loadNotifyMappingView(): Promise<void> {
  const section = document.getElementById('ordersNotifyBody');
  if (!section) return;

  const [{ mapping, customers }, services, settings] = await Promise.all([
    _getNotifyMappingOrEmpty(),
    _getNotifyServicesOrNull(),
    _getSettingsOr({}),
  ]);

  if (services === null) {
    section.innerHTML = html`<p class="orders-notify-hint">${tHtml('orders_notify_no_ha')}</p>`;
    return;
  }

  const savedRecipients     = Array.isArray(settings.broadcastRecipients) ? settings.broadcastRecipients : [];
  const savedBaristaSvc     = settings.baristaNotifyService || '';

  // ── Notification types section ─────────────────────────────── (#603)
  const typesRows = joinHtml(NOTIFY_TYPE_KEYS.map(({ key, i18nKey }) => html`
      <div class="orders-broadcast-row">
        <input type="checkbox" id="nt_${esc(key)}" data-notify-key="${esc(key)}"${settings[key] !== false ? html` checked` : html``}>
        <label for="nt_${esc(key)}">${tHtml(i18nKey)}</label>
      </div>`));

  const typesHtml = html`
    <div class="orders-broadcast-section">
      <p class="orders-broadcast-title">${BELL_ICON_SVG} ${tHtml('orders_types_title')}</p>
      <p class="orders-notify-hint">${tHtml('orders_types_desc')}</p>
      <div class="orders-broadcast-list" id="ordersTypesList">${typesRows}</div>
      <div class="orders-notify-actions">
        <button class="orders-menu-save-btn" id="ordersTypesSaveBtn">${tHtml('orders_types_save')}</button>
      </div>
    </div>`;

  // ── Broadcast section ────────────────────────────────────────
  const broadcastRows = services.length
    ? joinHtml(services.map(s => html`
        <div class="orders-broadcast-row">
          <input type="checkbox" id="bc_${esc(s.id)}" data-svc="${esc(s.id)}"${savedRecipients.includes(s.id) ? html` checked` : html``}>
          <label for="bc_${esc(s.id)}">${esc(s.name)}</label>
        </div>`))
    : html`<p class="orders-broadcast-empty">${tHtml('orders_notify_no_ha')}</p>`;

  const broadcastHtml = html`
    <div class="orders-broadcast-section">
      <p class="orders-broadcast-title">${BELL_ICON_SVG} ${tHtml('orders_broadcast_title')}</p>
      <p class="orders-notify-hint">${tHtml('orders_broadcast_desc')}</p>
      <div class="orders-broadcast-list" id="ordersBroadcastList">${broadcastRows}</div>
      <div class="orders-notify-actions">
        <button class="orders-menu-save-btn" id="ordersBroadcastSaveBtn">${tHtml('orders_broadcast_save')}</button>
      </div>
    </div>`;

  // ── Barista section ──────────────────────────────────────────
  const baristaOptions = html`<option value="">${tHtml('orders_notify_no_service')}</option>${joinHtml(
    services.map(s => html`<option value="${esc(s.id)}"${savedBaristaSvc === s.id ? html` selected` : html``}>${esc(s.name)}</option>`))}`;

  const baristaHtml = html`
    <div class="orders-broadcast-section">
      <p class="orders-broadcast-title">${BELL_ICON_SVG} ${tHtml('orders_barista_title')}</p>
      <p class="orders-notify-hint">${tHtml('orders_barista_desc')}</p>
      <select class="orders-notify-select" id="ordersBaristaSelect">${baristaOptions}</select>
      <div class="orders-notify-actions">
        <button class="orders-menu-save-btn" id="ordersBaristaSaveBtn">${tHtml('orders_barista_save')}</button>
      </div>
    </div>`;

  // ── Per-customer section ─────────────────────────────────────
  const haUserIds = Object.keys(customers);
  const perCustomerHtml = haUserIds.length ? (() => {
    const serviceOptions = joinHtml(services.map(s =>
      html`<option value="${esc(s.id)}">${esc(s.name)}</option>`));
    return html`
      <p class="orders-notify-hint">${tHtml('orders_notify_desc')}</p>
      <div class="orders-notify-list" id="ordersNotifyList">
        ${joinHtml(haUserIds.map(uid => html`
          <div class="orders-notify-row">
            <span class="orders-notify-customer">${esc(customers[uid])}</span>
            <select class="orders-notify-select" data-uid="${esc(uid)}">
              <option value="">${tHtml('orders_notify_no_service')}</option>
              ${serviceOptions}
            </select>
          </div>`))}
      </div>
      <div class="orders-notify-actions">
        <button class="orders-menu-save-btn" id="ordersNotifySaveBtn">${tHtml('orders_notify_save')}</button>
      </div>`;
  })() : html`<p class="orders-notify-hint">${tHtml('orders_notify_no_customers')}</p>`;

  section.innerHTML = joinHtml([typesHtml, broadcastHtml, baristaHtml, perCustomerHtml]);

  document.getElementById('ordersTypesSaveBtn')?.addEventListener('click', () => { void saveNotifyToggles(); });
  document.getElementById('ordersBroadcastSaveBtn')?.addEventListener('click', () => { void saveBroadcastRecipients(); });
  document.getElementById('ordersBaristaSaveBtn')?.addEventListener('click', () => { void saveBaristaNotify(); });
  document.getElementById('ordersNotifySaveBtn')?.addEventListener('click', () => { void saveNotifyMapping(); });

  // Apply saved per-customer mapping values
  section.querySelectorAll<HTMLSelectElement>('[data-uid]').forEach(sel => {
    const saved = mapping[sel.dataset.uid as string];
    if (saved) sel.value = saved;
  });
}

export async function saveBroadcastRecipients(): Promise<void> {
  const list = document.getElementById('ordersBroadcastList');
  if (!list) return;
  const recipients = [...list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')]
    .map(cb => cb.dataset.svc).filter(Boolean) as string[];
  const settings = await _getSettingsOr({});
  await postOrdersSettings({ enabled: settings.enabled ?? true, broadcastRecipients: recipients });
  const btn = document.getElementById('ordersBroadcastSaveBtn');
  if (btn) {
    btn.innerHTML = html`${CHECK_ICON_SVG} ${tHtml('orders_broadcast_saved')}`;
    setTimeout(() => { btn.textContent = t('orders_broadcast_save'); }, 2000);
  }
}

export async function saveNotifyToggles(): Promise<void> {
  const list = document.getElementById('ordersTypesList');
  if (!list) return;
  const settings = await _getSettingsOr({});
  const body: Record<string, unknown> = { enabled: settings.enabled ?? true };
  list.querySelectorAll<HTMLInputElement>('[data-notify-key]').forEach(cb => {
    body[cb.dataset.notifyKey as string] = cb.checked;
  });
  await postOrdersSettings(body as OrdersSettingsUpdate);
  const btn = document.getElementById('ordersTypesSaveBtn');
  if (btn) {
    btn.innerHTML = html`${CHECK_ICON_SVG} ${tHtml('orders_types_saved')}`;
    setTimeout(() => { btn.textContent = t('orders_types_save'); }, 2000);
  }
}

export async function saveBaristaNotify(): Promise<void> {
  const sel = document.getElementById('ordersBaristaSelect') as HTMLSelectElement | null;
  if (!sel) return;
  const settings = await _getSettingsOr({});
  await postOrdersSettings({ enabled: settings.enabled ?? true, baristaNotifyService: sel.value || null });
  const btn = document.getElementById('ordersBaristaSaveBtn');
  if (btn) {
    btn.innerHTML = html`${CHECK_ICON_SVG} ${tHtml('orders_barista_saved')}`;
    setTimeout(() => { btn.textContent = t('orders_barista_save'); }, 2000);
  }
}

export async function saveNotifyMapping(): Promise<void> {
  const list = document.getElementById('ordersNotifyList');
  if (!list) return;
  const updates: Record<string, string> = {};
  list.querySelectorAll<HTMLSelectElement>('[data-uid]').forEach(sel => {
    updates[sel.dataset.uid as string] = sel.value;
  });
  await postNotifyMapping(updates);
  const btn = document.getElementById('ordersNotifySaveBtn');
  if (btn) {
    btn.innerHTML = html`${CHECK_ICON_SVG} ${tHtml('orders_notify_saved')}`;
    setTimeout(() => { btn.textContent = t('orders_notify_save'); }, 2000);
  }
}

export function toggleOrdersNotify(): void {
  const body = document.getElementById('ordersNotifyBody');
  const toggle = document.getElementById('ordersNotifyToggle');
  if (!body || !toggle) return;
  const open = body.style.display === 'none';
  body.style.display = open ? '' : 'none';
  toggle.textContent = open ? '▾' : '▸';
  if (open) void loadNotifyMappingView();
}

export async function addOrderMenuItem(): Promise<void> {
  const nameEl  = document.getElementById('ordersMenuName') as HTMLInputElement | null;
  const emojiEl = document.getElementById('ordersMenuEmoji') as HTMLInputElement | null;
  const name    = nameEl?.value.trim();
  const emoji   = emojiEl?.value.trim() || '☕';
  if (!name) return;
  await postOrdersMenu({ name, emoji });
  if (nameEl)  nameEl.value  = '';
  if (emojiEl) emojiEl.value = '';
  void loadOrdersView();
}
