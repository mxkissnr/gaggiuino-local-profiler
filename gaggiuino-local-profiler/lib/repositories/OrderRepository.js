const { getDb }              = require('../db');
const { DEFAULT_MENU, ORDERS_HISTORY_TTL_MS } = require('../constants');

class OrderRepository {
    findActive() {
        const db     = getDb();
        const cutoff = Date.now() - ORDERS_HISTORY_TTL_MS;
        const rows   = db.prepare('SELECT data FROM orders').all();
        return rows
            .map(r => JSON.parse(r.data))
            .filter(o =>
                ['pending', 'accepted'].includes(o.status) ||
                (o.completedAt && o.completedAt > cutoff)
            );
    }

    // Unlike findActive(), never filters done/declined orders by age — used
    // by /api/orders/stats (#321), which is labelled as lifetime customer
    // totals and must not silently drop anything older than the 7-day
    // ORDERS_HISTORY_TTL_MS window findActive() applies for the live queue.
    findAll() {
        const db   = getDb();
        const rows = db.prepare('SELECT data FROM orders').all();
        return rows.map(r => JSON.parse(r.data));
    }

    findById(id) {
        const db  = getDb();
        const row = db.prepare('SELECT data FROM orders WHERE id = ?').get(id);
        return row ? JSON.parse(row.data) : null;
    }

    save(order) {
        getDb().prepare('INSERT OR REPLACE INTO orders (id, data) VALUES (?,?)').run(order.id, JSON.stringify(order));
        return order;
    }

    saveAll(orders) {
        const db  = getDb();
        const ins = db.prepare('INSERT OR REPLACE INTO orders (id, data) VALUES (?,?)');
        db.transaction(() => {
            for (const o of orders) ins.run(o.id, JSON.stringify(o));
        })();
    }

    delete(id) {
        getDb().prepare('DELETE FROM orders WHERE id = ?').run(id);
    }

    getMenu() {
        const db  = getDb();
        const row = db.prepare("SELECT value FROM kv WHERE key = 'menu'").get();
        return row ? JSON.parse(row.value) : DEFAULT_MENU;
    }

    saveMenu(menu) {
        getDb().prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('menu', ?)").run(JSON.stringify(menu));
    }

    getSettings() {
        const db  = getDb();
        const row = db.prepare("SELECT value FROM kv WHERE key = 'orders_settings'").get();
        return row ? JSON.parse(row.value) : { enabled: true, broadcastRecipients: [] };
    }

    saveSettings(settings) {
        getDb().prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('orders_settings', ?)").run(JSON.stringify(settings));
    }

    getNotifyMapping() {
        const db  = getDb();
        const row = db.prepare("SELECT value FROM kv WHERE key = 'notify_mapping'").get();
        return row ? JSON.parse(row.value) : {};
    }

    saveNotifyMapping(mapping) {
        getDb().prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('notify_mapping', ?)").run(JSON.stringify(mapping));
    }
}

module.exports = new OrderRepository();
