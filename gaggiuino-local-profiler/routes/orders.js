const express = require('express');
const fs      = require('fs');
const router  = express.Router();

const { ANNOTATIONS_FILE, DATA_FILE } = require('../lib/constants');
const {
    loadOrders, saveOrders, loadMenu, saveMenu,
    loadOrdersSettings, saveOrdersSettings,
    loadNotifyMapping, saveNotifyMapping,
    loadAnnotations, loadTrash, isOrdersEnabled, loadOptions, loadLibrary,
} = require('../lib/data');
const { sendHaNotify, getNotifyServices, getHaPersons } = require('../lib/ha');
const { log, rateLimit, writeFileSafe } = require('../lib/helpers');
const state = require('../lib/state');

function _getPreheatInfo() {
    const opts        = loadOptions();
    const preheatMins = Math.max(1, parseInt(opts.preheat_time) || 20);
    const preheatMs   = preheatMins * 60 * 1000;
    const machineOff  = !state.machineOn && !!opts.switch_entity;
    if (machineOff || !state.switchOnAt) return { ready: false, remainingMin: preheatMins };
    const remainingMs  = Math.max(0, preheatMs - (Date.now() - state.switchOnAt));
    return { ready: remainingMs === 0, remainingMin: Math.max(1, Math.ceil(remainingMs / 60000)) };
}

async function _broadcastShopState(s, prev, recipients) {
    const opened = s.enabled && !prev.enabled;
    const closed = !s.enabled && prev.enabled;
    if (!opened && !closed) return;

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

// Guard: all order routes require enable_orders: true
router.use((req, res, next) => {
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
        id: `m_${Date.now()}`, name: name.trim(), emoji: emoji?.trim() || '☕',
        createdAt: Date.now(), trending: false,
        variants: Array.isArray(variants) ? variants.map(v => String(v).trim().slice(0, 50)).filter(Boolean) : [],
        useBeans: !!req.body.useBeans,
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
    if (req.body?.emoji?.trim())                      item.emoji    = req.body.emoji.trim();
    if (typeof req.body?.trending === 'boolean')      item.trending = req.body.trending;
    if (Array.isArray(req.body?.variants))
        item.variants = req.body.variants.map(v => String(v).trim().slice(0, 50)).filter(Boolean);
    if (typeof req.body?.useBeans === 'boolean') item.useBeans = req.body.useBeans;
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
    const lib = loadLibrary();
    const active = (lib.beans || [])
        .filter(b => b.stock_g > 0)
        .map(b => ({ id: b.id, name: b.name, roaster: b.roaster || null, decaf: !!b.decaf }));
    res.json(active);
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
    saveOrdersSettings(s);
    log(`Orders ${s.enabled ? 'enabled' : 'disabled'}`);
    const recipients = s.broadcastRecipients || [];
    res.json(s);
    if (recipients.length) {
        _broadcastShopState(s, prev, recipients);
    }
});

// ── Queue ETA ─────────────────────────────────────────────────────────────

const DEFAULT_PREP_TIME = 4; // minutes per order, used when no historical data

router.get('/api/orders/queue-eta', (req, res) => {
    const orders  = loadOrders();
    const now     = Date.now();
    const accepted = orders.filter(o => o.status === 'accepted');
    const pending  = orders.filter(o => o.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt);

    // Sum remaining time of all accepted orders
    const acceptedRemaining = accepted.reduce((sum, o) => {
        return sum + Math.max(0, (o.acceptedAt + o.eta * 60000 - now) / 60000);
    }, 0);

    // Use average ETA of last 10 completed orders as prep time estimate
    const recent = orders
        .filter(o => o.status === 'done' && o.eta)
        .slice(-10);
    const prepTime = recent.length
        ? recent.reduce((s, o) => s + o.eta, 0) / recent.length
        : DEFAULT_PREP_TIME;

    // Per-order suggested ETA based on queue position
    const positions = {};
    pending.forEach((o, i) => {
        positions[o.id] = {
            position:     i + 1,
            suggestedEta: Math.max(1, Math.min(60, Math.ceil(acceptedRemaining + i * prepTime + prepTime))),
        };
    });

    res.json({
        acceptedRemaining: Math.round(acceptedRemaining * 10) / 10,
        pendingCount:      pending.length,
        prepTime:          Math.round(prepTime * 10) / 10,
        positions,
    });
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

router.get('/api/orders', (req, res) => {
    let orders = loadOrders();
    if (req.query.status) orders = orders.filter(o => o.status === req.query.status);
    res.json(orders.slice().reverse().slice(0, 100));
});

router.get('/api/orders/stats', (req, res) => {
    const done = loadOrders().filter(o => o.status === 'done');
    if (!done.length) return res.json({ total: 0, customers: [], mostPopular: null });

    const byCustomer = {};
    const byItem     = {};
    for (const o of done) {
        if (!byCustomer[o.customer]) byCustomer[o.customer] = { count: 0, items: {}, lastAt: 0 };
        byCustomer[o.customer].count++;
        byCustomer[o.customer].items[o.item] = (byCustomer[o.customer].items[o.item] || 0) + 1;
        const ts = o.completedAt || o.createdAt || 0;
        if (ts > byCustomer[o.customer].lastAt) byCustomer[o.customer].lastAt = ts;
        byItem[o.item] = (byItem[o.item] || 0) + 1;
    }

    const customers = Object.entries(byCustomer)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([name, d]) => ({
            name,
            count:   d.count,
            favItem: Object.entries(d.items).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
            lastAt:  d.lastAt,
        }));

    const mostPopular = Object.entries(byItem).sort((a, b) => b[1] - a[1])[0] || null;

    res.json({
        total:       done.length,
        customers,
        mostPopular: mostPopular ? { item: mostPopular[0], count: mostPopular[1] } : null,
    });
});

router.get('/api/orders/mine', (req, res) => {
    const { haUserId } = req.query;
    if (!haUserId) return res.status(400).json({ error: 'haUserId required' });
    const orders = loadOrders().filter(o => o.haUserId === haUserId).reverse().slice(0, 10);
    res.json(orders);
});

// ── Place order ───────────────────────────────────────────────────────────

router.post('/api/orders', (req, res) => {
    if (!rateLimit(`orders:${req.ip}`, 10)) return res.status(429).json({ error: 'Rate limit exceeded' });
    if (!loadOrdersSettings().enabled) return res.status(503).json({ error: 'orders_disabled' });
    const { item, note, customer, notifyService, variant } = req.body || {};
    if (!item || !customer?.trim()) return res.status(400).json({ error: 'item and customer required' });
    const menu = loadMenu();
    const menuItem = menu.find(m => m.name === item);
    if (!menuItem) return res.status(400).json({ error: 'unknown item' });
    const validVariant = variant ? String(variant).trim().slice(0, 50) : null;

    // Prefer integration-verified HA user ID over client-supplied body field
    const haUserId = req.headers['x-glp-ha-user-id']
        ? String(req.headers['x-glp-ha-user-id']).slice(0, 100)
        : String(req.body?.haUserId || '').slice(0, 100);

    const orders = loadOrders();
    const order  = {
        id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        createdAt: Date.now(),
        customer:  String(customer).trim().slice(0, 50),
        haUserId,
        item,
        variant:        validVariant,
        note:           note ? String(note).slice(0, 200) : '',
        notifyService:  notifyService && String(notifyService).startsWith('notify.') ? String(notifyService).slice(0, 100) : null,
        status:    'pending',
        eta: null, acceptedAt: null, completedAt: null, declineReason: null,
    };
    orders.push(order);
    saveOrders(orders);
    const itemLabel = order.variant ? `${order.item} · ${order.variant}` : order.item;
    log(`Order ${order.id}: ${order.customer} → ${itemLabel}`);
    const baristaSvc = loadOrdersSettings().baristaNotifyService;
    if (baristaSvc) {
        const body = order.note ? `${order.customer}: ${order.note}` : order.customer;
        sendHaNotify(baristaSvc, `☕ ${itemLabel}`, body, 'glp_new_order');
    }
    res.json(order);
});

// ── Order actions ─────────────────────────────────────────────────────────

router.post('/api/orders/:id/accept', (req, res) => {
    const orders = loadOrders();
    const order  = orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'not found' });
    if (order.status !== 'pending') return res.status(400).json({ error: 'not pending' });
    order.status     = 'accepted';
    order.eta        = Math.max(1, Math.min(60, parseInt(req.body?.eta) || 5));
    order.acceptedAt = Date.now();
    saveOrders(orders);
    log(`Order ${order.id} accepted (ETA ${order.eta} min)`);
    sendHaNotify(order.notifyService || loadNotifyMapping()[order.haUserId],
        `☕ ${order.item} wird zubereitet`, `Fertig in ~${order.eta} Min!`, order.id);
    res.json(order);
});

router.post('/api/orders/:id/complete', (req, res) => {
    const orders = loadOrders();
    const order  = orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'not found' });
    order.status      = 'done';
    order.completedAt = Date.now();
    try {
        if (fs.existsSync(DATA_FILE)) {
            const trash = loadTrash();
            const shots = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).filter(s => !trash[String(s.id)]);
            order.shotId = shots[shots.length - 1]?.id ?? null;
        }
    } catch { order.shotId = null; }
    if (order.shotId != null) {
        try {
            const annotations = loadAnnotations();
            const key = String(order.shotId);
            annotations[key] = { ...(annotations[key] || {}), orderedBy: {
                customer: order.customer, haUserId: order.haUserId, orderId: order.id,
                item: order.item, variant: order.variant || null, note: order.note || null,
            } };
            writeFileSafe(ANNOTATIONS_FILE, annotations);
        } catch { /* non-critical */ }
    }
    saveOrders(orders);
    log(`Order ${order.id} done (shotId: ${order.shotId})`);
    sendHaNotify(order.notifyService || loadNotifyMapping()[order.haUserId],
        `✓ ${order.item} ist fertig!`, `Hol dir deinen ${order.item} ab — guten Genuss!`, order.id);
    res.json(order);
});

router.post('/api/orders/:id/decline', (req, res) => {
    const orders = loadOrders();
    const order  = orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'not found' });
    if (!['pending', 'accepted'].includes(order.status)) return res.status(400).json({ error: 'cannot decline' });
    order.status        = 'declined';
    order.declineReason = String(req.body?.reason || '').slice(0, 200);
    order.completedAt   = Date.now();
    saveOrders(orders);
    log(`Order ${order.id} declined: ${order.declineReason}`);
    sendHaNotify(order.notifyService || loadNotifyMapping()[order.haUserId],
        `✕ ${order.item} abgelehnt`,
        order.declineReason ? `Grund: ${order.declineReason}` : 'Deine Bestellung wurde leider abgelehnt.',
        order.id);
    res.json(order);
});

// ── History delete ────────────────────────────────────────────────────────

router.delete('/api/orders/history', (req, res) => {
    const orders = loadOrders().filter(o => !['done', 'declined'].includes(o.status));
    saveOrders(orders);
    res.json({ ok: true });
});

router.delete('/api/orders/:id', (req, res) => {
    const orders = loadOrders();
    const order  = orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'not found' });
    if (!['done', 'declined'].includes(order.status)) return res.status(400).json({ error: 'can only delete completed orders' });
    saveOrders(orders.filter(o => o.id !== req.params.id));
    res.json({ ok: true });
});

module.exports = router;
