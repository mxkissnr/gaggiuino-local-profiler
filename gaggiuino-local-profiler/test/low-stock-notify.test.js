import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// In-memory DB swap (same pattern as db-routes.test.js)
const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

// Spy on the HA notify channel and force a configured barista device
const haPath = require.resolve('../lib/ha');
const realHa = require(haPath);
const sendHaNotify = vi.fn(async () => {});
require.cache[haPath].exports = { ...realHa, sendHaNotify, getHaLanguage: async () => 'de' };

const dataPath = require.resolve('../lib/data');
const realData = require(dataPath);
require.cache[dataPath].exports = { ...realData, loadOrdersSettings: () => ({ baristaNotifyService: 'notify.mobile_app_test' }) };

const libraryService = require('../lib/services/LibraryService');
const shotRepo       = require('../lib/repositories/ShotRepository');
const { getDb }      = require('../lib/db');

function seed({ stock = 120, doses = [] }) {
    libraryService.saveLibrary({
        beans: [{ id: 1, name: 'Lucky Punch', stock_g: stock,
                  bags: [{ id: 10, roastDate: '2026-06-20', stock_g: stock, openedAt: 0 }] }],
        grinders: [], recipes: [],
    });
    shotRepo.upsertMany(doses.map((_, i) => ({ id: i + 1, timestamp: 1000 + i, duration: 250 })));
    doses.forEach((d, i) => shotRepo.saveAnnotation(i + 1, { coffee: 'lucky punch', dose: String(d) }));
}

beforeEach(() => {
    getDb().exec('DELETE FROM shots; DELETE FROM annotations; DELETE FROM library;');
    sendHaNotify.mockClear();
});

describe('checkLowStockNotify', () => {
    it('stays silent while remaining is above the threshold', async () => {
        seed({ stock: 120, doses: [18] }); // remaining 102
        await libraryService.checkLowStockNotify('Lucky Punch');
        expect(sendHaNotify).not.toHaveBeenCalled();
    });

    it('notifies exactly once per bag when remaining drops below 100 g', async () => {
        seed({ stock: 120, doses: [18, 18] }); // remaining 84
        await libraryService.checkLowStockNotify('Lucky Punch');
        await libraryService.checkLowStockNotify('Lucky Punch');
        expect(sendHaNotify).toHaveBeenCalledTimes(1);
        const [svc, title, body] = sendHaNotify.mock.calls[0];
        expect(svc).toBe('notify.mobile_app_test');
        expect(title).toContain('Bohne fast leer');
        expect(body).toContain('Lucky Punch');
        expect(body).toContain('84 g');
        // notified flag persisted on the active bag
        const bean = libraryService.getLibrary().beans[0];
        expect(bean.bags[0].lowStockNotifiedAt).toBeGreaterThan(0);
    });

    it('re-arms when a new bag is opened', async () => {
        seed({ stock: 120, doses: [18, 18] });
        await libraryService.checkLowStockNotify('Lucky Punch');
        expect(sendHaNotify).toHaveBeenCalledTimes(1);

        // new 60 g bag opened now; one 18 g shot after opening → remaining 42
        const lib = libraryService.getLibrary();
        lib.beans[0].bags.push({ id: 11, roastDate: '2026-07-01', stock_g: 60, openedAt: Date.now() - 1000 });
        lib.beans[0].stock_g = 60;
        libraryService.saveLibrary(lib);
        shotRepo.upsert({ id: 99, timestamp: Math.floor(Date.now() / 1000), duration: 250 });
        shotRepo.saveAnnotation(99, { coffee: 'Lucky Punch', dose: '18' });

        await libraryService.checkLowStockNotify('Lucky Punch');
        expect(sendHaNotify).toHaveBeenCalledTimes(2);
    });

    it('ignores unknown beans and beans without stock tracking', async () => {
        seed({ stock: 120, doses: [] });
        await libraryService.checkLowStockNotify('Nonexistent');
        libraryService.saveLibrary({ beans: [{ id: 2, name: 'Untracked' }], grinders: [], recipes: [] });
        await libraryService.checkLowStockNotify('Untracked');
        expect(sendHaNotify).not.toHaveBeenCalled();
    });
});
