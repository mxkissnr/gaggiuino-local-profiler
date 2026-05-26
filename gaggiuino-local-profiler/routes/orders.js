const express = require('express');
const fs      = require('fs');
const router  = express.Router();

const { ANNOTATIONS_FILE, DATA_FILE } = require('../lib/constants');
const {
    loadOrders, saveOrders, loadMenu, saveMenu,
    loadOrdersSettings, saveOrdersSettings,
    loadNotifyMapping, saveNotifyMapping,
    loadAnnotations, loadTrash, isOrdersEnabled,
} = require('../lib/data');
const { sendHaNotify, getNotifyServices } = require('../lib/ha');
const { log, rateLimit, writeFileSafe } = require('../lib/helpers');

// Guard: all order routes require enable_orders: true
router.use((req, res, next) => {
    if (!isOrdersEnabled()) return res.status(404).json({ error: 'orders feature not enabled' });
    next();
});

// ── Menu ──────────────────────────────────────────────────────────────────

router.get('/api/orders/menu', (req, res) => res.json(loadMenu()));

router.post('/api/orders/menu', (req, res) => {
    const { name, emoji } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    const menu = loadMenu();
    const item = { id: `m_${Date.now()}`, name: name.trim(), emoji: emoji?.trim() || '☕' };
    menu.push(item);
    saveMenu(menu);
    res.json(item);
});

router.put('/api/orders/menu/:id', (req, res) => {
    const menu = loadMenu();
    const item = menu.find(m => m.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    if (req.body?.name?.trim())  item.name  = req.body.name.trim();
    if (req.body?.emoji?.trim()) item.emoji = req.body.emoji.trim();
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

// ── Settings ──────────────────────────────────────────────────────────────

router.get('/api/orders/settings', (req, res) => res.json(loadOrdersSettings()));

router.post('/api/orders/settings', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
    const s = { enabled: req.body.enabled };
    saveOrdersSettings(s);
    log(`Orders ${s.enabled ? 'enabled' : 'disabled'}`);
    res.json(s);
});

// ── Notify mapping ────────────────────────────────────────────────────────

router.get('/api/orders/notify-services', async (req, res) => {
    res.json(await getNotifyServices());
});

router.get('/api/orders/notify-mapping', (req, res) => {
    const orders    = loadOrders();
    const mapping   = loadNotifyMapping();
    const customers = {};
    orders.forEach(o => { if (o.haUserId) customers[o.haUserId] = o.customer; });
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
    const { item, note, customer } = req.body || {};
    if (!item || !customer?.trim()) return res.status(400).json({ error: 'item and customer required' });
    const menu = loadMenu();
    if (!menu.find(m => m.name === item)) return res.status(400).json({ error: 'unknown item' });

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
        note:      note ? String(note).slice(0, 200) : '',
        status:    'pending',
        eta: null, acceptedAt: null, completedAt: null, declineReason: null,
    };
    orders.push(order);
    saveOrders(orders);
    log(`Order ${order.id}: ${order.customer} → ${order.item}`);
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
    sendHaNotify(loadNotifyMapping()[order.haUserId],
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
            annotations[key] = { ...(annotations[key] || {}), orderedBy: { customer: order.customer, haUserId: order.haUserId, orderId: order.id } };
            writeFileSafe(ANNOTATIONS_FILE, annotations);
        } catch { /* non-critical */ }
    }
    saveOrders(orders);
    log(`Order ${order.id} done (shotId: ${order.shotId})`);
    sendHaNotify(loadNotifyMapping()[order.haUserId],
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
    sendHaNotify(loadNotifyMapping()[order.haUserId],
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
