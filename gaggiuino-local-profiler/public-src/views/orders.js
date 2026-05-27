import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { esc } from '../utils.js';

export function toggleOrdersMenu() {
  S._ordersMenuOpen = !S._ordersMenuOpen;
  document.getElementById('ordersMenuBody').style.display = S._ordersMenuOpen ? '' : 'none';
  document.getElementById('ordersMenuToggle').textContent = S._ordersMenuOpen ? '▾' : '▸';
}

function _playOrderChime() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
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
  } catch (_) {}
}

function _notifyNewOrders(newOrders) {
  _playOrderChime();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = newOrders.length;
  new Notification(`☕ ${n} neue Bestellung${n > 1 ? 'en' : ''}`, {
    body: newOrders.map(o => `${o.customer}: ${o.item}`).join('\n'),
    tag: 'glp-new-order',
    silent: true,
  });
}

export function startOrdersPolling() {
  stopOrdersPolling();
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  S._knownPendingIds = null; // reset so first load doesn't trigger notify
  loadOrdersView();
  S._ordersPollTimer = setInterval(loadOrdersView, 10000);
}

export function stopOrdersPolling() {
  if (S._ordersPollTimer) { clearInterval(S._ordersPollTimer); S._ordersPollTimer = null; }
}

export async function setOrdersEnabled(enabled) {
  try {
    const res = await apiFetch('api/orders/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    if (!res.ok) throw new Error('save failed');
    _updateOrdersToggleUI(enabled);
  } catch {
    // Save failed — reload actual state from server so toggle reflects reality
    try {
      const settings = await apiFetch('api/orders/settings').then(r => r.json());
      _updateOrdersToggleUI(settings.enabled);
    } catch {}
  }
}

export function _updateOrdersToggleUI(enabled) {
  const toggle = document.getElementById('ordersEnabledToggle');
  const label  = document.getElementById('ordersEnabledLabel');
  if (toggle) toggle.checked = enabled;
  if (label) {
    label.textContent = t(enabled ? 'orders_accept_on' : 'orders_accept_off');
    label.className   = 'orders-toggle-state ' + (enabled ? 'on' : 'off');
  }
}

export async function loadOrdersView() {
  const [sw, settings] = await Promise.all([
    apiFetch('api/switch').then(r => r.json()).catch(() => ({})),
    apiFetch('api/orders/settings').then(r => r.json()).catch(() => ({ enabled: true })),
  ]);
  const machineOff = sw.configured && sw.state === false;
  const banner = document.getElementById('orders-machine-off-banner');
  if (banner) { banner.style.display = machineOff ? '' : 'none'; banner.textContent = t('orders_machine_off'); }
  _updateOrdersToggleUI(settings.enabled);

  const [orders, menu] = await Promise.all([
    apiFetch('api/orders').then(r => r.json()).catch(() => []),
    apiFetch('api/orders/menu').then(r => r.json()).catch(() => []),
  ]);

  renderOrdersList(orders);
  renderOrdersMenuAdmin(menu);
  if (S._ordersStatsOpen) renderOrdersStats(orders);

  const pendingOrders = orders.filter(o => o.status === 'pending');
  const badge = document.getElementById('ordersBadge');
  if (badge) badge.style.display = pendingOrders.length > 0 ? '' : 'none';

  // Browser notification for new pending orders
  if (S._knownPendingIds !== null && S._knownPendingIds !== undefined) {
    const newOnes = pendingOrders.filter(o => !S._knownPendingIds.has(o.id));
    if (newOnes.length > 0) _notifyNewOrders(newOnes);
  }
  S._knownPendingIds = new Set(pendingOrders.map(o => o.id));
}

export function _orderTimeAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'gerade eben';
  return t('orders_ago', min);
}

export function renderOrdersList(orders) {
  const pending  = orders.filter(o => o.status === 'pending');
  const accepted = orders.filter(o => o.status === 'accepted');
  const history  = orders.filter(o => ['done', 'declined'].includes(o.status)).slice(0, 20);

  const pendingEl  = document.getElementById('orders-pending-list');
  const acceptedEl = document.getElementById('orders-accepted-list');
  const historyEl   = document.getElementById('orders-history-list');
  const clearHistBtn = document.getElementById('orders-clear-history');
  if (!pendingEl) return;

  pendingEl.innerHTML = pending.length ? pending.map(o => renderOrderCard(o, 'pending')).join('') :
    `<div class="orders-empty">${t('orders_empty')}</div>`;

  acceptedEl.innerHTML = accepted.length ? accepted.map(o => renderOrderCard(o, 'accepted')).join('') :
    `<div class="orders-empty">${t('orders_empty')}</div>`;

  historyEl.innerHTML = history.length ? history.map(o => renderOrderCard(o, 'history')).join('') : '';
  if (clearHistBtn) clearHistBtn.style.display = history.length ? '' : 'none';

  // Bind buttons after render
  pendingEl.querySelectorAll('[data-order-accept]').forEach(btn => {
    btn.addEventListener('click', () => acceptOrder(btn.dataset.orderAccept));
  });
  pendingEl.querySelectorAll('[data-order-decline-toggle]').forEach(btn => {
    btn.addEventListener('click', () => toggleDeclineRow(btn.dataset.orderDeclineToggle));
  });
  pendingEl.querySelectorAll('[data-order-decline-submit]').forEach(btn => {
    btn.addEventListener('click', () => submitDecline(btn.dataset.orderDeclineSubmit));
  });
  pendingEl.querySelectorAll('[data-eta-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id  = btn.dataset.orderId;
      const val = parseInt(btn.dataset.etaBtn);
      S._ordersEtaSelected[id] = val;
      btn.closest('.order-eta-picker').querySelectorAll('.order-eta-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const inp = document.getElementById(`etaCustom_${id}`);
      if (inp) inp.value = val;
    });
  });
  pendingEl.querySelectorAll('.order-eta-custom').forEach(inp => {
    inp.addEventListener('input', () => {
      const id = inp.id.replace('etaCustom_', '');
      S._ordersEtaSelected[id] = parseInt(inp.value) || 5;
      inp.closest('.order-eta-picker').querySelectorAll('.order-eta-btn').forEach(b => b.classList.remove('selected'));
    });
  });
  acceptedEl.querySelectorAll('[data-order-complete]').forEach(btn => {
    btn.addEventListener('click', () => completeOrder(btn.dataset.orderComplete));
  });
  acceptedEl.querySelectorAll('[data-order-decline-toggle]').forEach(btn => {
    btn.addEventListener('click', () => toggleDeclineRow(btn.dataset.orderDeclineToggle));
  });
  acceptedEl.querySelectorAll('[data-order-decline-submit]').forEach(btn => {
    btn.addEventListener('click', () => submitDecline(btn.dataset.orderDeclineSubmit));
  });
  historyEl.querySelectorAll('[data-order-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteOrder(btn.dataset.orderDelete));
  });
  if (clearHistBtn) {
    clearHistBtn.onclick = () => clearOrderHistory();
  }
}

export function renderOrderCard(o, ctx) {
  const etaBtns    = [2, 5, 10, 15, 20];
  const selectedEta = S._ordersEtaSelected[o.id] || 5;
  const isNew = (Date.now() - o.createdAt) < 60000;

  if (ctx === 'pending') {
    const declineOpen = S._ordersDeclineOpen[o.id];
    return `<div class="order-card status-pending">
      <div class="order-card-top">
        <span class="order-item-name">${esc(o.item)}${isNew ? `<span class="orders-new-badge">${t('orders_new_badge')}</span>` : ''}</span>
        <span class="order-meta">${_orderTimeAgo(o.createdAt)}</span>
      </div>
      <div class="order-customer">${t('orders_for')} <b>${esc(o.customer)}</b>${o.note ? ` · <span class="order-note">${esc(o.note)}</span>` : ''}</div>
      <div class="order-eta-picker">
        ${etaBtns.map(m => `<button class="order-eta-btn${S._ordersEtaSelected[o.id] === m ? ' selected' : ''}" data-order-id="${esc(o.id)}" data-eta-btn="${m}">${m} min</button>`).join('')}
        <input class="order-eta-custom" type="number" min="1" max="60" value="${selectedEta}" id="etaCustom_${esc(o.id)}" placeholder="min">
      </div>
      <div class="order-actions">
        <button class="order-btn accept" data-order-accept="${esc(o.id)}">${t('orders_accept')}</button>
        <button class="order-btn decline" data-order-decline-toggle="${esc(o.id)}">${t('orders_decline')}</button>
      </div>
      ${declineOpen ? `<div class="order-actions">
        <input class="order-decline-input" id="declineReason_${esc(o.id)}" placeholder="${t('orders_decline_ph')}">
        <button class="order-btn decline" data-order-decline-submit="${esc(o.id)}">${t('orders_decline')} ✓</button>
      </div>` : ''}
    </div>`;
  }

  if (ctx === 'accepted') {
    const etaDone  = o.acceptedAt + o.eta * 60000;
    const minsLeft = Math.max(0, Math.ceil((etaDone - Date.now()) / 60000));
    const declineOpen = S._ordersDeclineOpen[o.id];
    return `<div class="order-card status-accepted">
      <div class="order-card-top">
        <span class="order-item-name">${esc(o.item)}</span>
        <span class="order-eta-tag">${t('orders_eta_in', minsLeft)}</span>
      </div>
      <div class="order-customer">${t('orders_for')} <b>${esc(o.customer)}</b>${o.note ? ` · <span class="order-note">${esc(o.note)}</span>` : ''}</div>
      <div class="order-actions">
        <button class="order-btn complete" data-order-complete="${esc(o.id)}">${t('orders_complete')}</button>
        <button class="order-btn decline" data-order-decline-toggle="${esc(o.id)}">${t('orders_decline')}</button>
      </div>
      ${declineOpen ? `<div class="order-actions">
        <input class="order-decline-input" id="declineReason_${esc(o.id)}" placeholder="${t('orders_decline_ph')}">
        <button class="order-btn decline" data-order-decline-submit="${esc(o.id)}">${t('orders_decline')} ✓</button>
      </div>` : ''}
    </div>`;
  }

  // history
  const statusLabel = o.status === 'done' ? t('orders_done') : t('orders_declined');
  return `<div class="order-card status-${o.status}">
    <div class="order-card-top">
      <span class="order-item-name">${esc(o.item)}</span>
      <span class="order-history-right">
        <span class="order-meta">${statusLabel} · ${_orderTimeAgo(o.completedAt || o.createdAt)}</span>
        <button class="order-hist-del" data-order-delete="${esc(o.id)}" title="${t('orders_delete_entry')}"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg></button>
      </span>
    </div>
    <div class="order-customer">${t('orders_for')} <b>${esc(o.customer)}</b>${o.declineReason ? ` · <span class="order-decline-tag">${esc(o.declineReason)}</span>` : ''}${o.shotId != null ? ` <span class="order-shot-link" onclick="goToShot(${o.shotId})">Shot #${o.shotId}</span>` : ''}</div>
  </div>`;
}

export async function acceptOrder(id) {
  const etaCustom = document.getElementById(`etaCustom_${id}`);
  const eta = etaCustom ? (parseInt(etaCustom.value) || S._ordersEtaSelected[id] || 5) : (S._ordersEtaSelected[id] || 5);
  await apiFetch(`api/orders/${id}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eta }) });
  loadOrdersView();
}

export function toggleDeclineRow(id) {
  S._ordersDeclineOpen[id] = !S._ordersDeclineOpen[id];
  loadOrdersView();
}

export async function submitDecline(id) {
  const input  = document.getElementById(`declineReason_${id}`);
  const reason = input ? input.value.trim() : '';
  await apiFetch(`api/orders/${id}/decline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
  delete S._ordersDeclineOpen[id];
  loadOrdersView();
}

export async function completeOrder(id) {
  await apiFetch(`api/orders/${id}/complete`, { method: 'POST' });
  loadOrdersView();
}

export async function renderOrdersMenuAdmin(menu) {
  const list = document.getElementById('ordersMenuList');
  if (!list) return;
  list.innerHTML = menu.map(item => `
    <div class="orders-menu-item">
      <span>${item.emoji}</span>
      <span class="orders-menu-item-name">${esc(item.name)}</span>
      <button class="orders-menu-trend${item.trending ? ' active' : ''}" data-menu-trend="${esc(item.id)}" title="${t('orders_trending_toggle')}">🔥</button>
      <button class="orders-menu-del" data-menu-del="${esc(item.id)}" title="${t('orders_confirm_delete_item')}">✕</button>
    </div>`).join('');
  list.querySelectorAll('[data-menu-trend]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id   = btn.dataset.menuTrend;
      const item = menu.find(m => m.id === id);
      if (!item) return;
      await apiFetch(`api/orders/menu/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trending: !item.trending }),
      });
      loadOrdersView();
    });
  });
  list.querySelectorAll('[data-menu-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('orders_confirm_delete_item'))) return;
      await apiFetch(`api/orders/menu/${btn.dataset.menuDel}`, { method: 'DELETE' });
      loadOrdersView();
    });
  });
}

export function toggleOrdersStats() {
  S._ordersStatsOpen = !S._ordersStatsOpen;
  document.getElementById('ordersStatsBody').style.display = S._ordersStatsOpen ? '' : 'none';
  document.getElementById('ordersStatsToggle').textContent = S._ordersStatsOpen ? '▾' : '▸';
  if (S._ordersStatsOpen) loadOrdersView();
}

export function renderOrdersStats(orders) {
  const el = document.getElementById('ordersStatsContent');
  if (!el) return;
  const done = orders.filter(o => o.status === 'done');
  if (!done.length) {
    el.innerHTML = `<div style="color:#52525b;font-size:.8rem;padding:8px 0">${t('orders_stats_no_data')}</div>`;
    return;
  }

  const itemCounts = {};
  done.forEach(o => { itemCounts[o.item] = (itemCounts[o.item] || 0) + 1; });
  const mostPopular = Object.entries(itemCounts).sort((a, b) => b[1] - a[1])[0];

  const byCustomer = {};
  done.forEach(o => {
    if (!byCustomer[o.customer]) byCustomer[o.customer] = { orders: [], items: {} };
    byCustomer[o.customer].orders.push(o);
    byCustomer[o.customer].items[o.item] = (byCustomer[o.customer].items[o.item] || 0) + 1;
  });
  const customers = Object.entries(byCustomer).sort((a, b) => b[1].orders.length - a[1].orders.length);

  const fmtDate = ts => ts ? new Date(ts).toLocaleDateString() : '–';
  const cards = customers.map(([name, d]) => {
    const fav  = Object.entries(d.items).sort((a, b) => b[1] - a[1])[0];
    const last = Math.max(...d.orders.map(o => o.completedAt || o.createdAt));
    return `<div class="orders-stats-card">
      <div class="orders-stats-name" title="${esc(name)}">${esc(name)}</div>
      <div class="orders-stats-row"><span>${t('orders_stats_total')}</span><span class="orders-stats-val">${d.orders.length} ${t('orders_stats_orders')}</span></div>
      <div class="orders-stats-row"><span>${t('orders_stats_fav')}</span><span class="orders-stats-val">${fav ? esc(fav[0]) : '–'}</span></div>
      <div class="orders-stats-row"><span>${t('orders_stats_last')}</span><span class="orders-stats-val">${fmtDate(last)}</span></div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="orders-stats-global">
      <div class="orders-stats-global-item">
        <span class="orders-stats-global-label">${t('orders_stats_total')}</span>
        <span class="orders-stats-global-val">${done.length}</span>
      </div>
      <div class="orders-stats-global-item">
        <span class="orders-stats-global-label">${t('orders_stats_popular')}</span>
        <span class="orders-stats-global-val">${mostPopular ? esc(mostPopular[0]) + ' ×' + mostPopular[1] : '–'}</span>
      </div>
    </div>
    <div class="orders-stats-grid">${cards}</div>`;
}

export async function deleteOrder(id) {
  await apiFetch(`api/orders/${id}`, { method: 'DELETE' });
  loadOrdersView();
}

export async function clearOrderHistory() {
  if (!confirm(t('orders_confirm_clear_history'))) return;
  await apiFetch('api/orders/history', { method: 'DELETE' });
  loadOrdersView();
}

export async function loadNotifyMappingView() {
  const section = document.getElementById('ordersNotifyBody');
  if (!section) return;

  const [{ mapping, customers }, services] = await Promise.all([
    apiFetch('api/orders/notify-mapping').then(r => r.json()).catch(() => ({ mapping: {}, customers: {} })),
    apiFetch('api/orders/notify-services').then(r => r.json()).catch(() => null),
  ]);

  if (services === null) {
    section.innerHTML = `<p class="orders-notify-hint">${t('orders_notify_no_ha')}</p>`;
    return;
  }

  const haUserIds = Object.keys(customers);
  if (!haUserIds.length) {
    section.innerHTML = `<p class="orders-notify-hint">${t('orders_notify_no_customers')}</p>`;
    return;
  }

  const serviceOptions = services.map(s =>
    `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');

  section.innerHTML = `
    <p class="orders-notify-hint">${t('orders_notify_desc')}</p>
    <div class="orders-notify-list" id="ordersNotifyList">
      ${haUserIds.map(uid => `
        <div class="orders-notify-row">
          <span class="orders-notify-customer">${esc(customers[uid])}</span>
          <select class="orders-notify-select" data-uid="${esc(uid)}">
            <option value="">${t('orders_notify_no_service')}</option>
            ${serviceOptions}
          </select>
        </div>`).join('')}
    </div>
    <div class="orders-notify-actions">
      <button class="orders-menu-save-btn" id="ordersNotifySaveBtn" onclick="saveNotifyMapping()">${t('orders_notify_save')}</button>
    </div>`;

  // Apply saved mapping values
  section.querySelectorAll('[data-uid]').forEach(sel => {
    const saved = mapping[sel.dataset.uid];
    if (saved) sel.value = saved;
  });
}

export async function saveNotifyMapping() {
  const list = document.getElementById('ordersNotifyList');
  if (!list) return;
  const updates = {};
  list.querySelectorAll('[data-uid]').forEach(sel => {
    updates[sel.dataset.uid] = sel.value;
  });
  await apiFetch('api/orders/notify-mapping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const btn = document.getElementById('ordersNotifySaveBtn');
  if (btn) {
    btn.textContent = t('orders_notify_saved');
    setTimeout(() => { btn.textContent = t('orders_notify_save'); }, 2000);
  }
}

export function toggleOrdersNotify() {
  const body = document.getElementById('ordersNotifyBody');
  const toggle = document.getElementById('ordersNotifyToggle');
  if (!body || !toggle) return;
  const open = body.style.display === 'none';
  body.style.display = open ? '' : 'none';
  toggle.textContent = open ? '▾' : '▸';
  if (open) loadNotifyMappingView();
}

export async function addOrderMenuItem() {
  const nameEl  = document.getElementById('ordersMenuName');
  const emojiEl = document.getElementById('ordersMenuEmoji');
  const name    = nameEl?.value.trim();
  const emoji   = emojiEl?.value.trim() || '☕';
  if (!name) return;
  await apiFetch('api/orders/menu', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, emoji }) });
  if (nameEl)  nameEl.value  = '';
  if (emojiEl) emojiEl.value = '';
  loadOrdersView();
}
