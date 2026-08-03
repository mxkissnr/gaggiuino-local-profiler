const express = require('express');
const router  = express.Router();

const {
    loadOrders, loadAllOrders, deleteOrder, loadMenu, saveMenu,
    loadOrdersSettings, saveOrdersSettings,
    loadNotifyMapping, saveNotifyMapping,
    isOrdersEnabled, loadOptions, loadLibrary,
} = require('../lib/data');
const libraryService = require('../lib/services/LibraryService');
const orderService   = require('../lib/services/OrderService');
const machineRegistry = require('../lib/machines/registry');
const { sendHaNotify, getNotifyServices, getHaPersons } = require('../lib/ha');
const { log, rateLimit } = require('../lib/helpers');
const { getMachineRuntimeState } = require('../lib/machine-runtime-state');

// #549: orders preheat info is always about the default machine, matching
// lib/poll.js/lib/preheat.js's own hard single-machine assumption.
const defaultRuntime = getMachineRuntimeState();

// #603: one mute switch per automatic notification type, stored alongside
// the rest of the orders settings blob (loadOrdersSettings/saveOrdersSettings)
// rather than config.yaml — preheat-ready/low-stock already read
// baristaNotifyService from there, so this keeps all notify config in one
// place. Absent (undefined) means "on" — preserves existing behavior for
// installs that saved settings before this key existed.
const NOTIFY_TOGGLE_KEYS = [
    'notify_preheat_ready', 'notify_low_stock', 'notify_shop_state',
    'notify_new_order', 'notify_order_status',
];

// Menu item emoji is user-supplied and rendered in the UI — cap length
// (generous for multi-codepoint ZWJ emoji sequences) and reject anything
// containing HTML-special characters so a stray `<img onerror=...>` can't
// be stored even though the view also escapes it on render (defense in depth).
function sanitizeEmoji(raw, fallback) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return fallback;
    if (trimmed.length > 8 || /[<>&"']/.test(trimmed)) return fallback;
    return trimmed;
}

function _getPreheatInfo() {
    const opts        = loadOptions();
    const preheatMins = Math.max(1, parseInt(opts.preheat_time) || 20);
    const preheatMs   = preheatMins * 60 * 1000;
    const machineOff  = !defaultRuntime.machineOn && !!opts.switch_entity;
    if (machineOff || !defaultRuntime.switchOnAt) return { ready: false, remainingMin: preheatMins };
    const remainingMs  = Math.max(0, preheatMs - (Date.now() - defaultRuntime.switchOnAt));
    return { ready: remainingMs === 0, remainingMin: Math.max(1, Math.ceil(remainingMs / 60000)) };
}

async function _broadcastShopState(s, prev, recipients) {
    const opened = s.enabled && !prev.enabled;
    const closed = !s.enabled && prev.enabled;
    if (!opened && !closed) return;
    if (s.notify_shop_state === false) return;

    // Filter recipients to those whose person entity is currently home.
    // Recipients with no person mapping are always included (no presence data).
    let filtered = recipients;
    try {
        const persons = await getHaPersons();
        if (persons.length) {
            const mapping = loadNotifyMapping();
            const svcToState = {};
            persons.forEach(p => {
                const svc = mapping[p.haUserId];
                if (svc) svcToState[svc] = p.state;
            });
            filtered = recipients.filter(svc =>
                !(svc in svcToState) || svcToState[svc] === 'home'
            );
        }
    } catch { /* fall back to all recipients on error */ }

    if (!filtered.length) return;

    if (opened) {
        const { ready, remainingMin } = _getPreheatInfo();
        const title = ready ? '☕ Kaffee ist jetzt geöffnet!' : '⏳ Kaffee öffnet bald!';
        const body  = ready
            ? 'Die Maschine ist bereit — Bestellungen über das Menü Kaffeebar aufgeben.'
            : `Die Maschine heizt noch auf. Kaffee öffnet in ca. ${remainingMin} Min. — Bestellungen über das Menü Kaffeebar.`;
        filtered.forEach(svc => sendHaNotify(svc, title, body, 'glp_shop_open'));
        log(`Shop-open broadcast sent to ${filtered.length}/${recipients.length} device(s) (home filter)`);
    } else {
        filtered.forEach(svc => sendHaNotify(svc,
            '🚫 Kaffeebar geschlossen',
            'Die Bestellannahme wurde beendet.',
            'glp_shop_closed'));
        log(`Shop-closed broadcast sent to ${filtered.length}/${recipients.length} device(s) (home filter)`);
    }
}

// Guard: all order routes require enable_orders: true.
// Must stay scoped to /api/orders — an unscoped router.use() runs for every
// request passing through this router and would 404 the routes and static
// frontend mounted after it in server.js whenever orders are disabled.
router.use('/api/orders', (req, res, next) => {
    if (!isOrdersEnabled()) return res.status(404).json({ error: 'orders feature not enabled' });
    next();
});

// ── Menu ──────────────────────────────────────────────────────────────────

router.get('/api/orders/menu', (req, res) => res.json(loadMenu()));

router.post('/api/orders/menu', (req, res) => {
    const { name, emoji, variants } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const menu = loadMenu();
    const item = {
        id: `m_${Date.now()}`, name: name.trim(), emoji: sanitizeEmoji(emoji, '☕'),
        createdAt: Date.now(), trending: false,
        variants: Array.isArray(variants) ? variants.map(v => String(v).trim().slice(0, 50)).filter(Boolean) : [],
        useBeans: !!req.body.useBeans,
        useMilks: !!req.body.useMilks,
    };
    menu.push(item);
    saveMenu(menu);
    res.json(item);
});

router.put('/api/orders/menu/:id', (req, res) => {
    const menu = loadMenu();
    const item = menu.find(m => m.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    if (req.body?.name?.trim())                       item.name     = req.body.name.trim();
    if (req.body?.emoji?.trim())                      item.emoji    = sanitizeEmoji(req.body.emoji, item.emoji);
    if (typeof req.body?.trending === 'boolean')      item.trending = req.body.trending;
    if (Array.isArray(req.body?.variants))
        item.variants = req.body.variants.map(v => String(v).trim().slice(0, 50)).filter(Boolean);
    if (typeof req.body?.useBeans === 'boolean') item.useBeans = req.body.useBeans;
    if (typeof req.body?.useMilks === 'boolean') item.useMilks = req.body.useMilks;
    if (req.body?.milkMl !== undefined) item.milkMl = parseFloat(req.body.milkMl) || null;
    saveMenu(menu);
    res.json(item);
});

router.delete('/api/orders/menu/:id', (req, res) => {
    const menu     = loadMenu();
    const filtered = menu.filter(m => m.id !== req.params.id);
    if (filtered.length === menu.length) return res.status(404).json({ error: 'not found' });
    saveMenu(filtered);
    res.json({ ok: true });
});

router.get('/api/orders/milk-stock', (req, res) => {
    const lib    = loadLibrary();
    const menu   = loadMenu();
    const orders = loadOrders().filter(o => ['pending', 'accepted'].includes(o.status));
    const milks  = (lib.milks || []).map(m => {
        const demand = orders.reduce((sum, o) => {
            if (o.variant !== m.name) return sum;
            const item = menu.find(mi => mi.name === o.item);
            return sum + (item?.milkMl || 0);
        }, 0);
        return { ...m, demand, remaining: Math.max(0, m.stockMl - demand) };
    });
    res.json(milks);
});

router.get('/api/orders/active-beans', (req, res) => {
    res.json(libraryService.getActiveBeans());
});

router.get('/api/orders/active-milks', (req, res) => {
    res.json(libraryService.getActiveMilks());
});

// ── Settings ──────────────────────────────────────────────────────────────

router.get('/api/orders/settings', (req, res) => res.json(loadOrdersSettings()));

router.post('/api/orders/settings', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
    const prev = loadOrdersSettings();
    const s    = { ...prev, enabled: req.body.enabled };
    if (Array.isArray(req.body.broadcastRecipients)) {
        s.broadcastRecipients = req.body.broadcastRecipients
            .filter(v => typeof v === 'string' && v.startsWith('notify.'))
            .map(v => String(v).slice(0, 100));
    }
    if (req.body.baristaNotifyService !== undefined) {
        const svc = req.body.baristaNotifyService;
        s.baristaNotifyService = (typeof svc === 'string' && svc.startsWith('notify.')) ? svc.slice(0, 100) : null;
    }
    for (const key of NOTIFY_TOGGLE_KEYS) {
        if (typeof req.body[key] === 'boolean') s[key] = req.body[key];
    }
    saveOrdersSettings(s);
    log(`Orders ${s.enabled ? 'enabled' : 'disabled'}`);
    const recipients = s.broadcastRecipients || [];
    res.json(s);
    if (recipients.length) {
        _broadcastShopState(s, prev, recipients);
    }
});

// ── Queue ETA ─────────────────────────────────────────────────────────────

router.get('/api/orders/queue-eta', (req, res) => {
    // #326: a queue backed up on one machine shouldn't distort another
    // machine's ETA estimate.
    let orders = loadOrders();
    if (req.query.machine) {
        const machineId = parseInt(req.query.machine, 10);
        orders = orders.filter(o => _matchesMachine(o, machineId));
    }
    res.json(orderService.computeQueueEta(orders));
});

// ── Notify mapping ────────────────────────────────────────────────────────

router.get('/api/orders/notify-services', async (req, res) => {
    res.json(await getNotifyServices());
});

router.get('/api/orders/notify-mapping', async (req, res) => {
    const orders    = loadOrders();
    const mapping   = loadNotifyMapping();
    // Start with order history customers
    const customers = {};
    orders.forEach(o => { if (o.haUserId) customers[o.haUserId] = o.customer; });
    // Merge in all HA person entities (so admin can assign devices before first order)
    try {
        const persons = await getHaPersons();
        persons.forEach(p => { if (!customers[p.haUserId]) customers[p.haUserId] = p.name; });
    } catch { /* non-critical, fall back to order-history customers only */ }
    res.json({ mapping, customers });
});

router.post('/api/orders/notify-mapping', (req, res) => {
    const updates = req.body || {};
    const mapping = loadNotifyMapping();
    Object.entries(updates).forEach(([haUserId, svc]) => {
        if (typeof svc === 'string' && (svc === '' || svc.startsWith('notify.'))) {
            if (svc === '') delete mapping[haUserId];
            else mapping[haUserId] = svc;
        }
    });
    saveNotifyMapping(mapping);
    res.json({ ok: true });
});

// ── Orders list / mine ────────────────────────────────────────────────────

// #326: optional ?machine=<id> scopes to one machine's orders — omitted
// keeps the previous "all machines" behavior (orders predating #326 have
// no machineId in their JSON at all, treated as the default machine here
// too, matching resolveMachineId()'s own fallback).
function _matchesMachine(order, machineIdParam) {
    if (!machineIdParam) return true;
    return (order.machineId ?? 1) === machineIdParam;
}

router.get('/api/orders', (req, res) => {
    let orders = loadOrders();
    if (req.query.status) orders = orders.filter(o => o.status === req.query.status);
    if (req.query.machine) {
        const machineId = parseInt(req.query.machine, 10);
        orders = orders.filter(o => _matchesMachine(o, machineId));
    }
    res.json(orders.slice().reverse().slice(0, 100));
});

router.get('/api/orders/stats', (req, res) => {
    // #321: loadOrders()/findActive() drops done orders older than the 7-day
    // ORDERS_HISTORY_TTL_MS live-queue window — stats are labelled lifetime
    // totals, so they must read from the unfiltered table instead.
    let done = loadAllOrders().filter(o => o.status === 'done');

    // #326: byMachine breakdown (always computed, before any ?machine=
    // filtering below) — omitted from the response on a single-machine
    // install (nothing useful to show), always included once orders
    // reference more than one machine.
    const machineCounts = {};
    for (const o of done) {
        const mid = o.machineId ?? 1;
        machineCounts[mid] = (machineCounts[mid] || 0) + 1;
    }
    const distinctMachineIds = Object.keys(machineCounts);
    let byMachine = null;
    if (distinctMachineIds.length > 1) {
        const machinesById = new Map(machineRegistry.listMachines().map(m => [m.id, m]));
        byMachine = distinctMachineIds.map(idStr => {
            const id = parseInt(idStr, 10);
            return { machineId: id, machineName: machinesById.get(id)?.name || null, count: machineCounts[idStr] };
        }).sort((a, b) => b.count - a.count);
    }

    if (req.query.machine) {
        const machineId = parseInt(req.query.machine, 10);
        done = done.filter(o => _matchesMachine(o, machineId));
    }

    if (!done.length) return res.json({ total: 0, customers: [], mostPopular: null, byMachine });

    // Group by a normalized key so "Max"/"max"/"Max " count as one customer;
    // the display name shown is whichever spelling appeared most recently.
    const byCustomer = {};
    const byItem     = {};
    for (const o of done) {
        const key = String(o.customer || '').trim().toLowerCase();
        if (!byCustomer[key]) byCustomer[key] = { name: o.customer, count: 0, items: {}, lastAt: 0 };
        byCustomer[key].count++;
        byCustomer[key].items[o.item] = (byCustomer[key].items[o.item] || 0) + 1;
        const ts = o.completedAt || o.createdAt || 0;
        if (ts >= byCustomer[key].lastAt) { byCustomer[key].lastAt = ts; byCustomer[key].name = o.customer; }
        byItem[o.item] = (byItem[o.item] || 0) + 1;
    }

    const customers = Object.values(byCustomer)
        .sort((a, b) => b.count - a.count)
        .map(d => ({
            name:    d.name,
            count:   d.count,
            favItem: Object.entries(d.items).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
            lastAt:  d.lastAt,
        }));

    const mostPopular = Object.entries(byItem).sort((a, b) => b[1] - a[1])[0] || null;

    res.json({
        total:       done.length,
        customers,
        mostPopular: mostPopular ? { item: mostPopular[0], count: mostPopular[1] } : null,
        byMachine,
    });
});

router.get('/api/orders/mine', (req, res) => {
    // Prefer integration-verified HA user ID over the client-supplied query
    // param — same precedence as POST /api/orders below (#547). The query
    // fallback stays for direct-port mode, where there is no HA proxy to set
    // the header.
    const haUserId = req.headers['x-glp-ha-user-id']
        ? String(req.headers['x-glp-ha-user-id']).slice(0, 100)
        : String(req.query.haUserId || '');
    if (!haUserId) return res.status(400).json({ error: 'haUserId required' });
    const orders = loadOrders().filter(o => o.haUserId === haUserId).reverse().slice(0, 10);
    res.json(orders);
});

// ── Place order ───────────────────────────────────────────────────────────

router.post('/api/orders', (req, res) => {
    if (!rateLimit(`orders:${req.ip}`, 10)) return res.status(429).json({ error: 'Rate limit exceeded' });
    if (!loadOrdersSettings().enabled) return res.status(503).json({ error: 'orders_disabled' });
    const { item, note, customer, notifyService, variant, machine, beanId } = req.body || {};
    if (!item || !customer?.trim()) return res.status(400).json({ error: 'item and customer required' });
    const menu = loadMenu();
    const menuItem = menu.find(m => m.name === item);
    if (!menuItem) return res.status(400).json({ error: 'unknown item' });

    // Prefer integration-verified HA user ID over client-supplied body field
    const haUserId = req.headers['x-glp-ha-user-id']
        ? String(req.headers['x-glp-ha-user-id']).slice(0, 100)
        : String(req.body?.haUserId || '').slice(0, 100);

    const order = orderService.placeOrder({ item, note, customer, notifyService, variant, machine, haUserId, beanId });
    const itemLabel = order.variant ? `${order.item} · ${order.variant}` : order.item;
    log(`Order ${order.id}: ${order.customer} → ${itemLabel}`);
    const orderSettings = loadOrdersSettings();
    if (orderSettings.baristaNotifyService && orderSettings.notify_new_order !== false) {
        const body = order.note ? `${order.customer}: ${order.note}` : order.customer;
        sendHaNotify(orderSettings.baristaNotifyService, `☕ ${itemLabel}`, body, 'glp_new_order');
    }
    res.json(order);
});

// ── Order actions ─────────────────────────────────────────────────────────

// Shared by accept/complete/decline below — all three notify the customer
// on the same per-order/HA-user mapping, gated by the single
// notify_order_status toggle (#603).
function _notifyOrderStatus(order, title, body) {
    if (loadOrdersSettings().notify_order_status === false) return;
    sendHaNotify(order.notifyService || loadNotifyMapping()[order.haUserId], title, body, order.id);
}

router.post('/api/orders/:id/accept', (req, res, next) => {
    try {
        const order = orderService.acceptOrder(req.params.id, req.body?.eta);
        log(`Order ${order.id} accepted (ETA ${order.eta} min)`);
        _notifyOrderStatus(order, `☕ ${order.item} wird zubereitet`, `Fertig in ~${order.eta} Min!`);
        res.json(order);
    } catch (err) { next(err); }
});

router.post('/api/orders/:id/complete', (req, res, next) => {
    try {
        const order = orderService.completeOrder(req.params.id);
        log(`Order ${order.id} done (shotId: ${order.shotId})`);
        _notifyOrderStatus(order, `✓ ${order.item} ist fertig!`, `Hol dir deinen ${order.item} ab — guten Genuss!`);
        res.json(order);
    } catch (err) { next(err); }
});

router.post('/api/orders/:id/decline', (req, res, next) => {
    try {
        const order = orderService.declineOrder(req.params.id, req.body?.reason);
        log(`Order ${order.id} declined: ${order.declineReason}`);
        _notifyOrderStatus(order, `✕ ${order.item} abgelehnt`,
            order.declineReason ? `Grund: ${order.declineReason}` : 'Deine Bestellung wurde leider abgelehnt.');
        res.json(order);
    } catch (err) { next(err); }
});

// ── History delete ────────────────────────────────────────────────────────

router.delete('/api/orders/history', (req, res) => {
    // #327: must clear done/declined orders regardless of age — loadOrders()
    // (findActive()) only sees done orders within the 7-day TTL window, so
    // using it here would leave older done orders permanently stuck (never
    // reachable by a future clear once saveOrders() stopped deleting them
    // as a side effect of every unrelated mutation).
    for (const o of loadAllOrders()) {
        if (['done', 'declined'].includes(o.status)) deleteOrder(o.id);
    }
    res.json({ ok: true });
});

router.delete('/api/orders/:id', (req, res) => {
    const order = loadAllOrders().find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'not found' });
    if (!['done', 'declined'].includes(order.status)) return res.status(400).json({ error: 'can only delete completed orders' });
    deleteOrder(order.id);
    res.json({ ok: true });
});

module.exports = router;
