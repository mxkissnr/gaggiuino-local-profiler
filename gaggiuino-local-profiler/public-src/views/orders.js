import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { esc } from '../utils.js';
import { LOCALE_MAP } from '../constants.js';

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

  const [orders, menu, queueEta, milkStock] = await Promise.all([
    apiFetch('api/orders').then(r => r.json()).catch(() => []),
    apiFetch('api/orders/menu').then(r => r.json()).catch(() => []),
    apiFetch('api/orders/queue-eta').then(r => r.json()).catch(() => null),
    apiFetch('api/orders/milk-stock').then(r => r.json()).catch(() => []),
  ]);
  S._ordersQueueEta = queueEta;

  renderOrdersList(orders);
  renderOrdersMenuAdmin(menu);
  renderMilkStock(milkStock);
  if (S._ordersStatsOpen) {
    apiFetch('api/orders/stats').then(r => r.json()).then(renderOrdersStats).catch(() => {});
  }

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

// Tiered relative time (#320) — raw minutes was unreadable once an order
// sat for hours/days (e.g. "Vor 3904 Min"): minutes under an hour, hours
// under a day, days beyond that.
export function _orderTimeAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return t('orders_just_now');
  if (min < 60) return t('orders_ago', min);
  const hours = Math.round(min / 60);
  if (hours < 24) return t('orders_ago_hours', hours);
  const days = Math.round(hours / 24);
  return t('orders_ago_days', days);
}

export function renderMilkStock(milks) {
  const el = document.getElementById('orders-milk-stock');
  if (!el) return;
  if (!milks?.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = `<p class="orders-milk-title">${t('orders_milk_title')}</p>` +
    milks.map(m => {
      const cls = m.stockMl <= 0 ? 'empty' : m.remaining < 300 ? 'low' : 'ok';
      const label = m.stockMl <= 0 ? t('lib_milk_empty')
        : m.remaining < 300 ? `${m.remaining} ml`
        : `${m.remaining} ml`;
      return `<div class="orders-milk-row">
        <span class="orders-milk-emoji">${esc(m.emoji || '🥛')}</span>
        <span class="orders-milk-name">${esc(m.name)}</span>
        ${m.demand > 0 ? `<span style="font-size:.72rem;color:var(--gray-500)">${t('lib_milk_demand', m.demand)}</span>` : ''}
        <span class="orders-milk-badge ${cls}">${label}</span>
      </div>`;
    }).join('');
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

  // Queue banner — only when 2+ orders active
  const totalActive = pending.length + accepted.length;
  const totalEta = S._ordersQueueEta
    ? Math.ceil((S._ordersQueueEta.acceptedRemaining || 0) + (S._ordersQueueEta.pendingCount || 0) * (S._ordersQueueEta.prepTime || 4))
    : 0;
  const queueBanner = totalActive >= 2 && totalEta > 0
    ? `<div class="orders-queue-banner">${t('orders_queue_banner', totalActive, totalEta)}</div>`
    : '';

  pendingEl.innerHTML = queueBanner + (pending.length ? pending.map(o => renderOrderCard(o, 'pending')).join('') :
    `<div class="orders-empty">${t('orders_empty')}</div>`);

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
  // Use queue-suggested ETA if barista hasn't manually overridden
  const queuePos  = S._ordersQueueEta?.positions?.[o.id];
  const suggested = queuePos?.suggestedEta ?? 5;
  const selectedEta = S._ordersEtaSelected[o.id] ?? suggested;
  const isNew = (Date.now() - o.createdAt) < 60000;

  if (ctx === 'pending') {
    const declineOpen = S._ordersDeclineOpen[o.id];
    const queueHint = queuePos
      ? `<span class="order-queue-hint">${t('orders_queue_pos', queuePos.position, queuePos.suggestedEta)}</span>`
      : '';
    return `<div class="order-card status-pending">
      <div class="order-card-top">
        <span class="order-item-name">${esc(o.item)}${o.variant ? ` <span class="order-variant-badge">· ${esc(o.variant)}</span>` : ''}${isNew ? `<span class="orders-new-badge">${t('orders_new_badge')}</span>` : ''}</span>
        <span class="order-meta">${_orderTimeAgo(o.createdAt)}${queueHint}</span>
      </div>
      <div class="order-customer">${t('orders_for')} <b>${esc(o.customer)}</b>${o.note ? ` · <span class="order-note">${esc(o.note)}</span>` : ''}</div>
      <div class="order-eta-picker">
        ${etaBtns.map(m => `<button class="order-eta-btn${selectedEta === m ? ' selected' : ''}" data-order-id="${esc(o.id)}" data-eta-btn="${m}">${m} min</button>`).join('')}
        <input class="order-eta-custom" type="number" min="1" max="60" value="${selectedEta}" id="etaCustom_${esc(o.id)}" placeholder="min">
        ${queuePos ? `<span class="order-eta-suggest">${t('orders_suggested_eta', queuePos.suggestedEta)}</span>` : ''}
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
        <span class="order-item-name">${esc(o.item)}${o.variant ? ` <span class="order-variant-badge">· ${esc(o.variant)}</span>` : ''}</span>
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
      <span class="order-item-name">${esc(o.item)}${o.variant ? ` <span class="order-variant-badge">· ${esc(o.variant)}</span>` : ''}</span>
      <span class="order-history-right">
        <span class="order-meta">${statusLabel} · ${_orderTimeAgo(o.completedAt || o.createdAt)}</span>
        <button class="order-hist-del" data-order-delete="${esc(o.id)}" title="${t('orders_delete_entry')}"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"><path d="M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H10V19H8V9M14,9H16V19H14V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z"/></svg></button>
      </span>
    </div>
    <div class="order-customer">${t('orders_for')} <b>${esc(o.customer)}</b>${o.declineReason ? ` · <span class="order-decline-tag">${esc(o.declineReason)}</span>` : ''}${o.shotId != null ? ` <span class="order-shot-link" data-action="goto-shot" data-id="${o.shotId}">Shot #${o.shotId}</span>` : ''}</div>
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
  list.innerHTML = menu.map(item => {
    const variants   = item.variants || [];
    const useBeans   = !!item.useBeans;
    const useMilks   = !!item.useMilks;
    const chipHtml   = variants.map(v =>
      `<span class="orders-menu-variant-chip">${esc(v)}<button class="orders-menu-variant-del" data-menu-id="${esc(item.id)}" data-variant="${esc(v)}" title="✕">×</button></span>`
    ).join('');
    const variantSection = useBeans
      ? `<span class="orders-use-beans-note">🫘 ${t('orders_use_beans_note')}</span>`
      : useMilks
      ? `<span class="orders-use-beans-note">🥛 ${t('orders_use_milks_note')}</span>`
      : `${chipHtml}
         <input class="orders-menu-variant-input" id="variantInput_${esc(item.id)}" placeholder="${t('orders_variant_ph')}">
         <button class="orders-menu-variant-btn" data-variant-add="${esc(item.id)}">${t('orders_variant_add_btn')}</button>`;
    const milkMl = item.milkMl || '';
    return `
    <div class="orders-menu-item">
      <div class="orders-menu-item-top">
        <span>${esc(item.emoji)}</span>
        <span class="orders-menu-item-name">${esc(item.name)}</span>
        <button class="orders-menu-use-beans${useBeans ? ' active' : ''}" data-menu-use-beans="${esc(item.id)}" title="${t('orders_use_beans_toggle')}">🫘</button>
        <button class="orders-menu-use-milks${useMilks ? ' active' : ''}" data-menu-use-milks="${esc(item.id)}" title="${t('orders_use_milks_toggle')}">🥛</button>
        <button class="orders-menu-trend${item.trending ? ' active' : ''}" data-menu-trend="${esc(item.id)}" title="${t('orders_trending_toggle')}"><svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg></button>
        <button class="orders-menu-del" data-menu-del="${esc(item.id)}" title="${t('orders_confirm_delete_item')}">✕</button>
      </div>
      <div class="orders-menu-variants">${variantSection}</div>
      <div class="orders-menu-milk-row">
        🥛 <input class="orders-menu-milk-input" type="number" id="milkMl_${esc(item.id)}" value="${milkMl}" placeholder="0" min="0" step="10" data-milk-ml="${esc(item.id)}"> ${t('orders_milk_per_order')}
      </div>
    </div>`;
  }).join('');
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
  list.querySelectorAll('[data-milk-ml]').forEach(inp => {
    inp.addEventListener('change', async () => {
      const id = inp.dataset.milkMl;
      await apiFetch(`api/orders/menu/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ milkMl: parseFloat(inp.value) || null }),
      });
    });
  });
  list.querySelectorAll('[data-menu-use-beans]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id   = btn.dataset.menuUseBeans;
      const item = menu.find(m => m.id === id);
      if (!item) return;
      await apiFetch(`api/orders/menu/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useBeans: !item.useBeans }),
      });
      loadOrdersView();
    });
  });
  list.querySelectorAll('[data-menu-use-milks]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id   = btn.dataset.menuUseMilks;
      const item = menu.find(m => m.id === id);
      if (!item) return;
      await apiFetch(`api/orders/menu/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useMilks: !item.useMilks }),
      });
      loadOrdersView();
    });
  });
  list.querySelectorAll('[data-variant-add]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id    = btn.dataset.variantAdd;
      const input = list.querySelector(`#variantInput_${id}`);
      const val   = input?.value?.trim();
      if (!val) return;
      const item  = menu.find(m => m.id === id);
      if (!item) return;
      const variants = [...(item.variants || []), val];
      await apiFetch(`api/orders/menu/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variants }),
      });
      loadOrdersView();
    });
  });
  list.querySelectorAll('.orders-menu-variant-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id      = btn.dataset.menuId;
      const variant = btn.dataset.variant;
      const item    = menu.find(m => m.id === id);
      if (!item) return;
      const variants = (item.variants || []).filter(v => v !== variant);
      await apiFetch(`api/orders/menu/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variants }),
      });
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

export function renderOrdersStats(stats) {
  const el = document.getElementById('ordersStatsContent');
  if (!el) return;
  if (!stats?.total) {
    el.innerHTML = `<div style="color:#52525b;font-size:.8rem;padding:8px 0">${t('orders_stats_no_data')}</div>`;
    return;
  }

  const fmtDate = ts => ts ? new Date(ts).toLocaleDateString(LOCALE_MAP[S.currentLang] || 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
  const cards = (stats.customers || []).map(c => `<div class="orders-stats-card">
      <div class="orders-stats-name" title="${esc(c.name)}">${esc(c.name)}</div>
      <div class="orders-stats-row"><span>${t('orders_stats_total')}</span><span class="orders-stats-val">${c.count} ${t('orders_stats_orders')}</span></div>
      <div class="orders-stats-row"><span>${t('orders_stats_fav')}</span><span class="orders-stats-val">${c.favItem ? esc(c.favItem) : '–'}</span></div>
      <div class="orders-stats-row"><span>${t('orders_stats_last')}</span><span class="orders-stats-val">${fmtDate(c.lastAt)}</span></div>
    </div>`).join('');

  el.innerHTML = `
    <div class="orders-stats-global">
      <div class="orders-stats-global-item">
        <span class="orders-stats-global-label">${t('orders_stats_total')}</span>
        <span class="orders-stats-global-val">${stats.total}</span>
      </div>
      <div class="orders-stats-global-item">
        <span class="orders-stats-global-label">${t('orders_stats_popular')}</span>
        <span class="orders-stats-global-val">${stats.mostPopular ? esc(stats.mostPopular.item) + ' ×' + stats.mostPopular.count : '–'}</span>
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

  const [{ mapping, customers }, services, settings] = await Promise.all([
    apiFetch('api/orders/notify-mapping').then(r => r.json()).catch(() => ({ mapping: {}, customers: {} })),
    apiFetch('api/orders/notify-services').then(r => r.json()).catch(() => null),
    apiFetch('api/orders/settings').then(r => r.json()).catch(() => ({})),
  ]);

  if (services === null) {
    section.innerHTML = `<p class="orders-notify-hint">${t('orders_notify_no_ha')}</p>`;
    return;
  }

  const savedRecipients     = Array.isArray(settings.broadcastRecipients) ? settings.broadcastRecipients : [];
  const savedBaristaSvc     = settings.baristaNotifyService || '';

  // ── Broadcast section ────────────────────────────────────────
  const broadcastRows = services.length
    ? services.map(s => `
        <div class="orders-broadcast-row">
          <input type="checkbox" id="bc_${esc(s.id)}" data-svc="${esc(s.id)}"${savedRecipients.includes(s.id) ? ' checked' : ''}>
          <label for="bc_${esc(s.id)}">${esc(s.name)}</label>
        </div>`).join('')
    : `<p class="orders-broadcast-empty">${t('orders_notify_no_ha')}</p>`;

  const broadcastHtml = `
    <div class="orders-broadcast-section">
      <p class="orders-broadcast-title">${t('orders_broadcast_title')}</p>
      <p class="orders-notify-hint">${t('orders_broadcast_desc')}</p>
      <div class="orders-broadcast-list" id="ordersBroadcastList">${broadcastRows}</div>
      <div class="orders-notify-actions">
        <button class="orders-menu-save-btn" id="ordersBroadcastSaveBtn">${t('orders_broadcast_save')}</button>
      </div>
    </div>`;

  // ── Barista section ──────────────────────────────────────────
  const baristaOptions = `<option value="">${t('orders_notify_no_service')}</option>` +
    services.map(s => `<option value="${esc(s.id)}"${savedBaristaSvc === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('');

  const baristaHtml = `
    <div class="orders-broadcast-section">
      <p class="orders-broadcast-title">${t('orders_barista_title')}</p>
      <p class="orders-notify-hint">${t('orders_barista_desc')}</p>
      <select class="orders-notify-select" id="ordersBaristaSelect">${baristaOptions}</select>
      <div class="orders-notify-actions">
        <button class="orders-menu-save-btn" id="ordersBaristaSaveBtn">${t('orders_barista_save')}</button>
      </div>
    </div>`;

  // ── Per-customer section ─────────────────────────────────────
  const haUserIds = Object.keys(customers);
  const perCustomerHtml = haUserIds.length ? (() => {
    const serviceOptions = services.map(s =>
      `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    return `
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
        <button class="orders-menu-save-btn" id="ordersNotifySaveBtn">${t('orders_notify_save')}</button>
      </div>`;
  })() : `<p class="orders-notify-hint">${t('orders_notify_no_customers')}</p>`;

  section.innerHTML = broadcastHtml + baristaHtml + perCustomerHtml;

  document.getElementById('ordersBroadcastSaveBtn')?.addEventListener('click', saveBroadcastRecipients);
  document.getElementById('ordersBaristaSaveBtn')?.addEventListener('click', saveBaristaNotify);
  document.getElementById('ordersNotifySaveBtn')?.addEventListener('click', saveNotifyMapping);

  // Apply saved per-customer mapping values
  section.querySelectorAll('[data-uid]').forEach(sel => {
    const saved = mapping[sel.dataset.uid];
    if (saved) sel.value = saved;
  });
}

export async function saveBroadcastRecipients() {
  const list = document.getElementById('ordersBroadcastList');
  if (!list) return;
  const recipients = [...list.querySelectorAll('input[type="checkbox"]:checked')]
    .map(cb => cb.dataset.svc).filter(Boolean);
  const settings = await apiFetch('api/orders/settings').then(r => r.json()).catch(() => ({}));
  await apiFetch('api/orders/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: settings.enabled ?? true, broadcastRecipients: recipients }),
  });
  const btn = document.getElementById('ordersBroadcastSaveBtn');
  if (btn) {
    btn.textContent = t('orders_broadcast_saved');
    setTimeout(() => { btn.textContent = t('orders_broadcast_save'); }, 2000);
  }
}

export async function saveBaristaNotify() {
  const sel = document.getElementById('ordersBaristaSelect');
  if (!sel) return;
  const settings = await apiFetch('api/orders/settings').then(r => r.json()).catch(() => ({}));
  await apiFetch('api/orders/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: settings.enabled ?? true, baristaNotifyService: sel.value || null }),
  });
  const btn = document.getElementById('ordersBaristaSaveBtn');
  if (btn) {
    btn.textContent = t('orders_barista_saved');
    setTimeout(() => { btn.textContent = t('orders_barista_save'); }, 2000);
  }
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
