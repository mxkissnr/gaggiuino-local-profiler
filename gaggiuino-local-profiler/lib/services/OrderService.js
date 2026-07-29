const repo            = require('../repositories/OrderRepository');
const shotRepo         = require('../repositories/ShotRepository');
const libraryService   = require('./LibraryService');
const machineRegistry  = require('../machines/registry');

const DEFAULT_PREP_TIME = 4; // minutes per order, used when no historical data

class OrderService {
    getActiveOrders()              { return repo.findActive(); }
    getAllOrders()                 { return repo.findAll(); }
    getOrder(id)                   { return repo.findById(id); }
    saveOrder(order)               { return repo.save(order); }
    getMenu()                      { return repo.getMenu(); }
    saveMenu(menu)                 { return repo.saveMenu(menu); }
    getSettings()                  { return repo.getSettings(); }
    saveSettings(s)                { return repo.saveSettings(s); }
    getNotifyMapping()             { return repo.getNotifyMapping(); }
    saveNotifyMapping(m)           { return repo.saveNotifyMapping(m); }
    isEnabled(opts)                { return !!opts?.enable_orders; }

    // #326: resolves an order's `machine` display name/slug (glp-order-card
    // #29) into the machine registry's actual numeric id, so orders are
    // genuinely scoped/attributed to a machine instead of only display-tagged.
    // Falls back to the default machine (never null) when the name doesn't
    // match any registered machine, or wasn't supplied at all — every existing
    // order (placed before #326, or from a single-machine setup that never
    // sets `machine`) resolves to the default machine, matching its own
    // machine_id column default of 1.
    resolveMachineId(machineName) {
        const fallback = machineRegistry.getDefaultMachine()?.id ?? 1;
        if (!machineName) return fallback;
        const needle = String(machineName).trim().toLowerCase();
        const match  = machineRegistry.listMachines().find(m => m.name.toLowerCase() === needle);
        return match ? match.id : fallback;
    }

    // Queue position + suggested ETA for every pending order, plus the
    // rolling prep-time estimate derived from the last 10 completed orders.
    // Pure over its `orders` input (already status/machine-filtered by the
    // caller) and `now` — no I/O, unit-testable without an HTTP round trip.
    computeQueueEta(orders, now = Date.now()) {
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

        return {
            acceptedRemaining: Math.round(acceptedRemaining * 10) / 10,
            pendingCount:      pending.length,
            prepTime:          Math.round(prepTime * 10) / 10,
            positions,
        };
    }

    // #563: resolves a client-supplied beanId (glp-order-card #35) against
    // the library's actual beans. A stale/fabricated id (deleted bean, or a
    // value invented by a buggy client) silently becomes null rather than
    // failing order placement — mirroring the card's own name-fallback
    // behavior when its cached bean list is stale.
    resolveBeanId(rawBeanId) {
        if (rawBeanId == null || rawBeanId === '') return null;
        const id = parseInt(rawBeanId, 10);
        if (!Number.isInteger(id)) return null;
        const beans = libraryService.getLibrary().beans || [];
        return beans.some(b => b.id === id) ? id : null;
    }

    // Builds and persists a new pending order. Caller (route) is responsible
    // for validating item/customer presence and that `item` names a real
    // menu entry before calling this — those are request-shape checks, not
    // order domain rules.
    placeOrder({ item, note, customer, notifyService, variant, machine, haUserId, beanId }) {
        const orders = repo.findActive();
        const order = {
            id: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            createdAt: Date.now(),
            customer:  String(customer).trim().slice(0, 50),
            haUserId,
            item,
            // Stable bean identity (glp-order-card #35, follow-up to #456) —
            // resolved against the library so orders never carry a bean id
            // that doesn't actually exist.
            beanId:         this.resolveBeanId(beanId),
            variant:        variant ? String(variant).trim().slice(0, 50) : null,
            note:           note ? String(note).slice(0, 200) : '',
            notifyService:  notifyService && String(notifyService).startsWith('notify.') ? String(notifyService).slice(0, 100) : null,
            // Machine target (glp-order-card #29 / #326) — `machine` stays the
            // display name/slug the card sent (or null); `machineId` is it
            // resolved against the registry, always a real id (falls back to
            // the default machine), used for actual fulfillment routing and
            // stats scoping.
            machine:   machine ? String(machine).trim().slice(0, 100) : null,
            machineId: this.resolveMachineId(machine),
            status:    'pending',
            eta: null, acceptedAt: null, completedAt: null, declineReason: null,
        };
        orders.push(order);
        repo.saveAll(orders);
        return order;
    }

    acceptOrder(id, rawEta) {
        const orders = repo.findActive();
        const order  = orders.find(o => o.id === id);
        if (!order) throw Object.assign(new Error('not found'), { status: 404 });
        if (order.status !== 'pending') throw Object.assign(new Error('not pending'), { status: 400 });
        order.status     = 'accepted';
        order.eta        = Math.max(1, Math.min(60, parseInt(rawEta) || 5));
        order.acceptedAt = Date.now();
        repo.saveAll(orders);
        return order;
    }

    // Complete-order lifecycle: status, milk stock deduction (variant is the
    // milk name), matching the latest shot on the order's own target machine
    // (#326 — never the global latest, so a busy second machine can't steal
    // fulfillment credit for another machine's order), and writing the
    // orderedBy annotation back onto that shot. Each side effect is
    // independently best-effort (non-critical) — a failure in one must not
    // stop the order from completing.
    completeOrder(id) {
        const orders = repo.findActive();
        const order  = orders.find(o => o.id === id);
        if (!order) throw Object.assign(new Error('not found'), { status: 404 });
        order.status      = 'done';
        order.completedAt = Date.now();
        if (order.variant) {
            try {
                const item = repo.getMenu().find(m => m.name === order.item);
                if (item?.milkMl > 0) libraryService.deductMilkByName(order.variant, item.milkMl);
            } catch { /* non-critical */ }
        }
        try { order.shotId = shotRepo.getLatestId(order.machineId); } catch { order.shotId = null; }
        if (order.shotId != null) {
            try {
                const annotation = shotRepo.getAnnotation(order.shotId);
                annotation.orderedBy = {
                    customer: order.customer, haUserId: order.haUserId, orderId: order.id,
                    item: order.item, variant: order.variant || null, note: order.note || null,
                };
                shotRepo.saveAnnotation(order.shotId, annotation);
            } catch { /* non-critical */ }
        }
        repo.saveAll(orders);
        return order;
    }

    declineOrder(id, rawReason) {
        const orders = repo.findActive();
        const order  = orders.find(o => o.id === id);
        if (!order) throw Object.assign(new Error('not found'), { status: 404 });
        if (!['pending', 'accepted'].includes(order.status)) throw Object.assign(new Error('cannot decline'), { status: 400 });
        order.status        = 'declined';
        order.declineReason = String(rawReason || '').slice(0, 200);
        order.completedAt   = Date.now();
        repo.saveAll(orders);
        return order;
    }
}

module.exports = new OrderService();
