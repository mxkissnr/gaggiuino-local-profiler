import { S } from '../state/index.js';
import * as timerRegistry from '../state/timers.js';
import { t, tHtml } from '../i18n.js';
import { getSwitch } from '../api/system.js';
import {
  getOrdersSettings, postOrdersSettings, listOrders, getOrdersMenu, getQueueEta, getMilkStock,
  getOrdersStats, postOrderAccept, postOrderDecline, postOrderComplete, deleteOrderById,
  deleteOrderHistory, putMenuItem, deleteMenuItem, postOrdersMenu, getNotifyServices,
  getNotifyMapping, postNotifyMapping, getKioskKey, rotateKioskKey,
} from '../api/orders.js';
import type {
  MenuItem, MilkStock, NotifyMappingView, NotifyService, Order, OrderStats,
  OrdersSettings, QueueEta,
} from '../api/types.js';
import { esc, formatDate, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { localeFor } from '../constants.js';
import { confirmDialog } from '../components/confirm-dialog.js';
import { closeDetailSheet, openDetailSheet, requestCloseDetailSheet } from '../components/detail-sheet.js';
import { showToast } from '../components/toast.js';
import { textEntryFocused } from '../live-sync.js';
// #416: stroke-SVG replacements for the 🫘/🥛 decorative glyphs (same
// .rail-icon treatment as the 🔥 trend toggle, #415). Used both in the
// use-beans/use-milks toggle buttons and their inline notes below.
// BEAN_ICON_SVG now lives in ../icons.ts (also used by boot/annotation.ts's bean-age
// hint, #419 follow-up); MILK_ICON_SVG moved there too once the library
// and annotation milk pickers reused it as their no-emoji fallback (#1328).
import { BELL_ICON_SVG, BEAN_ICON_SVG, MILK_ICON_SVG, CLOSE_ICON_SVG, CHECK_ICON_SVG, ICON_TRASH } from '../icons.js';

// Two orders-runtime fields that state/index.ts's OrdersSlice does not
// declare: they are written and read only by this view, so they get a local
// view of S rather than widening the shared state slice.
type OrdersRuntimeState = typeof S & {
  _knownPendingIds?: Set<string> | null;
  _ordersQueueEta?: QueueEta | null;
};
const SO = S as OrdersRuntimeState;

// Hand-built view of GET /api/switch as loadOrdersView reads it.
export interface SwitchState { configured?: boolean; state?: boolean }

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
// Settings page card (components/notify-settings.ts) — they fire regardless
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
  new Notification(t('orders_notification_new', n), {
    body: newOrders.map(o => `${o.customer}: ${o.item}`).join('\n'),
    tag: 'glp-new-order',
    silent: true,
  });
}

// True while the orders view holds text a background reload would discard: a
// text field focused inside #orders-view, or a decline-reason input left with a
// value (its row stays open even without focus, so `textEntryFocused()` alone
// misses it).
// #2148: or a text field inside an open Manage panel.
function _ordersDraftOpen(): boolean {
  if (textEntryFocused()) {
    const active = document.activeElement;
    const view = document.getElementById('orders-view');
    if (view && active && view.contains(active)) return true;
    // #2148: the Manage panels (menu inputs, kiosk link) sit in the detail
    // sheet while open, outside #orders-view.
    for (const row of ORDERS_MANAGE_ROWS) {
      const panel = document.getElementById(row.panelId);
      if (panel && active && panel.contains(active)) return true;
    }
  }
  for (const el of document.querySelectorAll<HTMLInputElement>('[id^="declineReason_"]')) {
    if (el.value.trim() !== '') return true;
  }
  return false;
}
export const ordersDraftOpen = _ordersDraftOpen;

export function startOrdersPolling(): void {
  stopOrdersPolling();
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
  SO._knownPendingIds = null; // reset so first load doesn't trigger notify
  void loadOrdersView();
  timerRegistry.set('_ordersPollTimer', setInterval(() => {
    if (_ordersDraftOpen()) return;
    void loadOrdersView();
  }, 10000));
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
    showToast(t('gm_toast_save_error'));
    // Save failed — reload actual state from server so toggle reflects reality
    try {
      const settings = await getOrdersSettings();
      _updateOrdersToggleUI(!!settings.enabled);
    } catch { /* ignore */ }
  }
}

export function _updateOrdersToggleUI(enabled: boolean): void {
  const toggle = document.getElementById('ordersEnabledToggle') as HTMLInputElement | null;
  if (toggle) toggle.checked = enabled;
}

export async function loadOrdersView(): Promise<void> {
  // #1962: only a view that has nothing on screen yet says it is loading, so a
  // background refresh never flashes over the list the user is reading.
  renderOrdersManage();
  const pendingListEl = document.getElementById('orders-pending-list');
  const listShowedNothing = pendingListEl?.innerHTML === '';
  if (listShowedNothing && pendingListEl) {
    pendingListEl.innerHTML = html`<div class="loading-state">${tHtml('please_wait')}</div>`;
  }
  const [sw, settings] = await Promise.all([
    _getSwitchState(),
    _getSettingsOr({ enabled: true }),
  ]);
  _updateOrdersToggleUI(!!settings.enabled);

  let ordersFailed = false;
  const [orders, menu, queueEta, milkStock] = await Promise.all([
    listOrders().catch(() => { ordersFailed = true; return [] as Order[]; }),
    getOrdersMenu().catch(() => [] as MenuItem[]),
    getQueueEta().catch(() => null),
    getMilkStock().catch(() => [] as MilkStock[]),
  ]);
  SO._ordersQueueEta = queueEta;

  // #2016: a failed list call returns an empty array, which is not the same as
  // an empty list. Keep what is on screen (and the known pending ids) instead
  // of wiping both and re-notifying every pending order on the next good load.
  if (ordersFailed) {
    if (pendingListEl && listShowedNothing) {
      pendingListEl.innerHTML = html`<div class="loading-state" style="color:var(--err)">${tHtml('error_load')}</div>`;
    }
  } else {
    renderOrdersList(orders);
    renderOrdersVerdict(ordersVerdictText(orders, queueEta, sw, milkStock));
  }
  renderOrdersMenuAdmin(menu);
  renderMilkStock(milkStock);
  if (S._ordersStatsOpen) {
    getOrdersStats().then(renderOrdersStats).catch(() => {});
  }

  if (ordersFailed) return;

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
export function _orderTimeAgoText(ts: number, now = Date.now()): string {
  const min = Math.round((now - ts) / 60000);
  if (min < 1) return t('orders_just_now');
  if (min < 60) return t('orders_ago', min);
  const hours = Math.round(min / 60);
  if (hours < 24) return t('orders_ago_hours', hours);
  const days = Math.round(hours / 24);
  return t('orders_ago_days', days);
}

export function _orderTimeAgo(ts: number): Html {
  return esc(_orderTimeAgoText(ts));
}

export function renderMilkStock(milks: MilkStock[]): void {
  const el = document.getElementById('orders-milk-stock');
  if (!el) return;
  if (!milks?.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = html`<p class="section-title">${MILK_ICON_SVG} ${tHtml('orders_milk_title')}</p><div class="settings-group">${joinHtml(
    milks.map(m => {
      const empty = (m.stockMl as number) <= 0;
      const cls = empty ? 'badge badge--err' : m.remaining < 300 ? 'badge badge--warn' : 'badge badge--ok';
      const label = empty ? tHtml('lib_milk_empty') : html`${esc(m.remaining)} ml`;
      return html`<div class="settings-row settings-row-static">
        <span class="settings-row-icon" aria-hidden="true">${m.emoji ? esc(m.emoji) : MILK_ICON_SVG}</span>
        <span class="settings-row-text"><span class="settings-row-title">${esc(m.name)}</span>${m.demand > 0 ? html`<span class="settings-row-sub">${tHtml('lib_milk_demand', m.demand)}</span>` : html``}</span>
        <span class="${esc(cls)}">${label}</span>
      </div>`;
    }))}</div>`;
}

// #2148: the orders last rendered, so the ETA choice can name its drink.
let _lastOrders: Order[] = [];

// The minutes an accept sends: the barista's own choice, else the queue's
// suggestion for this order, else 5 — the same value the row's time shows.
export function _orderEta(id: string): number {
  return S._ordersEtaSelected[_idKey(id)] ?? SO._ordersQueueEta?.positions?.[id]?.suggestedEta ?? 5;
}

function _syncEtaLabel(id: string): void {
  document.getElementById('orders-pending-list')?.querySelectorAll<HTMLElement>('[data-order-eta-open]').forEach(btn => {
    if (btn.dataset.orderEtaOpen === id) btn.textContent = `${_orderEta(id)} min`;
  });
}

function _emptyRow(key: string): Html {
  return html`<div class="settings-row settings-row-static"><span class="settings-row-sub">${tHtml(key)}</span></div>`;
}

export function renderOrdersList(orders: Order[]): void {
  _lastOrders = orders;
  const pending  = orders.filter(o => o.status === 'pending');
  const accepted = orders.filter(o => o.status === 'accepted');
  const allHistory = orders.filter(o => ['done', 'declined'].includes(o.status));
  const history  = allHistory.slice(0, 20);

  const pendingEl  = document.getElementById('orders-pending-list');
  const acceptedEl = document.getElementById('orders-accepted-list');
  const historyEl   = document.getElementById('orders-history-list');
  const clearHistBtn = document.getElementById('orders-clear-history');
  if (!pendingEl) return;

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  pendingEl.innerHTML = pending.length ? joinHtml(pending.map(o => renderOrderCard(o, 'pending'))) : _emptyRow('orders_empty');

  // #2148: one primary per view — only the first order in progress gets it.
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  (acceptedEl as HTMLElement).innerHTML = joinHtml(accepted.map((o, i) => renderOrderCard(o, 'accepted', i === 0)));
  const progress = document.getElementById('ordersProgress');
  if (progress) progress.hidden = accepted.length === 0;

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  (historyEl as HTMLElement).innerHTML = history.length ? joinHtml(history.map(o => renderOrderCard(o, 'history'))) : _emptyRow('orders_stats_no_data');
  if (clearHistBtn) clearHistBtn.style.display = history.length ? '' : 'none';
  const historySub = document.getElementById('ordersHistorySub');
  if (historySub) historySub.textContent = ordersHistorySub(allHistory);

  // Bind buttons after render
  pendingEl.querySelectorAll<HTMLElement>('[data-order-accept]').forEach(btn => {
    btn.addEventListener('click', () => { void acceptOrder(btn.dataset.orderAccept as string); });
  });
  pendingEl.querySelectorAll<HTMLElement>('[data-order-eta-open]').forEach(btn => {
    btn.addEventListener('click', () => openOrderEta(btn.dataset.orderEtaOpen as string, btn));
  });
  for (const el of [pendingEl, acceptedEl as HTMLElement]) {
    el.querySelectorAll<HTMLElement>('[data-order-decline-toggle]').forEach(btn => {
      btn.addEventListener('click', () => toggleDeclineRow(btn.dataset.orderDeclineToggle as string));
    });
    el.querySelectorAll<HTMLElement>('[data-order-decline-submit]').forEach(btn => {
      btn.addEventListener('click', () => { void submitDecline(btn.dataset.orderDeclineSubmit as string); });
    });
  }
  (acceptedEl as HTMLElement).querySelectorAll<HTMLElement>('[data-order-complete]').forEach(btn => {
    btn.addEventListener('click', () => { void completeOrder(btn.dataset.orderComplete as string); });
  });
  (historyEl as HTMLElement).querySelectorAll<HTMLElement>('[data-order-delete]').forEach(btn => {
    btn.addEventListener('click', () => { void deleteOrder(btn.dataset.orderDelete as string); });
  });
  // The shot link sits in the open History sheet; close it before the
  // global delegation switches to the shot (a tab switch does not).
  (historyEl as HTMLElement).querySelectorAll<HTMLElement>('[data-action="goto-shot"]').forEach(btn => {
    btn.addEventListener('click', () => closeDetailSheet());
  });
  if (clearHistBtn) {
    clearHistBtn.onclick = () => { void clearOrderHistory(); };
  }
}

// #2148: one grouped row per order (docs "Cards group list rows").
function _orderTitle(o: Order, extra: Html = html``): Html {
  return html`<span class="settings-row-title">${esc(o.item)}${o.variant ? html` · ${esc(o.variant)}` : html``}${extra}</span>`;
}

function _declineToggle(o: Order): Html {
  return html`<button type="button" class="btn btn--quiet btn--icon" data-order-decline-toggle="${esc(o.id)}" aria-label="${esc(t('orders_decline'))}" title="${esc(t('orders_decline'))}">${CLOSE_ICON_SVG}</button>`;
}

function _declineRow(o: Order): Html {
  if (!S._ordersDeclineOpen[_idKey(String(o.id))]) return html``;
  return html`<div class="order-decline">
      <input class="lib-input" id="declineReason_${esc(o.id)}" aria-label="${esc(t('orders_decline_ph'))}" placeholder="${tHtml('orders_decline_ph')}">
      <button type="button" class="btn btn--danger" data-order-decline-submit="${esc(o.id)}">${tHtml('orders_decline')}</button>
    </div>`;
}

export function renderOrderCard(o: Order, ctx: string, primary = false): Html {
  const customer = html`${tHtml('orders_for')} ${esc(o.customer)}${o.note ? html` · ${esc(o.note)}` : html``}`;

  if (ctx === 'pending') {
    const isNew = (Date.now() - o.createdAt) < 60000;
    return html`<div class="settings-row settings-row-static order-row">
      <span class="settings-row-text">
        ${_orderTitle(o, isNew ? html` <span class="badge badge--err">${tHtml('orders_new_badge')}</span>` : html``)}
        <span class="settings-row-sub">${customer} · ${_orderTimeAgo(o.createdAt)}</span>
      </span>
      <span class="order-row-actions">
        <span class="order-accept" role="group">
          <button type="button" class="btn btn--tonal" data-order-accept="${esc(o.id)}">${tHtml('orders_accept')}</button>
          <button type="button" class="btn btn--tonal" data-order-eta-open="${esc(o.id)}" aria-haspopup="dialog" aria-label="${esc(t('orders_eta_label'))}">${esc(_orderEta(String(o.id)))} min</button>
        </span>
        ${_declineToggle(o)}
      </span>
      ${_declineRow(o)}
    </div>`;
  }

  if (ctx === 'accepted') {
    const etaDone  = (o.acceptedAt as number) + (o.eta as number) * 60000;
    const minsLeft = Math.max(0, Math.ceil((etaDone - Date.now()) / 60000));
    return html`<div class="settings-row settings-row-static order-row">
      <span class="settings-row-text">
        ${_orderTitle(o)}
        <span class="settings-row-sub">${customer}</span>
      </span>
      <span class="settings-row-value">${tHtml('orders_eta_in', minsLeft)}</span>
      <span class="order-row-actions">
        <button type="button" class="btn ${esc(primary ? 'btn--primary' : 'btn--tonal')}" data-order-complete="${esc(o.id)}">${CHECK_ICON_SVG} ${tHtml('orders_complete')}</button>
        ${_declineToggle(o)}
      </span>
      ${_declineRow(o)}
    </div>`;
  }

  // history
  const statusLabel = o.status === 'done' ? tHtml('orders_done') : tHtml('orders_declined');
  return html`<div class="settings-row settings-row-static order-row">
    <span class="settings-row-text">
      ${_orderTitle(o)}
      <span class="settings-row-sub">${tHtml('orders_for')} ${esc(o.customer)}${o.declineReason ? html` · ${esc(o.declineReason)}` : html``}</span>
    </span>
    <span class="settings-row-value">${statusLabel} · ${_orderTimeAgo(o.completedAt || o.createdAt)}</span>
    <span class="order-row-actions">
      ${o.shotId != null ? html`<button type="button" class="btn btn--quiet" data-action="goto-shot" data-id="${esc(o.shotId)}">${esc(t('orders_shot_link', o.shotId))}</button>` : html``}
      <button type="button" class="btn btn--quiet btn--icon" data-order-delete="${esc(o.id)}" aria-label="${esc(t('orders_delete_entry'))}" title="${esc(t('orders_delete_entry'))}">${ICON_TRASH}</button>
    </span>
  </div>`;
}

// #2148: the existing ETA choice, now in the detail sheet next to the time.
export function openOrderEta(id: string, anchor: HTMLElement | null): void {
  const o = _lastOrders.find(x => String(x.id) === id);
  if (!o) return;
  const selectedEta = _orderEta(id);
  const queuePos = SO._ordersQueueEta?.positions?.[id];
  const etaBtns = [2, 5, 10, 15, 20];
  openDetailSheet({
    title: o.variant ? `${o.item} · ${o.variant}` : o.item,
    ...(queuePos ? { sub: t('orders_suggested_eta', queuePos.suggestedEta) } : {}),
    body: html`<div class="order-eta-picker">
        ${joinHtml(etaBtns.map(m => html`<button type="button" class="chip" aria-pressed="${esc(selectedEta === m ? 'true' : 'false')}" data-order-id="${esc(o.id)}" data-eta-btn="${esc(m)}">${esc(m)} min</button>`))}
        <input class="lib-input order-eta-custom" type="number" min="1" max="60" step="1" value="${esc(selectedEta)}" id="etaCustom_${esc(o.id)}" aria-label="${esc(t('orders_eta_label'))}" placeholder="min">
      </div>`,
    anchor,
  });
  document.getElementById('detailSheet')?.querySelectorAll<HTMLElement>('[data-eta-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      S._ordersEtaSelected[_idKey(id)] = parseInt(btn.dataset.etaBtn as string);
      _syncEtaLabel(id);
      requestCloseDetailSheet();
    });
  });
  const inp = document.getElementById(`etaCustom_${id}`) as HTMLInputElement | null;
  inp?.addEventListener('input', () => {
    S._ordersEtaSelected[_idKey(id)] = parseInt(inp.value) || 5;
    _syncEtaLabel(id);
  });
}

export async function acceptOrder(id: string): Promise<void> {
  const r = await postOrderAccept(id, _orderEta(id));
  if (!r.ok) window.showToast?.(t('error_generic', r.status));
  void loadOrdersView();
}

export function toggleDeclineRow(id: string): void {
  S._ordersDeclineOpen[_idKey(id)] = !S._ordersDeclineOpen[_idKey(id)];
  void loadOrdersView();
}

export async function submitDecline(id: string): Promise<void> {
  const input  = document.getElementById(`declineReason_${id}`) as HTMLInputElement | null;
  const reason = input ? input.value.trim() : '';
  const r = await postOrderDecline(id, reason);
  if (!r.ok) window.showToast?.(t('error_generic', r.status));
  delete S._ordersDeclineOpen[_idKey(id)];
  void loadOrdersView();
}

export async function completeOrder(id: string): Promise<void> {
  const r = await postOrderComplete(id);
  if (!r.ok) window.showToast?.(t('error_generic', r.status));
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
      html`<span class="chip--input orders-menu-variant-chip">${esc(v)}<button type="button" class="flavor-chip-x orders-menu-variant-del" data-menu-id="${esc(item.id)}" data-variant="${esc(v)}" aria-label="${esc(t('lib_btn_delete'))}">${CLOSE_ICON_SVG}</button></span>`
    ));
    const variantSection = useBeans
      ? html`<span class="settings-row-sub orders-use-beans-note">${BEAN_ICON_SVG} ${tHtml('orders_use_beans_note')}</span>`
      : useMilks
      ? html`<span class="settings-row-sub orders-use-beans-note">${MILK_ICON_SVG} ${tHtml('orders_use_milks_note')}</span>`
      : html`${chipHtml}
         <input class="lib-input orders-menu-variant-input" id="variantInput_${esc(item.id)}" aria-label="${esc(t('orders_variant_ph'))}" placeholder="${tHtml('orders_variant_ph')}">
         <button type="button" class="btn btn--tonal" data-variant-add="${esc(item.id)}">${tHtml('orders_variant_add_btn')}</button>`;
    const milkMl = item.milkMl || '';
    return html`
    <div class="settings-row settings-row-static orders-menu-item">
      <div class="orders-menu-item-top">
        <span class="settings-row-icon" aria-hidden="true">${esc(item.emoji)}</span>
        <span class="settings-row-title orders-menu-item-name">${esc(item.name)}</span>
        <button type="button" class="chip" aria-pressed="${esc(String(useBeans))}" data-menu-use-beans="${esc(item.id)}" title="${tHtml('orders_use_beans_toggle')}">${BEAN_ICON_SVG}</button>
        <button type="button" class="chip" aria-pressed="${esc(String(useMilks))}" data-menu-use-milks="${esc(item.id)}" title="${tHtml('orders_use_milks_toggle')}">${MILK_ICON_SVG}</button>
        <button type="button" class="chip" aria-pressed="${esc(String(!!item.trending))}" data-menu-trend="${esc(item.id)}" title="${tHtml('orders_trending_toggle')}"><svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg></button>
        <button type="button" class="btn btn--quiet btn--icon" data-menu-del="${esc(item.id)}" aria-label="${esc(t('orders_confirm_delete_item'))}" title="${tHtml('orders_confirm_delete_item')}">${CLOSE_ICON_SVG}</button>
      </div>
      <div class="orders-menu-variants">${variantSection}</div>
      <div class="orders-menu-milk-row">
        ${MILK_ICON_SVG} <input class="lib-input orders-menu-milk-input" type="number" id="milkMl_${esc(item.id)}" value="${esc(milkMl)}" placeholder="0" min="0" max="5000" step="10" data-milk-ml="${esc(item.id)}" aria-label="${esc(t('orders_milk_per_order'))}"> ${tHtml('orders_milk_per_order')}
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
      if (!await confirmDialog(t('orders_confirm_delete_item'), { confirmLabel: t('lib_btn_delete'), destructive: true })) return;
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

export function renderOrdersStats(stats: OrderStats | null | undefined): void {
  const el = document.getElementById('ordersStatsContent');
  if (!el) return;
  if (!stats?.total) {
    el.innerHTML = html`<p class="settings-card-desc">${tHtml('orders_stats_no_data')}</p>`;
    return;
  }

  const fmtDate = (ts: number | null | undefined): Html => esc(ts ? formatDate(ts, localeFor(S.currentLang)) : '–');
  const summary = (label: Html, value: Html): Html => html`<div class="settings-row settings-row-static"><span class="settings-row-text"><span class="settings-row-title">${label}</span></span><span class="settings-row-value">${value}</span></div>`;
  const customers = joinHtml((stats.customers || []).map(c => html`<div class="settings-row settings-row-static">
      <span class="settings-row-text"><span class="settings-row-title">${esc(c.name)}</span><span class="settings-row-sub">${tHtml('orders_stats_fav')}: ${c.favItem ? esc(c.favItem) : html`–`} · ${tHtml('orders_stats_last')}: ${fmtDate(c.lastAt)}</span></span>
      <span class="settings-row-value">${esc(c.count)} ${tHtml('orders_stats_orders')}</span>
    </div>`));
  el.innerHTML = html`<div class="settings-group">
      ${summary(tHtml('orders_stats_total'), esc(stats.total))}
      ${summary(tHtml('orders_stats_popular'), stats.mostPopular ? html`${esc(stats.mostPopular.item)} ×${esc(stats.mostPopular.count)}` : html`–`)}
    </div>${customers ? html`<div class="settings-group">${customers}</div>` : html``}`;
}

export async function deleteOrder(id: string): Promise<void> {
  const r = await deleteOrderById(id);
  if (!r.ok) window.showToast?.(t('error_generic', r.status));
  void loadOrdersView();
}

export async function clearOrderHistory(): Promise<void> {
  if (!await confirmDialog(t('orders_confirm_clear_history'), { confirmLabel: t('lib_btn_delete'), destructive: true })) return;
  const r = await deleteOrderHistory();
  if (!r.ok) window.showToast?.(t('error_generic', r.status));
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
    section.innerHTML = html`<p class="settings-card-desc">${tHtml('orders_notify_no_ha')}</p>`;
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
      <p class="section-title">${BELL_ICON_SVG} ${tHtml('orders_types_title')}</p>
      <p class="settings-card-desc">${tHtml('orders_types_desc')}</p>
      <div class="orders-broadcast-list" id="ordersTypesList">${typesRows}</div>
      <div class="orders-notify-actions">
        <button type="button" class="btn btn--tonal" id="ordersTypesSaveBtn">${tHtml('orders_types_save')}</button>
      </div>
    </div>`;

  // ── Broadcast section ────────────────────────────────────────
  const broadcastRows = services.length
    ? joinHtml(services.map(s => html`
        <div class="orders-broadcast-row">
          <input type="checkbox" id="bc_${esc(s.id)}" data-svc="${esc(s.id)}"${savedRecipients.includes(s.id) ? html` checked` : html``}>
          <label for="bc_${esc(s.id)}">${esc(s.name)}</label>
        </div>`))
    : html`<p class="settings-card-desc">${tHtml('orders_notify_no_ha')}</p>`;

  const broadcastHtml = html`
    <div class="orders-broadcast-section">
      <p class="section-title">${BELL_ICON_SVG} ${tHtml('orders_broadcast_title')}</p>
      <p class="settings-card-desc">${tHtml('orders_broadcast_desc')}</p>
      <div class="orders-broadcast-list" id="ordersBroadcastList">${broadcastRows}</div>
      <div class="orders-notify-actions">
        <button type="button" class="btn btn--tonal" id="ordersBroadcastSaveBtn">${tHtml('orders_broadcast_save')}</button>
      </div>
    </div>`;

  // ── Barista section ──────────────────────────────────────────
  const baristaOptions = html`<option value="">${tHtml('orders_notify_no_service')}</option>${joinHtml(
    services.map(s => html`<option value="${esc(s.id)}"${savedBaristaSvc === s.id ? html` selected` : html``}>${esc(s.name)}</option>`))}`;

  const baristaHtml = html`
    <div class="orders-broadcast-section">
      <p class="section-title">${BELL_ICON_SVG} ${tHtml('orders_barista_title')}</p>
      <p class="settings-card-desc">${tHtml('orders_barista_desc')}</p>
      <select class="lib-select" id="ordersBaristaSelect" aria-label="${esc(t('orders_barista_title'))}">${baristaOptions}</select>
      <div class="orders-notify-actions">
        <button type="button" class="btn btn--tonal" id="ordersBaristaSaveBtn">${tHtml('orders_barista_save')}</button>
      </div>
    </div>`;

  // ── Per-customer section ─────────────────────────────────────
  const haUserIds = Object.keys(customers);
  const perCustomerHtml = haUserIds.length ? (() => {
    const serviceOptions = joinHtml(services.map(s =>
      html`<option value="${esc(s.id)}">${esc(s.name)}</option>`));
    return html`
      <p class="settings-card-desc">${tHtml('orders_notify_desc')}</p>
      <div class="settings-group" id="ordersNotifyList">
        ${joinHtml(haUserIds.map(uid => html`
          <div class="settings-row settings-row-static">
            <span class="settings-row-text"><span class="settings-row-title">${esc(customers[uid])}</span></span>
            <select class="lib-select" data-uid="${esc(uid)}" aria-label="${esc(t('orders_notify_desc'))}">
              <option value="">${tHtml('orders_notify_no_service')}</option>
              ${serviceOptions}
            </select>
          </div>`))}
      </div>
      <div class="orders-notify-actions">
        <button type="button" class="btn btn--tonal" id="ordersNotifySaveBtn">${tHtml('orders_notify_save')}</button>
      </div>`;
  })() : html`<p class="settings-card-desc">${tHtml('orders_notify_no_customers')}</p>`;

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
  const r = await postOrdersSettings({ broadcastRecipients: recipients });
  if (!r.ok) { window.showToast?.(t('error_generic', r.status)); return; }
  const btn = document.getElementById('ordersBroadcastSaveBtn');
  if (btn) {
    btn.innerHTML = html`${CHECK_ICON_SVG} ${tHtml('orders_broadcast_saved')}`;
    setTimeout(() => { btn.textContent = t('orders_broadcast_save'); }, 2000);
  }
}

export async function saveNotifyToggles(): Promise<void> {
  const list = document.getElementById('ordersTypesList');
  if (!list) return;
  const body: Record<string, unknown> = {};
  list.querySelectorAll<HTMLInputElement>('[data-notify-key]').forEach(cb => {
    body[cb.dataset.notifyKey as string] = cb.checked;
  });
  const r = await postOrdersSettings(body);
  if (!r.ok) { window.showToast?.(t('error_generic', r.status)); return; }
  const btn = document.getElementById('ordersTypesSaveBtn');
  if (btn) {
    btn.innerHTML = html`${CHECK_ICON_SVG} ${tHtml('orders_types_saved')}`;
    setTimeout(() => { btn.textContent = t('orders_types_save'); }, 2000);
  }
}

export async function saveBaristaNotify(): Promise<void> {
  const sel = document.getElementById('ordersBaristaSelect') as HTMLSelectElement | null;
  if (!sel) return;
  const r = await postOrdersSettings({ baristaNotifyService: sel.value || null });
  if (!r.ok) { window.showToast?.(t('error_generic', r.status)); return; }
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

// ── Verdict and Manage (#2148) ──────────────────────────────────────────

// Minutes until the whole queue is done: the server's rolling estimate when
// it answered (accepted orders' remaining time plus one prep time per
// waiting order), else the same sum from the orders themselves with the
// server's default of 4 minutes per order.
export function ordersQueueMinutes(orders: Order[], queueEta: QueueEta | null, now = Date.now()): number {
  if (queueEta) {
    return Math.ceil((queueEta.acceptedRemaining || 0) + (queueEta.pendingCount || 0) * (queueEta.prepTime || 4));
  }
  let minutes = 0;
  for (const o of orders) {
    if (o.status === 'pending') minutes += 4;
    else if (o.status === 'accepted') {
      minutes += Math.max(0, Math.ceil(((o.acceptedAt ?? now) + (o.eta ?? 0) * 60000 - now) / 60000));
    }
  }
  return minutes;
}

export interface OrdersVerdict {
  count: number;
  title: string;
  sub: string;
}

// The verdict: the big number is the orders waiting, the sentence how long
// the queue takes; the sub line says whether the machine is on and how much
// milk is left. No "running low" mark: there is no threshold for it.
export function ordersVerdictText(orders: Order[], queueEta: QueueEta | null, sw: SwitchState, milks: MilkStock[], now = Date.now()): OrdersVerdict {
  const waiting = orders.filter(o => o.status === 'pending').length;
  const active = waiting + orders.filter(o => o.status === 'accepted').length;
  const title = active === 0
    ? t('orders_verdict_idle')
    : t('orders_verdict_eta', Math.max(1, ordersQueueMinutes(orders, queueEta, now)));
  const machine = !sw.configured ? ''
    : sw.state === false ? t('orders_machine_off')
    : sw.state === true ? t('orders_machine_on')
    : '';
  const milk = milks.map(m => `${m.name} ${(m.stockMl ?? 0) <= 0 ? t('lib_milk_empty') : `${m.remaining} ml`}`);
  const sub = [machine, ...milk].filter(Boolean).join(' · ');
  return { count: waiting, title, sub };
}

export function renderOrdersVerdict(v: OrdersVerdict): void {
  const count = document.getElementById('ordersWaitingCount');
  const lbl = document.getElementById('ordersWaitingLbl');
  const title = document.getElementById('ordersVerdictTitle');
  const sub = document.getElementById('ordersVerdictSub');
  if (count) count.textContent = String(v.count);
  if (lbl) lbl.textContent = t('orders_verdict_waiting');
  if (title) title.textContent = v.title;
  if (sub) {
    sub.textContent = v.sub;
    sub.hidden = v.sub === '';
  }
}

// The History row's sub line: finished orders today and how long ago the
// last one finished.
export function ordersHistorySub(history: Order[], now = Date.now()): string {
  if (!history.length) return t('orders_stats_no_data');
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const at = (o: Order): number => o.completedAt || o.createdAt;
  const today = history.filter(o => at(o) >= start.getTime()).length;
  const last = Math.max(...history.map(at));
  return `${t('orders_history_today', today)} · ${_orderTimeAgoText(last, now)}`;
}

// The Manage group: each row opens its panel — static markup under
// .orders-panels, so every existing id and handler stays — in the shared
// detail sheet, the way the settings page opens its form cards (#2038).
export interface OrdersManageRow {
  id: string;
  titleKey: string;
  panelId: string;
}

export const ORDERS_MANAGE_ROWS: readonly OrdersManageRow[] = [
  { id: 'history', titleKey: 'orders_history', panelId: 'ordersHistoryPanel' },
  { id: 'menu', titleKey: 'orders_menu_title', panelId: 'ordersMenuPanel' },
  { id: 'guests', titleKey: 'orders_stats_title', panelId: 'ordersGuestsPanel' },
  { id: 'kiosk', titleKey: 'orders_manage_kiosk', panelId: 'ordersKioskPanel' },
];

// The data-i18n spans hold text only, so a language switch relabels them.
export function ordersManageHtml(): Html {
  return html`<h2 class="section-title" data-i18n="orders_manage">${tHtml('orders_manage')}</h2>
    <div class="settings-group">${joinHtml(ORDERS_MANAGE_ROWS.map(row => html`<button type="button" class="settings-row" data-orders-manage="${esc(row.id)}" aria-haspopup="dialog">
      <span class="settings-row-text"><span class="settings-row-title" data-i18n="${esc(row.titleKey)}">${tHtml(row.titleKey)}</span>${row.id === 'history' ? html`<span class="settings-row-sub" id="ordersHistorySub"></span>` : html``}</span>
      <span class="settings-chev" aria-hidden="true"></span>
    </button>`))}</div>`;
}

// Rendered once: the 10 s poll must not take the focus off a row.
export function renderOrdersManage(): void {
  const el = document.getElementById('ordersManage');
  if (!el || el.innerHTML !== '') return;
  // codeql[js/xss-through-dom] false positive: esc()/html already applied, see #760
  el.innerHTML = ordersManageHtml();
}

export function openOrdersManage(id: string): void {
  const row = ORDERS_MANAGE_ROWS.find(r => r.id === id);
  if (!row) return;
  const panel = document.getElementById(row.panelId);
  if (!panel) return;
  if (id === 'guests') {
    S._ordersStatsOpen = true;
    getOrdersStats().then(renderOrdersStats).catch(() => {});
  }
  if (id === 'kiosk') {
    void loadKioskLinkView();
    void loadNotifyMappingView();
  }
  openDetailSheet({
    title: t(row.titleKey),
    dialog: true,
    body: html``,
    content: panel,
    onClose: () => { if (id === 'guests') S._ordersStatsOpen = false; },
  });
}

// ── Kiosk link (#1731) ───────────────────────────────────────────────────

// The direct link a tablet opens once: kiosk.html next to this page, with the
// orders-only key in the fragment. Under HA Ingress that base is the
// per-session Ingress URL, which a tablet cannot reach, hence the hint below.
export function kioskLinkFor(kioskUrl: string, key: string): string {
  return `${kioskUrl}#key=${encodeURIComponent(key)}`;
}

// The page is being served through HA Ingress, whose URL only works inside the
// Home Assistant UI.
function servedThroughIngress(): boolean {
  return location.pathname.includes('/api/hassio_ingress/');
}

function renderKioskLink(section: HTMLElement, key: string): void {
  const link = kioskLinkFor(new URL('kiosk.html', document.baseURI).href, key);
  const ingress = servedThroughIngress();
  section.innerHTML = html`
    <p class="settings-card-desc">${esc(t('orders_kiosk_link_desc'))}</p>
    <div class="orders-menu-add-row">
      <input class="lib-input orders-kiosk-link" id="ordersKioskLink" readonly
             aria-label="${esc(t('orders_kiosk_link_title'))}" value="${esc(link)}">
      <button class="btn btn--quiet" id="ordersKioskCopyBtn" type="button">${tHtml('orders_kiosk_link_copy')}</button>
      <button class="btn btn--danger" id="ordersKioskRotateBtn" type="button">${tHtml('orders_kiosk_link_rotate')}</button>
    </div>
    ${ingress ? html`<p class="settings-card-desc">${esc(t('orders_kiosk_link_ingress_hint'))}</p>` : html``}`;

  document.getElementById('ordersKioskCopyBtn')?.addEventListener('click', () => {
    const input = document.getElementById('ordersKioskLink') as HTMLInputElement | null;
    const value = input?.value ?? '';
    if (!value) return;
    navigator.clipboard?.writeText(value)
      .then(() => window.showToast?.(t('orders_kiosk_link_copied')))
      .catch(() => {});
  });
  document.getElementById('ordersKioskRotateBtn')?.addEventListener('click', () => {
    void (async () => {
      if (!await confirmDialog(t('orders_kiosk_link_rotate_confirm'))) return;
      await rotateKioskLinkAndRender(section);
    })();
  });
}

async function rotateKioskLinkAndRender(section: HTMLElement): Promise<void> {
  try {
    renderKioskLink(section, (await rotateKioskKey()).kioskKey);
  } catch (err) {
    window.showToast?.(t('error_generic', err instanceof Error ? err.message : String(err)));
  }
}

export async function loadKioskLinkView(): Promise<void> {
  const section = document.getElementById('ordersKioskBody');
  if (!section) return;
  try {
    // Reading the key mints one on the first visit, so the panel is never empty.
    renderKioskLink(section, (await getKioskKey()).kioskKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    section.innerHTML = html`<p class="settings-card-desc">${esc(t('error_generic', message))}</p>`;
  }
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
