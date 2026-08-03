// #603: per-notification-type mute toggles (notify_new_order,
// notify_order_status, notify_shop_state) stored in the orders settings
// blob. Same in-memory DB / enable_orders-forced-on harness as
// test/db-routes.test.js.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const Database  = require('better-sqlite3');
const dbPath    = require.resolve('../lib/db');
const realDb    = require(dbPath);
const memDb     = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

const dataPath = require.resolve('../lib/data');
const realData = require(dataPath);
require.cache[dataPath].exports = { ...realData, isOrdersEnabled: () => true };

const haPath = require.resolve('../lib/ha');
const realHa = require(haPath);
const sendHaNotify = vi.fn(async () => {});
require.cache[haPath].exports = { ...realHa, sendHaNotify, getNotifyServices: async () => [], getHaPersons: async () => [] };

const express      = require('express');
const ordersRouter = require('../routes/orders');
const { saveOrders, saveMenu } = require('../lib/data');
const { getDb }     = require('../lib/db');

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(ordersRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl;

async function postSettings(body) {
    return fetch(`${baseUrl}/api/orders/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, ...body }),
    });
}

beforeEach(async () => {
    getDb().exec('DELETE FROM orders; DELETE FROM kv;');
    sendHaNotify.mockClear();
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

describe('POST /api/orders/settings — notify toggles', () => {
    it('persists all 5 toggle keys and round-trips them on GET', async () => {
        await postSettings({
            notify_preheat_ready: false, notify_low_stock: false, notify_shop_state: false,
            notify_new_order: false, notify_order_status: false,
        });
        const settings = await (await fetch(`${baseUrl}/api/orders/settings`)).json();
        expect(settings.notify_preheat_ready).toBe(false);
        expect(settings.notify_low_stock).toBe(false);
        expect(settings.notify_shop_state).toBe(false);
        expect(settings.notify_new_order).toBe(false);
        expect(settings.notify_order_status).toBe(false);
    });

    it('leaves toggles untouched when omitted from the request body', async () => {
        await postSettings({ notify_new_order: false });
        await postSettings({ broadcastRecipients: [] }); // unrelated save, no toggle keys sent
        const settings = await (await fetch(`${baseUrl}/api/orders/settings`)).json();
        expect(settings.notify_new_order).toBe(false); // still off, not reset to default
    });
});

describe('POST /api/orders — new-order notification (notify_new_order)', () => {
    beforeEach(async () => {
        saveMenu([{ id: 'm1', name: 'Espresso', emoji: '☕' }]);
        await postSettings({ baristaNotifyService: 'notify.mobile_app_barista' });
    });

    it('notifies the barista by default (undefined toggle == on)', async () => {
        const r = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item: 'Espresso', customer: 'Max' }),
        });
        expect(r.status).toBe(200);
        expect(sendHaNotify).toHaveBeenCalledTimes(1);
        expect(sendHaNotify.mock.calls[0][0]).toBe('notify.mobile_app_barista');
    });

    it('stays silent once notify_new_order is turned off', async () => {
        await postSettings({ baristaNotifyService: 'notify.mobile_app_barista', notify_new_order: false });
        const r = await fetch(`${baseUrl}/api/orders`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item: 'Espresso', customer: 'Max' }),
        });
        expect(r.status).toBe(200);
        expect(sendHaNotify).not.toHaveBeenCalled();
    });
});

describe('order status notifications (notify_order_status)', () => {
    it('notifies the customer on accept by default', async () => {
        saveOrders([{ id: 'ordA', item: 'Espresso', customer: 'Max', notifyService: 'notify.mobile_app_max', status: 'pending', createdAt: Date.now() }]);
        const r = await fetch(`${baseUrl}/api/orders/ordA/accept`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eta: 5 }),
        });
        expect(r.status).toBe(200);
        expect(sendHaNotify).toHaveBeenCalledTimes(1);
        expect(sendHaNotify.mock.calls[0][0]).toBe('notify.mobile_app_max');
    });

    it('stays silent on accept/complete/decline once notify_order_status is off', async () => {
        await postSettings({ notify_order_status: false });
        saveOrders([
            { id: 'ordB', item: 'Espresso', customer: 'Max', notifyService: 'notify.mobile_app_max', status: 'pending', createdAt: Date.now() },
        ]);
        const accept = await fetch(`${baseUrl}/api/orders/ordB/accept`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eta: 5 }),
        });
        expect(accept.status).toBe(200);
        expect(sendHaNotify).not.toHaveBeenCalled();

        const complete = await fetch(`${baseUrl}/api/orders/ordB/complete`, { method: 'POST' });
        expect(complete.status).toBe(200);
        expect(sendHaNotify).not.toHaveBeenCalled();
    });

    it('stays silent on decline once notify_order_status is off', async () => {
        await postSettings({ notify_order_status: false });
        saveOrders([{ id: 'ordC', item: 'Espresso', customer: 'Max', notifyService: 'notify.mobile_app_max', status: 'pending', createdAt: Date.now() }]);
        const r = await fetch(`${baseUrl}/api/orders/ordC/decline`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'sold out' }),
        });
        expect(r.status).toBe(200);
        expect(sendHaNotify).not.toHaveBeenCalled();
    });
});

describe('shop-state broadcast (notify_shop_state)', () => {
    it('broadcasts shop-opened by default when orders get enabled with recipients', async () => {
        await postSettings({ enabled: false, broadcastRecipients: [] }); // baseline: disabled, no recipients
        const r = await fetch(`${baseUrl}/api/orders/settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true, broadcastRecipients: ['notify.mobile_app_guest'] }),
        });
        expect(r.status).toBe(200);
        await new Promise(resolve => setTimeout(resolve, 0)); // let the fire-and-forget broadcast settle
        expect(sendHaNotify).toHaveBeenCalledTimes(1);
        expect(sendHaNotify.mock.calls[0][0]).toBe('notify.mobile_app_guest');
    });

    it('stays silent once notify_shop_state is off', async () => {
        await postSettings({ enabled: false, broadcastRecipients: [], notify_shop_state: false });
        const r = await fetch(`${baseUrl}/api/orders/settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true, broadcastRecipients: ['notify.mobile_app_guest'], notify_shop_state: false }),
        });
        expect(r.status).toBe(200);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(sendHaNotify).not.toHaveBeenCalled();
    });
});
