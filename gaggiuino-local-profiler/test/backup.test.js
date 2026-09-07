import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
const require = createRequire(import.meta.url);

// The backend is CommonJS (require-based), so vi.mock's ESM interception doesn't
// reach it here. Patch the require cache for lib/db.js directly instead — every
// consumer (routes/backup.js, ShotRepository.js, ...) resolves the same relative
// path to the same absolute file and shares Node's module cache, so overwriting
// the cached exports object before anything else is required swaps in an
// in-memory database for the whole test file.
const Database  = require('better-sqlite3');
const dbPath    = require.resolve('../lib/db');
const realDb    = require(dbPath);
const memDb     = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

// #635: the restore route rate-limits at 3/min per IP — plenty for real
// usage, but this file's own test count exceeds it (same 127.0.0.1 for every
// call). Patch it permissive here, same require-cache-swap trick as the db
// patch above, rather than trim test coverage to fit the limit.
const helpersPath = require.resolve('../lib/helpers');
const realHelpers = require(helpersPath);
require.cache[helpersPath].exports = { ...realHelpers, rateLimit: () => true };

// Redirects bean/grinder image storage to a scratch dir for the image-restore
// tests, same pattern test/bean-image.test.js uses. Must happen before
// routes/backup.js and lib/services/ImageService.js are first required below,
// since both capture BEAN_IMAGE_DIR at module-load time.
const imageTmpDir  = mkdtempSync(path.join(tmpdir(), 'glp-backup-images-'));
const constantsPath = require.resolve('../lib/constants');
const realConstants = require(constantsPath);
require.cache[constantsPath].exports = { ...realConstants, BEAN_IMAGE_DIR: imageTmpDir };

const express       = require('express');
const backupRouter  = require('../routes/backup');
const shotRepo       = require('../lib/repositories/ShotRepository');
const libService     = require('../lib/services/LibraryService');
const libraryRepo    = require('../lib/repositories/LibraryRepository');
const orderRepo      = require('../lib/repositories/OrderRepository');
const registry        = require('../lib/machines/registry');
const mqttSettingsRepo = require('../lib/repositories/MqttSettingsRepository');
const { imagePath }  = require('../lib/services/ImageService');
const { getDb }      = require('../lib/db');
const state          = require('../lib/state');
const { readZip }    = require('../lib/zip');
const { bus, EVENTS } = require('../lib/events');
const achievementService = require('../lib/services/AchievementService');
const achievementRepo    = require('../lib/repositories/AchievementRepository');

// #978: wired once (mirrors server.js's single boot-time init() call) so the
// bulk-restore test below can observe how many times a real restore through
// the actual route triggers achievement re-evaluation.
achievementService.init();

function makeApp() {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(express.raw({ type: 'application/zip', limit: '50mb' }));
    app.use(backupRouter);
    app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
}

let server, baseUrl;

beforeEach(async () => {
    getDb().exec(`
        DELETE FROM shots; DELETE FROM annotations; DELETE FROM trash; DELETE FROM blocklist;
        DELETE FROM machines; DELETE FROM orders; DELETE FROM maintenance; DELETE FROM maintenance_log;
        DELETE FROM kv WHERE key IN ('menu', 'orders_settings', 'notify_mapping', 'import_settings', 'mqtt_settings');
    `);
    server = makeApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
    server?.close();
    rmSync(imageTmpDir, { recursive: true, force: true });
});

async function restore(body) {
    return fetch(`${baseUrl}/api/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
}

async function backup() {
    const r = await fetch(`${baseUrl}/api/backup`);
    return r.json();
}

// POST /api/backup now returns a zip (backup.json + real image files, see
// buildBackupZip()) rather than a single JSON object. Most existing tests in
// this file only care about the metadata (shots/orders/secrets/...), so this
// helper unzips and returns the parsed backup.json content -- same shape
// `backupPost()` always returned, letting those tests stay unchanged.
// `backupPostZip()` below is for the tests that need the raw zip/images.
async function backupPostZip(body = {}) {
    const r = await fetch(`${baseUrl}/api/backup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const entries = readZip(Buffer.from(await r.arrayBuffer()));
    const bundle  = JSON.parse(entries['backup.json'].toString('utf8'));
    const images  = {};
    for (const [name, buf] of Object.entries(entries)) {
        if (name.startsWith('images/')) images[name.slice('images/'.length)] = buf;
    }
    return { bundle, images };
}

async function backupPost(body = {}) {
    return (await backupPostZip(body)).bundle;
}

// Posts a zip body to /api/restore the way the real export → restore round
// trip works: sections/passphrase/dryRun travel as headers (see
// normaliseRestoreRequest() in routes/backup.js for why never a URL query),
// never inside the binary body.
async function restoreZip(zipBuffer, { sections, passphrase, dryRun } = {}) {
    const headers = { 'Content-Type': 'application/zip' };
    if (sections !== undefined) headers['X-GLP-Sections'] = JSON.stringify(sections);
    if (passphrase !== undefined) headers['X-GLP-Passphrase'] = passphrase;
    if (dryRun) headers['X-GLP-Dry-Run'] = 'true';
    return fetch(`${baseUrl}/api/restore`, { method: 'POST', headers, body: zipBuffer });
}

// A single valid PNG signature (8 bytes) plus filler — matchesImageMagicBytes()
// only sniffs the header, so this is enough to pass without a real image.
const VALID_PNG_B64 = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.from([0, 0, 0, 0]),
]).toString('base64');

function seedOneShot() {
    shotRepo.upsert({ id: 1, timestamp: 1700000000, duration: 250, profile_name: 'Test Profile' });
}

describe('POST /api/restore', () => {
    it('rejects a shot with a missing timestamp and leaves existing data intact', async () => {
        seedOneShot();
        const bad = {
            glp_backup: true,
            shots: [{ id: 2, duration: 100 }], // no timestamp
        };
        const r = await fetch(`${baseUrl}/api/restore`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bad),
        });
        expect(r.status).toBe(400);
        const body = await r.json();
        expect(body.error).toMatch(/shot #0.*timestamp/i);

        // Core regression check: the wipe must not have committed before the failure.
        const remaining = shotRepo.findAll();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].id).toBe(1);
    });

    it('rejects a shot with an invalid id and names the offending shot', async () => {
        seedOneShot();
        const bad = {
            glp_backup: true,
            shots: [
                { id: 1, timestamp: 1700000000 },
                { id: 0, timestamp: 1700000001 },
            ],
        };
        const r = await fetch(`${baseUrl}/api/restore`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bad),
        });
        expect(r.status).toBe(400);
        const body = await r.json();
        expect(body.error).toMatch(/shot #1.*id/i);
        expect(shotRepo.findAll()).toHaveLength(1);
    });

    it('restores successfully with a fully valid backup', async () => {
        seedOneShot();
        const good = {
            glp_backup: true,
            shots: [
                { id: 5, timestamp: 1700000100, duration: 200, profile_name: 'Restored' },
                { id: 6, timestamp: 1700000200, duration: 220, profile_name: 'Restored 2' },
            ],
            annotations: {}, blocklist: [],
        };
        const r = await fetch(`${baseUrl}/api/restore`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(good),
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.ok).toBe(true);
        expect(body.shots).toBe(2);

        const remaining = shotRepo.findAll().map(s => s.id).sort();
        expect(remaining).toEqual([5, 6]);
    });

    // #978: restoring a large backup into a non-empty install used to emit
    // SHOT_SAVED once per restored shot, which triggered a full achievement
    // context rebuild + every badge's check() that many times over -- a
    // synchronous O(n^2) storm that blocked the event loop long enough for
    // the Supervisor watchdog to kill the process mid-transaction (losing
    // the entire restore, since it's one atomic transaction). This asserts
    // both halves of the fix: achievements are still evaluated (not simply
    // dropped), but only once for the whole restore, no matter how many
    // shots it contains.
    it('evaluates achievements exactly once for a large bulk restore, not once per shot', async () => {
        seedOneShot();
        getDb().exec('DELETE FROM achievements');

        let evaluateCalls = 0;
        const onShotSaved = () => { evaluateCalls++; };
        bus.on(EVENTS.SHOT_SAVED, onShotSaved);

        const N = 500;
        const shots = [];
        for (let i = 1; i <= N; i++) shots.push({ id: i, timestamp: 1700000000 + i, duration: 200 });
        const good = { glp_backup: true, shots };

        try {
            const r = await restore(good);
            expect(r.status).toBe(200);
            const body = await r.json();
            expect(body.shots).toBe(N);
        } finally {
            bus.off(EVENTS.SHOT_SAVED, onShotSaved);
        }

        expect(shotRepo.findAll()).toHaveLength(N);
        // Exactly one SHOT_SAVED for the whole restore (this listener plus
        // AchievementService's own — evaluateCalls only counts this test's).
        expect(evaluateCalls).toBe(1);
        // And achievements actually did get (re-)evaluated against the
        // restored state, not merely skipped.
        expect(Object.keys(achievementRepo.getAll()).length).toBeGreaterThan(0);
    });

    // #635: milks used to be the one library entity NOT sanitized on restore
    // (bug/inconsistency — beans/grinders/recipes already were); fixed
    // alongside adding baskets/puckScreens sanitization.
    it('sanitizes milks, baskets and puckScreens the same way beans/grinders/recipes already are', async () => {
        seedOneShot();
        const backup = {
            glp_backup: true,
            shots: [{ id: 5, timestamp: 1700000100, duration: 200 }],
            coffee_library: {
                milks: [{ id: 1, name: '  Oat  '.padEnd(150, 'x'), emoji: 'not-an-emoji-way-too-long', stockMl: -50 }],
                baskets: [{ id: 2, name: 'IMS Precision', wallType: 'not-a-real-type', shape: 'also-fake', notes: 'x'.repeat(2000) }],
                puckScreens: [{ id: 3, name: 'Slayer mesh', thickness: 'ultra-thick', material: 'x'.repeat(300) }],
            },
        };
        const r = await fetch(`${baseUrl}/api/restore`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup),
        });
        expect(r.status).toBe(200);

        const lib = libService.getLibrary();
        expect(lib.milks[0].name.length).toBeLessThanOrEqual(100);
        expect(lib.milks[0].stockMl).toBe(0); // negative value rejected, falls back to 0
        expect(lib.baskets[0].wallType).toBe(''); // out-of-whitelist value dropped
        expect(lib.baskets[0].shape).toBe('');
        expect(lib.baskets[0].notes.length).toBeLessThanOrEqual(1000);
        expect(lib.puckScreens[0].thickness).toBe(''); // out-of-whitelist value dropped
        expect(lib.puckScreens[0].material.length).toBeLessThanOrEqual(200);
    });
});

// Backup used to export only 5 of the app's 10 tables: maintenance,
// maintenance_log, orders, machines and the kv settings table were silently
// dropped, so restoring a backup silently discarded all of it. These tests
// round-trip each of the newly-included blocks.
describe('Backup export/restore round-trip', () => {
    it('round-trips maintenance and maintenance_log', async () => {
        libraryRepo.restoreMaintenanceRaw([
            { machineId: 1, key: 'descaling', data: { lastDate: '2026-07-01', threshold_shots: 200, threshold_days: 60, machineSyncedAt: null } },
        ]);
        libraryRepo.restoreMaintenanceLogRaw([
            { id: 1, ts: 1700000000000, date: '2026-07-01', task: 'descaling', machine: 'Gaggiuino', shotCount: 150, notes: 'routine', machineId: 1 },
        ]);

        const b = await backup();
        expect(b.maintenance).toEqual([{ machineId: 1, key: 'descaling', data: { lastDate: '2026-07-01', threshold_shots: 200, threshold_days: 60, machineSyncedAt: null } }]);
        expect(b.maintenance_log).toHaveLength(1);
        expect(b.maintenance_log[0]).toMatchObject({ id: 1, task: 'descaling', shotCount: 150, machineId: 1 });

        // Wipe, then restore from the exported bundle -- a real round trip,
        // not just re-feeding the same fixture back in.
        getDb().exec('DELETE FROM maintenance; DELETE FROM maintenance_log;');
        const r = await restore({ glp_backup: true, shots: [], ...b });
        expect(r.status).toBe(200);

        expect(libraryRepo.getAllMaintenanceRaw()).toEqual([
            { machineId: 1, key: 'descaling', data: { lastDate: '2026-07-01', threshold_shots: 200, threshold_days: 60, machineSyncedAt: null } },
        ]);
        expect(libraryRepo.getAllMaintenanceLogRaw()).toHaveLength(1);
    });

    it('round-trips orders', async () => {
        orderRepo.replaceAll([{
            id: 'order-1', status: 'pending', item: 'Flat White', customer: 'Max', note: '',
            variant: null, notifyService: null, declineReason: null, haUserId: null, machine: null,
            createdAt: 1700000000000, completedAt: null, acceptedAt: null, eta: null,
            machineId: 1, beanId: null, shotId: null,
        }]);

        const b = await backup();
        expect(b.orders).toHaveLength(1);
        expect(b.orders[0]).toMatchObject({ id: 'order-1', status: 'pending', item: 'Flat White' });

        getDb().exec('DELETE FROM orders;');
        const r = await restore({ glp_backup: true, shots: [], ...b });
        expect(r.status).toBe(200);

        const restored = orderRepo.findAll();
        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({ id: 'order-1', status: 'pending', item: 'Flat White' });
    });

    it('round-trips machines, preserving ids and the single default flag', async () => {
        registry.createMachine({ name: 'Gaggiuino', type: 'gaggiuino', host: 'gaggiuino.local', switchEntity: 'switch.espresso' });
        registry.createMachine({ name: 'GaggiMate', type: 'gaggimate', host: 'gaggimate.local' });

        const b = await backup();
        expect(b.machines).toHaveLength(2);
        const originalIds = b.machines.map(m => m.id).sort();

        getDb().exec('DELETE FROM machines;');
        const r = await restore({ glp_backup: true, shots: [], ...b });
        expect(r.status).toBe(200);

        const restored = registry.listMachines();
        expect(restored.map(m => m.id).sort()).toEqual(originalIds);
        expect(restored.filter(m => m.isDefault)).toHaveLength(1);
        const gaggiuino = restored.find(m => m.name === 'Gaggiuino');
        expect(gaggiuino.switchEntity).toBe('switch.espresso');
    });

    it('corrects a restored machine set with zero or multiple default flags to exactly one', async () => {
        // Two isDefault:true rows -- a hand-edited or corrupted backup file,
        // not something GET /api/backup itself would ever produce.
        const r = await restore({
            glp_backup: true, shots: [],
            machines: [
                { id: 1, name: 'A', type: 'gaggiuino', host: 'a.local', isDefault: true },
                { id: 2, name: 'B', type: 'gaggiuino', host: 'b.local', isDefault: true },
            ],
        });
        expect(r.status).toBe(200);
        expect(registry.listMachines().filter(m => m.isDefault)).toHaveLength(1);
    });

    it('round-trips settings (menu, orders_settings, notify_mapping, import_settings) via kv', async () => {
        const b0 = await backup();
        expect(b0.kv).toMatchObject({ menu: expect.anything(), orders_settings: expect.anything() });

        const r = await restore({
            glp_backup: true, shots: [],
            kv: {
                menu: [{ id: 'espresso', name: 'Espresso', emoji: '☕' }],
                orders_settings: { autoAccept: true },
                notify_mapping: { preheat_ready: ['person.max'] },
                import_settings: { customShopifyDomains: ['example-roaster.com'] },
            },
        });
        expect(r.status).toBe(200);

        const b1 = await backup();
        expect(b1.kv.menu).toEqual([{ id: 'espresso', name: 'Espresso', emoji: '☕' }]);
        expect(b1.kv.orders_settings).toMatchObject({ autoAccept: true });
        expect(b1.kv.notify_mapping).toEqual({ preheat_ready: ['person.max'] });
        expect(b1.kv.import_settings).toMatchObject({ customShopifyDomains: ['example-roaster.com'] });
    });
});

// #638-class bug found alongside the missing tables above: trash was
// exported but never read back on restore, and a trashed shot's own data
// wasn't in the `shots` array to begin with -- so the recycle bin looked
// present in the backup file but could never actually come back.
describe('Trash restore', () => {
    it('restores a trashed shot and its original deletion timestamp', async () => {
        shotRepo.upsert({ id: 10, timestamp: 1700000000, duration: 250 });
        shotRepo.setTrashEntry(10, 1690000000000);

        const b = await backup();
        expect(b.shots.map(s => s.id)).toContain(10); // findAll(), not the trash-excluding getAll()
        expect(b.trash).toEqual({ '10': 1690000000000 });

        getDb().exec('DELETE FROM shots; DELETE FROM trash;');
        const r = await restore(b);
        expect(r.status).toBe(200);

        expect(shotRepo.getTrash()).toHaveProperty('10', 1690000000000);
        expect(shotRepo.getTrashEntry(10)).toBe(1690000000000);
    });

    it('drops a trash entry whose shot id is not among the restored shots, instead of a dangling row', async () => {
        const r = await restore({
            glp_backup: true,
            shots: [{ id: 1, timestamp: 1700000000 }],
            trash: { '999': Date.now() }, // no shot with id 999 in `shots`
        });
        expect(r.status).toBe(200);
        expect(shotRepo.getTrash()).not.toHaveProperty('999');
    });
});

// Bean/grinder `image` fields only ever stored a file extension, never the
// image itself -- the file lived on disk under BEAN_IMAGE_DIR and was never
// part of the export. Restoring pointed the library at a photo that had
// never been backed up. Images are now embedded as base64 under a top-level
// `images` key; these tests cover the restore-side validation, since a
// crafted backup's `.id`/`.image` fields are fully attacker-controlled and
// this is the actual path-traversal guard.
describe('Image restore', () => {
    it('writes a valid embedded image to the correct id-derived path', async () => {
        const r = await restore({
            glp_backup: true, shots: [],
            coffee_library: { beans: [{ id: 42, name: 'Test Bean', image: 'png' }] },
            images: { '42.png': VALID_PNG_B64 },
        });
        expect(r.status).toBe(200);

        const expectedPath = imagePath(42, 'png', '');
        expect(existsSync(expectedPath)).toBe(true);
        expect(readFileSync(expectedPath)).toEqual(Buffer.from(VALID_PNG_B64, 'base64'));
        expect(libService.getLibrary().beans[0].image).toBe('png');
    });

    it('never derives the written filename from the backup file, closing off path traversal', async () => {
        // The only attacker-controlled inputs are entity.id and entity.image;
        // neither can smuggle a path. A crafted `images` key that looks like a
        // traversal attempt simply never matches the id-derived filename the
        // restore path looks up, so nothing is written for it at all.
        const r = await restore({
            glp_backup: true, shots: [],
            coffee_library: { beans: [{ id: 7, name: 'Bean', image: 'png' }] },
            images: { '../../../../tmp/evil.png': VALID_PNG_B64, '7.png': VALID_PNG_B64 },
        });
        expect(r.status).toBe(200);

        expect(existsSync(path.join(imageTmpDir, '..', '..', '..', '..', 'tmp', 'evil.png'))).toBe(false);
        expect(existsSync(imagePath(7, 'png', ''))).toBe(true);
    });

    it('clears the image field instead of writing a file when the base64 content does not match the claimed format', async () => {
        const r = await restore({
            glp_backup: true, shots: [],
            coffee_library: { beans: [{ id: 8, name: 'Bean', image: 'png' }] },
            images: { '8.png': Buffer.from('not actually a png').toString('base64') },
        });
        expect(r.status).toBe(200);
        expect(existsSync(imagePath(8, 'png', ''))).toBe(false);
        expect(libService.getLibrary().beans[0].image).toBe(null);
    });

    it('clears the image field when the entity has no matching key in `images` at all (every old-format backup)', async () => {
        const r = await restore({
            glp_backup: true, shots: [],
            coffee_library: { beans: [{ id: 9, name: 'Bean', image: 'png' }] },
            // no `images` key at all -- exactly what a pre-fix backup looks like
        });
        expect(r.status).toBe(200);
        expect(libService.getLibrary().beans[0].image).toBe(null);
    });

    // Shot photos were entirely missing from both the export and restore
    // image handling -- reported after a shot's latte-art photo displayed
    // correctly in the app but never appeared in any backup. Shots live at
    // the backup's top level, not nested under coffee_library, so this is a
    // separate code path from the library-entity tests above (same
    // validation rules, applied to public-src/views/shots/index.js's
    // uploadShotImage() target instead).
    it('restores a shot photo the same way a library entity photo is restored', async () => {
        const validJpgB64 = Buffer.from([0xFF, 0xD8, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
        const r = await restore({
            glp_backup: true,
            shots: [{ id: 55, timestamp: 1700000000, duration: 200, image: 'jpg' }],
            images: { 'shot-55.jpg': validJpgB64 },
        });
        expect(r.status).toBe(200);
        expect(existsSync(imagePath(55, 'jpg', 'shot-'))).toBe(true);
        expect(shotRepo.findById(55).image).toBe('jpg');
    });

    it('clears a shot\'s image field, same as a library entity, when the magic bytes don\'t match the claimed format', async () => {
        const r = await restore({
            glp_backup: true,
            shots: [{ id: 57, timestamp: 1700000000, duration: 200, image: 'jpg' }],
            images: { 'shot-57.jpg': Buffer.from('not actually a jpg').toString('base64') },
        });
        expect(r.status).toBe(200);
        expect(existsSync(imagePath(57, 'jpg', 'shot-'))).toBe(false);
        expect(shotRepo.findById(57).image).toBe(null);
    });

    it('never derives a shot photo\'s written filename from the backup file either', async () => {
        const validJpgB64 = Buffer.from([0xFF, 0xD8, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
        const r = await restore({
            glp_backup: true,
            shots: [{ id: 56, timestamp: 1700000000, duration: 200, image: 'jpg' }],
            images: { '../../../../tmp/evil-shot.jpg': validJpgB64, 'shot-56.jpg': validJpgB64 },
        });
        expect(r.status).toBe(200);
        expect(existsSync(path.join(imageTmpDir, '..', '..', '..', '..', 'tmp', 'evil-shot.jpg'))).toBe(false);
        expect(existsSync(imagePath(56, 'jpg', 'shot-'))).toBe(true);
    });
});

// Export used to derive its file list from a hand-maintained "which library
// entity types can have a photo" table, which silently omitted shot photos
// entirely -- reported after a shot's photo rendered fine in the app but
// never showed up in a backup. GET/POST /api/backup now scan BEAN_IMAGE_DIR
// directly instead, so this proves the property that actually matters: it
// can't miss a category, because it doesn't need to know what one is.
describe('Image export (directory scan)', () => {
    it('includes a shot photo file even though shots are not in the library-entity list', async () => {
        writeFileSync(imagePath(77, 'jpg', 'shot-'), Buffer.from([0xFF, 0xD8, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        const b = await backup();
        expect(b.images).toHaveProperty('shot-77.jpg');
    });

    it('includes any file under BEAN_IMAGE_DIR regardless of naming, proving the scan is not entity-type-driven', async () => {
        // No current entity type uses this prefix -- stands in for "a future
        // photo-bearing entity type nobody has updated an export list for
        // yet", which is exactly the bug class this test guards against.
        writeFileSync(imagePath(1, 'png', 'future-entity-'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]));
        const b = await backup();
        expect(b.images).toHaveProperty('future-entity-1.png');
    });

    it('does not include a non-file entry (defensive -- BEAN_IMAGE_DIR is documented as flat, never actually contains one)', async () => {
        const subDir = path.join(imageTmpDir, 'not-an-image');
        mkdirSync(subDir);
        const b = await backup();
        expect(b.images).not.toHaveProperty('not-an-image');
        rmSync(subDir, { recursive: true, force: true });
    });
});

// MQTT broker credentials are excluded from the export on purpose (the file
// routinely ends up in Downloads/cloud backups), and a restore must never
// let a backup overwrite a locally configured password even if one is
// smuggled into a hand-edited file.
describe('MQTT credential handling', () => {
    it('never includes username/password in the export', async () => {
        mqttSettingsRepo.saveSettings({ transport: 'mqtt', host: 'broker.local', port: 1883, username: 'glp', password: 'super-secret' });

        const b = await backup();
        expect(b.kv.mqtt_settings.host).toBe('broker.local');
        expect(b.kv.mqtt_settings).not.toHaveProperty('username');
        expect(b.kv.mqtt_settings).not.toHaveProperty('password');
    });

    it('keeps the locally configured password even when a crafted backup smuggles a different one in', async () => {
        mqttSettingsRepo.saveSettings({ transport: 'mqtt', host: 'old-broker.local', username: 'local-user', password: 'local-secret' });

        const r = await restore({
            glp_backup: true, shots: [],
            kv: { mqtt_settings: { host: 'new-broker.local', username: 'attacker', password: 'attacker-secret' } },
        });
        expect(r.status).toBe(200);

        const settings = mqttSettingsRepo.getSettings();
        expect(settings.host).toBe('new-broker.local'); // non-credential fields still apply
        expect(settings.username).toBe('local-user');   // credentials untouched
        expect(settings.password).toBe('local-secret');
    });
});

// Verified against the actual top-level shape of a real backup taken from a
// production v2.29.0 install (172 shots, 8 beans) -- before this fix, GET
// /api/backup never produced anything beyond these 8 keys.
describe('Backward compatibility with pre-fix backups', () => {
    it('restores cleanly from a backup with only the old top-level keys', async () => {
        const oldFormatBackup = {
            glp_backup: true,
            version: '2.29.0',
            created: '2026-08-05T16:07:26.587Z',
            shots: [{ id: 173, timestamp: 1700000000, duration: 290, profile_name: 'Adaptive' }],
            annotations: { 173: { coffee: 'DECAF Sertao' } },
            coffee_library: { beans: [{ id: 1, name: 'DECAF Sertao' }] },
            blocklist: [],
            trash: {},
            // no maintenance/maintenance_log/orders/machines/kv/images -- exactly what old exports produced
        };

        const r = await restore(oldFormatBackup);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.shots).toBe(1);

        expect(shotRepo.findAll().map(s => s.id)).toEqual([173]);
        expect(libService.getLibrary().beans[0].name).toBe('DECAF Sertao');
        // Nothing to restore for the missing blocks -- the previous content
        // (if any) is simply left as-is, not wiped, since `Array.isArray(b.X)`/
        // `typeof b.X === 'object'` guards are all false for an absent key.
    });
});

// Six selectable domains (matching the "Restore Settings only" vs "Restore
// Maintenance only" request in the issue this feature responds to), usable
// on both export and restore.
describe('Selective backup sections', () => {
    it('POST /api/backup with sections only includes the requested domains', async () => {
        seedOneShot();
        orderRepo.replaceAll([{ id: 'o1', status: 'pending', item: 'Latte', customer: '', note: '', variant: null, notifyService: null, declineReason: null, haUserId: null, machine: null, createdAt: Date.now(), completedAt: null, acceptedAt: null, eta: null, machineId: 1, beanId: null, shotId: null }]);

        const b = await backupPost({ sections: ['orders'] });
        expect(b.shots).toBeUndefined();
        expect(b.machines).toBeUndefined();
        expect(b.orders).toHaveLength(1);
        expect(b.sections).toEqual(['orders']);
        // The envelope (glp_backup/version/created) is always present, even
        // for a single-section export -- it's still a valid, identifiable backup file.
        expect(b.glp_backup).toBe(true);
    });

    it('an explicitly empty sections array exports nothing but the envelope', async () => {
        seedOneShot();
        const b = await backupPost({ sections: [] });
        expect(b.shots).toBeUndefined();
        expect(b.orders).toBeUndefined();
        expect(b.glp_backup).toBe(true);
    });

    it('restoring with sections only applies the requested domains, leaving the rest untouched', async () => {
        seedOneShot(); // id 1, already in the DB
        registry.createMachine({ name: 'Existing', type: 'gaggiuino', host: 'existing.local' });
        const existingMachineCount = registry.listMachines().length;

        const r = await restore({
            glp_backup: true,
            shots: [{ id: 99, timestamp: 1700000000, duration: 100 }], // present in the file...
            machines: [{ id: 5, name: 'From backup', type: 'gaggiuino', host: 'backup.local' }],
            sections: ['machines'], // ...but only 'machines' was requested
        });
        expect(r.status).toBe(200);
        expect(r.status).toBe(200);

        // Shots untouched -- the original seeded shot is still there, id 99 from
        // the file was never applied since 'shots' wasn't a requested section.
        expect(shotRepo.findAll().map(s => s.id)).toEqual([1]);
        // Machines WERE applied -- restoreMachines() replaces the whole table
        // (that's the existing, correct behavior for the 'machines' domain;
        // it isn't a merge), so the pre-existing machine is gone too.
        expect(registry.listMachines().map(m => m.name)).toEqual(['From backup']);
        expect(existingMachineCount).toBe(1); // sanity: there was 1 before the scoped restore
    });

    it('falls back to the backup file\'s own `sections` field when the restore request specifies none', async () => {
        seedOneShot();
        // Simulates re-uploading a file that was itself exported with sections:['orders']
        // -- restoring it without explicitly picking sections again must only
        // apply what it was scoped to on export, not silently expand to "everything".
        const r = await restore({
            glp_backup: true,
            shots: [{ id: 99, timestamp: 1700000000, duration: 100 }],
            orders: [{ id: 'o2', status: 'pending', item: 'Cortado', customer: '', note: '', variant: null, notifyService: null, declineReason: null, haUserId: null, machine: null, createdAt: Date.now(), completedAt: null, acceptedAt: null, eta: null, machineId: 1, beanId: null, shotId: null }],
            sections: ['orders'],
        });
        expect(r.status).toBe(200);
        expect(shotRepo.findAll().map(s => s.id)).toEqual([1]); // untouched
        expect(orderRepo.findAll().map(o => o.id)).toEqual(['o2']); // applied
    });
});

// "File upload button with validation check before overwriting existing
// config" -- a dry run runs every schema/sanitizer check the real restore
// does and reports what would happen, without writing anything.
describe('Restore dry run', () => {
    it('reports a preview without touching the database', async () => {
        seedOneShot();
        libraryRepo.restoreMaintenanceRaw([{ machineId: 1, key: 'descaling', data: { lastDate: null } }]);

        const r = await restore({
            glp_backup: true, dryRun: true,
            shots: [{ id: 99, timestamp: 1700000000, duration: 100 }],
            maintenance: [
                { machineId: 1, key: 'backflush', data: { lastDate: null } },
                { key: 'invalid-row-missing-machine-id' }, // dropped by the sanitizer
            ],
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.dryRun).toBe(true);
        expect(body.preview.shots).toBe(1);
        expect(body.preview.maintenance).toBe(1); // one valid, one dropped
        expect(body.preview.maintenanceTotal).toBe(2);

        // Nothing was actually written -- the original seeded shot (id 1) is
        // still the only one, not id 99 from the dry-run payload, and the
        // pre-existing maintenance row is untouched.
        expect(shotRepo.findAll().map(s => s.id)).toEqual([1]);
        expect(libraryRepo.getAllMaintenanceRaw()).toEqual([{ machineId: 1, key: 'descaling', data: { lastDate: null } }]);
    });

    it('reports whether the given passphrase can decrypt the secrets block, without applying it', async () => {
        state.apiToken = 'original-token-should-not-change';
        const b = await backupPost({ passphrase: 'right-passphrase' });
        expect(b.secrets).toBeDefined();

        const wrong = await restore({ ...b, dryRun: true, passphrase: 'wrong-passphrase' });
        expect((await wrong.json()).preview.secretsRestored).toBe(false);

        const right = await restore({ ...b, dryRun: true, passphrase: 'right-passphrase' });
        expect((await right.json()).preview.secretsRestored).toBe(true);

        // Dry run, even with the correct passphrase: the token must be unchanged.
        expect(state.apiToken).toBe('original-token-should-not-change');
    });
});

// The API token grants full API access (including this very endpoint) --
// same sensitivity class as the MQTT credentials, so it travels the same
// encrypted-and-opt-in path rather than ever appearing in the plaintext export.
describe('API token in encrypted secrets', () => {
    it('restores the API token from a correctly-decrypted secrets block', async () => {
        state.apiToken = 'token-before-restore';
        const b = await backupPost({ passphrase: 'a-strong-passphrase' });
        expect(b.secrets).toBeDefined();

        state.apiToken = 'token-before-restore'; // export must not itself have changed it
        const r = await restore({ ...b, passphrase: 'a-strong-passphrase' });
        const body = await r.json();
        expect(r.status).toBe(200);
        expect(body.secretsPresent).toBe(true);
        expect(body.secretsRestored).toBe(true);
        expect(state.apiToken).toBe('token-before-restore'); // round-tripped the same value
    });

    it('leaves the current API token alone when the passphrase is wrong', async () => {
        state.apiToken = 'token-should-survive';
        const b = await backupPost({ passphrase: 'correct-passphrase' });

        const r = await restore({ ...b, passphrase: 'incorrect-passphrase' });
        const body = await r.json();
        expect(r.status).toBe(200); // rest of the restore still succeeds
        expect(body.secretsPresent).toBe(true);
        expect(body.secretsRestored).toBe(false);
        expect(state.apiToken).toBe('token-should-survive');
    });

    it('never includes an API token in a plaintext (no-passphrase) export', async () => {
        state.apiToken = 'should-not-leak';
        const b = await backup(); // GET, no passphrase
        expect(JSON.stringify(b)).not.toContain('should-not-leak');
        expect(b.secrets).toBeUndefined();
    });
});

// #658: export moved from a single JSON object (images embedded as base64)
// to a zip (backup.json + real image files) -- restore must keep accepting
// both, since backups downloaded before this change still need to work.
describe('Zip export/restore (#658)', () => {
    const validJpg = Buffer.from([0xFF, 0xD8, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

    it('POST /api/backup returns a zip whose backup.json has no embedded base64 images', async () => {
        seedOneShot();
        writeFileSync(imagePath(1, 'jpg', 'shot-'), validJpg);
        shotRepo.upsert({ id: 1, timestamp: 1700000000, duration: 250, profile_name: 'Test Profile', image: 'jpg' });

        const { bundle, images } = await backupPostZip();
        expect(bundle.images).toBeUndefined();
        expect(images).toHaveProperty('shot-1.jpg');
        expect(Buffer.from(images['shot-1.jpg']).equals(validJpg)).toBe(true);
    });

    it('GET /api/backup (legacy) is unaffected -- still a single JSON object with base64 images', async () => {
        writeFileSync(imagePath(2, 'jpg', 'shot-'), validJpg);
        const b = await backup();
        expect(b.images).toHaveProperty('shot-2.jpg');
        expect(typeof b.images['shot-2.jpg']).toBe('string'); // still base64, not a raw byte array
    });

    it('restores cleanly from a zip export, images and all, via a dry run then a real restore', async () => {
        seedOneShot();
        shotRepo.upsert({ id: 1, timestamp: 1700000000, duration: 250, profile_name: 'Test Profile', image: 'jpg' });
        writeFileSync(imagePath(1, 'jpg', 'shot-'), validJpg);

        const zipRes = await fetch(`${baseUrl}/api/backup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const zipBuffer = Buffer.from(await zipRes.arrayBuffer());

        const dry = await restoreZip(zipBuffer, { dryRun: true });
        expect(dry.status).toBe(200);
        const dryBody = await dry.json();
        expect(dryBody.dryRun).toBe(true);
        expect(dryBody.preview.shots).toBe(1);
        expect(dryBody.preview.images).toBe(1);

        shotRepo.wipeAll(); // prove the real restore below is what repopulates it, not the seed above
        const real = await restoreZip(zipBuffer, {});
        expect(real.status).toBe(200);
        const realBody = await real.json();
        expect(realBody.ok).toBe(true);
        expect(realBody.shots).toBe(1);
        expect(shotRepo.findAll().map(s => s.id)).toEqual([1]);
        expect(existsSync(imagePath(1, 'jpg', 'shot-'))).toBe(true);
    });

    it('applies a section filter via the X-GLP-Sections header on a zip restore', async () => {
        registry.createMachine({ name: 'From zip', type: 'gaggiuino', host: 'zip.local' });
        seedOneShot();

        const { bundle } = await backupPostZip();
        const entries = [{ name: 'backup.json', data: Buffer.from(JSON.stringify(bundle)) }];
        const { createZip } = require('../lib/zip');
        const zipBuffer = createZip(entries);

        shotRepo.wipeAll();
        const r = await restoreZip(zipBuffer, { sections: ['machines'] });
        expect(r.status).toBe(200);
        // Only 'machines' was requested via the header -- shots stayed empty.
        expect(shotRepo.findAll()).toEqual([]);
        expect(registry.listMachines().map(m => m.name)).toContain('From zip');
    });

    it('a passphrase sent via X-GLP-Passphrase decrypts the secrets block on a zip restore', async () => {
        state.apiToken = 'token-before-zip-restore';
        const { bundle } = await backupPostZip({ passphrase: 'zip-passphrase' });
        expect(bundle.secrets).toBeDefined();
        const { createZip } = require('../lib/zip');
        const zipBuffer = createZip([{ name: 'backup.json', data: Buffer.from(JSON.stringify(bundle)) }]);

        const r = await restoreZip(zipBuffer, { passphrase: 'zip-passphrase' });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.secretsRestored).toBe(true);
    });

    it('still rejects a path-traversal image filename when sourced from a zip instead of base64 JSON', async () => {
        seedOneShot();
        shotRepo.upsert({ id: 1, timestamp: 1700000000, duration: 250, profile_name: 'Test Profile', image: 'jpg' });
        const bundle = {
            glp_backup: true,
            shots: [{ id: 1, timestamp: 1700000000, duration: 250, profile_name: 'Test Profile', image: 'jpg' }],
        };
        const { createZip } = require('../lib/zip');
        // The malicious entry name never matches imageFilename(1, 'jpg', 'shot-')
        // ("shot-1.jpg"), so validateEntityImages() must clear .image rather
        // than ever constructing a path from it -- same guard the base64 path
        // already had, now exercised via a zip-sourced imagesMap.
        const zipBuffer = createZip([
            { name: 'backup.json', data: Buffer.from(JSON.stringify(bundle)) },
            { name: 'images/../../../../tmp/evil-from-zip.jpg', data: validJpg },
        ]);

        const r = await restoreZip(zipBuffer, {});
        expect(r.status).toBe(200);
        expect(existsSync('/tmp/evil-from-zip.jpg')).toBe(false);
    });

    it('rejects a malformed zip body with 400 instead of a 500', async () => {
        const r = await fetch(`${baseUrl}/api/restore`, {
            method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: Buffer.from('not a zip'),
        });
        expect(r.status).toBe(400);
    });
});

describe('ShotRepository.upsert', () => {
    it('fails with a clean NOT NULL constraint error, not an opaque TypeError, on a missing timestamp', () => {
        // shots.timestamp is NOT NULL, so this is still expected to throw — the point of the
        // `?? null` guard is only to turn an unhandled "bind undefined" TypeError into a clean,
        // diagnosable SQLite constraint error for any code path that bypasses route validation
        // (e.g. the legacy JSON migration in lib/db.js).
        expect(() => shotRepo.upsert({ id: 99 })).toThrowError(/NOT NULL constraint failed/);
    });
});
