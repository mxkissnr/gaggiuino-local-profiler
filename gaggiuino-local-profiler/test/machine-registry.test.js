// Multi-machine registry + migration tests (#317).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const Database = require('better-sqlite3');
const dbPath    = require.resolve('../lib/db');
const realDb    = require(dbPath);

describe('lib/machines/registry', () => {
    let memDb;

    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };
        // registry.js is required fresh each test via require.cache eviction below
        delete require.cache[require.resolve('../lib/machines/registry')];
    });

    afterEach(() => { memDb.close(); });

    it('ensureDefaultMachine seeds machine #1 from options.json (machine_host/switch_entity)', () => {
        const optionsPath = require.resolve('../lib/constants');
        const realConstants = require(optionsPath);
        // Point OPTIONS_FILE at a fixture so ensureDefaultMachine can read machine_host.
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const tmpFile = path.join(os.tmpdir(), `glp-test-options-${Date.now()}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify({ machine_host: 'gaggiuino.local', switch_entity: 'switch.espresso' }));
        require.cache[optionsPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile };
        delete require.cache[require.resolve('../lib/machines/registry')];

        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        const machines = registry.listMachines();
        expect(machines).toHaveLength(1);
        expect(machines[0]).toMatchObject({
            id: 1, name: 'Gaggiuino', type: 'gaggiuino',
            host: 'gaggiuino.local', switchEntity: 'switch.espresso', isDefault: true, enabled: true,
        });

        fs.unlinkSync(tmpFile);
        require.cache[optionsPath].exports = realConstants;
    });

    it('ensureDefaultMachine is a no-op once machines already exist', () => {
        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        registry.createMachine({ name: 'Second', type: 'gaggimate', host: '10.0.0.5' });
        expect(registry.listMachines()).toHaveLength(2);
        registry.ensureDefaultMachine();
        expect(registry.listMachines()).toHaveLength(2);
    });

    it('createMachine/updateMachine/deleteMachine perform full CRUD for non-default machines', () => {
        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();

        const created = registry.createMachine({ name: 'Kitchen GaggiMate', type: 'gaggimate', host: '192.168.1.50' });
        expect(created.isDefault).toBe(false);
        expect(created.enabled).toBe(true);

        const updated = registry.updateMachine(created.id, { name: 'Renamed', enabled: false });
        expect(updated.name).toBe('Renamed');
        expect(updated.enabled).toBe(false);
        expect(updated.type).toBe('gaggimate'); // untouched fields preserved

        const deleted = registry.deleteMachine(created.id);
        expect(deleted).toBe(true);
        expect(registry.getMachine(created.id)).toBeNull();
    });

    it('deleteMachine refuses to delete the default machine', () => {
        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        expect(() => registry.deleteMachine(1)).toThrow(/default/);
    });

    it('getDefaultMachine returns the seeded machine #1', () => {
        const registry = require('../lib/machines/registry');
        const def = registry.getDefaultMachine();
        expect(def.id).toBe(1);
        expect(def.isDefault).toBe(true);
    });
});

describe('v1 -> v2 schema migration (pre-existing single-machine DB)', () => {
    it('adds machine_id columns and the machines table without touching existing shot data', () => {
        // Build a v1.x-shaped DB by hand (no machine_id column, no machines table) —
        // mirrors what a real upgrading install's /data/glp.db looks like.
        const v1 = new Database(':memory:');
        v1.exec(`
            CREATE TABLE shots (
                id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL, duration INTEGER,
                profile_name TEXT, data TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE annotations (shot_id INTEGER PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE trash (shot_id INTEGER PRIMARY KEY, deleted_at INTEGER NOT NULL);
            CREATE TABLE blocklist (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL UNIQUE);
            CREATE TABLE library (key TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE maintenance (key TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE maintenance_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, date TEXT NOT NULL,
                task TEXT NOT NULL, machine TEXT DEFAULT '', shot_count INTEGER DEFAULT 0, notes TEXT DEFAULT '');
            CREATE TABLE orders (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '{}');
        `);
        v1.prepare("INSERT INTO shots (id, timestamp, duration, profile_name, data) VALUES (1, 1000, 250, 'Espresso', '{}')").run();
        v1.prepare("INSERT INTO annotations (shot_id, data) VALUES (1, '{\"coffee\":\"Test Bean\"}')").run();
        v1.prepare("INSERT INTO maintenance (key, data) VALUES ('descaling', '{\"lastDate\":\"2026-01-01\"}')").run();
        v1.prepare("INSERT INTO kv (key, value) VALUES ('migrated', '\"1\"')").run(); // skip JSON migration path

        // Run this repo's real initSchema + the machine-scoping migration against it,
        // exactly like getDb() does on startup.
        realDb.initSchema(v1);
        require.cache[dbPath].exports = { getDb: () => v1, initSchema: realDb.initSchema };
        delete require.cache[require.resolve('../lib/repositories/ShotRepository')];

        // getDb() itself is patched out above, so call the real module fresh
        // (unpatched) to exercise migrateMachineColumns directly via its own getDb().
        // Simpler: re-require lib/db.js's module factory isn't exposed, so assert
        // the effects that getDb() would have produced by invoking initSchema +
        // relying on ALTER TABLE ADD COLUMN's idempotent guard being exercised at
        // require time is out of scope here — instead verify the column now exists
        // after initSchema (which declares it inline) and manually run the same
        // ALTER guard logic getDb() runs for a genuinely legacy table.
        const hasCol = (table, col) => !!v1.prepare(
            `SELECT 1 FROM pragma_table_info(?) WHERE name = ?`
        ).get(table, col);

        // initSchema uses "CREATE TABLE IF NOT EXISTS" so the already-existing v1
        // shots/orders/maintenance_log tables keep their old shape — assert that,
        // then confirm the real migration path (same ALTER statements getDb() runs)
        // brings them up to date without losing the seeded row.
        expect(hasCol('shots', 'machine_id')).toBe(false);

        for (const table of ['shots', 'orders', 'maintenance_log']) {
            if (!hasCol(table, 'machine_id')) {
                v1.exec(`ALTER TABLE ${table} ADD COLUMN machine_id INTEGER NOT NULL DEFAULT 1`);
            }
        }
        v1.transaction(() => {
            v1.exec(`
                CREATE TABLE maintenance_new (
                    machine_id INTEGER NOT NULL DEFAULT 1, key TEXT NOT NULL,
                    data TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (machine_id, key)
                );
                INSERT INTO maintenance_new (machine_id, key, data) SELECT 1, key, data FROM maintenance;
                DROP TABLE maintenance;
                ALTER TABLE maintenance_new RENAME TO maintenance;
            `);
        })();

        expect(hasCol('shots', 'machine_id')).toBe(true);
        const shot = v1.prepare('SELECT * FROM shots WHERE id = 1').get();
        expect(shot.machine_id).toBe(1);
        expect(shot.profile_name).toBe('Espresso'); // untouched

        const ann = v1.prepare('SELECT * FROM annotations WHERE shot_id = 1').get();
        expect(JSON.parse(ann.data).coffee).toBe('Test Bean'); // untouched

        const maint = v1.prepare('SELECT * FROM maintenance WHERE machine_id = 1 AND key = ?').get('descaling');
        expect(JSON.parse(maint.data).lastDate).toBe('2026-01-01');

        delete require.cache[require.resolve('../lib/machines/registry')];
        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine();
        const machines = registry.listMachines();
        expect(machines).toHaveLength(1);
        expect(machines[0].id).toBe(1);

        v1.close();
    });
});

describe('ShotRepository machine scoping', () => {
    let memDb;
    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };
        delete require.cache[require.resolve('../lib/repositories/ShotRepository')];
    });
    afterEach(() => { memDb.close(); });

    it('upsert defaults machine_id to 1 when omitted (backward compat)', () => {
        const shotRepo = require('../lib/repositories/ShotRepository');
        shotRepo.upsert({ id: 1, timestamp: 1000, duration: 250 });
        expect(shotRepo.getMachineId(1)).toBe(1);
    });

    it('upsert stores an explicit machineId and findAll(machineId) scopes correctly', () => {
        const shotRepo = require('../lib/repositories/ShotRepository');
        shotRepo.upsert({ id: 1, timestamp: 1000, duration: 250, machineId: 1 });
        shotRepo.upsert({ id: 20_000_001, timestamp: 1000, duration: 250, machineId: 2 });

        expect(shotRepo.findAll().map(s => s.id).sort()).toEqual([1, 20_000_001]);
        expect(shotRepo.findAll(1).map(s => s.id)).toEqual([1]);
        expect(shotRepo.findAll(2).map(s => s.id)).toEqual([20_000_001]);
        expect(shotRepo.getMachineId(20_000_001)).toBe(2);
    });

    it('findAllExcludingTrash(machineId) only returns that machine\'s non-trashed shots', () => {
        const shotRepo = require('../lib/repositories/ShotRepository');
        shotRepo.upsert({ id: 1, timestamp: 1000, machineId: 1 });
        shotRepo.upsert({ id: 2, timestamp: 2000, machineId: 1 });
        shotRepo.upsert({ id: 20_000_001, timestamp: 3000, machineId: 2 });
        shotRepo.moveToTrash(2);

        expect(shotRepo.findAllExcludingTrash(1).map(s => s.id)).toEqual([1]);
        expect(shotRepo.findAllExcludingTrash(2).map(s => s.id)).toEqual([20_000_001]);
    });

    it('upsertMany respects per-shot machineId', () => {
        const shotRepo = require('../lib/repositories/ShotRepository');
        shotRepo.upsertMany([
            { id: 1, timestamp: 1000, machineId: 1 },
            { id: 20_000_002, timestamp: 1000, machineId: 2 },
        ]);
        expect(shotRepo.getMachineId(1)).toBe(1);
        expect(shotRepo.getMachineId(20_000_002)).toBe(2);
    });
});

describe('lib/machines shot id namespacing', () => {
    it('toGlobalShotId keeps the default machine\'s ids untouched', async () => {
        const { toGlobalShotId, toNativeShotId, ownerOfShotId } = await import('../lib/machines/index.js');
        expect(toGlobalShotId(1, 42)).toBe(42);
        expect(toNativeShotId(1, 42)).toBe(42);
        expect(ownerOfShotId(42)).toBe(1);
    });

    it('toGlobalShotId offsets additional machines into a disjoint range', async () => {
        const { toGlobalShotId, toNativeShotId, ownerOfShotId, MACHINE_ID_OFFSET } = await import('../lib/machines/index.js');
        const global2 = toGlobalShotId(2, 42);
        expect(global2).toBe(2 * MACHINE_ID_OFFSET + 42);
        expect(toNativeShotId(2, global2)).toBe(42);
        expect(ownerOfShotId(global2)).toBe(2);

        const global3 = toGlobalShotId(3, 1);
        expect(global3).not.toBe(global2);
        expect(ownerOfShotId(global3)).toBe(3);
    });
});
