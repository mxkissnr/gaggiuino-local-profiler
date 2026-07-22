import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// In-memory DB swap (same pattern as db-routes.test.js / notes-migration.test.js)
const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

const libraryService = require('../lib/services/LibraryService');
const shotRepo       = require('../lib/repositories/ShotRepository');
const shotService     = require('../lib/services/ShotService');
const { getDb }       = require('../lib/db');

beforeEach(() => getDb().exec('DELETE FROM shots; DELETE FROM annotations; DELETE FROM library;'));

describe('resolveBeanForAnnotation (#456)', () => {
    it('resolves by beanId when present, even if the name has since changed', () => {
        libraryService.saveLibrary({ beans: [
            { id: 1, name: 'New Name' }, // renamed since the annotation was saved
        ], grinders: [], recipes: [] });
        const bean = libraryService.resolveBeanForAnnotation({ coffee: 'Old Name', beanId: 1 });
        expect(bean?.id).toBe(1);
    });

    it('falls back to name matching when beanId is absent (pre-migration annotation)', () => {
        libraryService.saveLibrary({ beans: [{ id: 1, name: 'Lucky Punch' }], grinders: [], recipes: [] });
        const bean = libraryService.resolveBeanForAnnotation({ coffee: 'lucky punch' });
        expect(bean?.id).toBe(1);
    });

    it('falls back to a name match (advisory best-guess) when beanId points at a bean that no longer exists', () => {
        // Unlike computeBeanRemaining's stricter stock-accounting match (see
        // the "deleted and reimported" test below), this general-purpose
        // resolver is advisory — it still resolves via the shared name.
        libraryService.saveLibrary({ beans: [{ id: 2, name: 'Lucky Punch' }], grinders: [], recipes: [] });
        const bean = libraryService.resolveBeanForAnnotation({ coffee: 'Lucky Punch', beanId: 1 });
        expect(bean?.id).toBe(2);
    });

    it('returns null when neither beanId nor name resolve', () => {
        libraryService.saveLibrary({ beans: [{ id: 1, name: 'Lucky Punch' }], grinders: [], recipes: [] });
        expect(libraryService.resolveBeanForAnnotation({ coffee: 'Nonexistent' })).toBeNull();
        expect(libraryService.resolveBeanForAnnotation({})).toBeNull();
    });
});

describe('computeBeanRemaining beanId-first matching (#456 regression)', () => {
    it('a bean deleted and reimported under the same name does NOT inherit the old shots\' consumption', () => {
        // Original bean A (id 1000), two shots totalling 37g logged against it.
        libraryService.saveLibrary({ beans: [
            { id: 1000, name: 'Kiraz', stock_g: 250, bags: [{ id: 1, openedAt: 0, stock_g: 250 }] },
        ], grinders: [], recipes: [] });
        shotRepo.upsertMany([
            { id: 1, timestamp: 1000, duration: 250 },
            { id: 2, timestamp: 1001, duration: 250 },
        ]);
        shotRepo.saveAnnotation(1, { coffee: 'Kiraz', beanId: 1000, dose: '18' });
        shotRepo.saveAnnotation(2, { coffee: 'Kiraz', beanId: 1000, dose: '19' });

        // Bean A is deleted and reimported under the same name -> fresh id 2000,
        // fresh bag. The library now only contains the new bean.
        libraryService.saveLibrary({ beans: [
            { id: 2000, name: 'Kiraz', stock_g: 250, bags: [{ id: 2, openedAt: 0, stock_g: 250 }] },
        ], grinders: [], recipes: [] });

        const doseRows = shotRepo.getAnnotatedDoses();
        const newBean  = libraryService.getLibrary().beans[0];
        // Honest behavior: the old shots' beanId (1000) no longer matches any
        // current bean, so they are NOT rescued by the shared name — the new
        // bean starts at its full, untouched stock.
        expect(libraryService.computeBeanRemaining(newBean, doseRows)).toBe(250);
    });

    it('consumption still tracks correctly across a rename when beanId matches (the actual regression fix)', () => {
        libraryService.saveLibrary({ beans: [
            { id: 1000, name: 'Kiraz', stock_g: 250, bags: [{ id: 1, openedAt: 0, stock_g: 250 }] },
        ], grinders: [], recipes: [] });
        shotRepo.upsertMany([{ id: 1, timestamp: 1000, duration: 250 }]);
        shotRepo.saveAnnotation(1, { coffee: 'Kiraz', beanId: 1000, dose: '18' });

        // Bean renamed in place (same id) — name-matching would have broken here.
        const lib = libraryService.getLibrary();
        lib.beans[0].name = 'Kiraz Reserve';
        libraryService.saveLibrary(lib);

        const bean = libraryService.getLibrary().beans[0];
        const remaining = libraryService.computeBeanRemaining(bean, shotRepo.getAnnotatedDoses());
        expect(remaining).toBe(250 - 18);
    });

    it('#402 db-routes multi-bag openedAt cutoff semantics are unaffected for name-matched (pre-beanId) rows', () => {
        libraryService.saveLibrary({ beans: [
            { id: 1, name: 'Dolce', stock_g: 250, bags: [{ id: 1, openedAt: 0 }, { id: 2, openedAt: 5000 * 1000 }] },
        ], grinders: [], recipes: [] });
        shotRepo.upsertMany([
            { id: 1, timestamp: 1000, duration: 250 }, // old bag
            { id: 2, timestamp: 6000, duration: 250 }, // active bag
        ]);
        shotRepo.saveAnnotation(1, { coffee: 'Dolce', dose: 18 });
        shotRepo.saveAnnotation(2, { coffee: 'Dolce', dose: 18 });

        const bean = libraryService.getLibrary().beans[0];
        expect(libraryService.computeBeanRemaining(bean, shotRepo.getAnnotatedDoses())).toBe(232);
    });
});

describe('ShotService.computeScore uses resolveBeanForAnnotation (#456)', () => {
    it('resolves the bean by beanId for brew-recommendation-aware scoring', () => {
        libraryService.saveLibrary({ beans: [
            { id: 1, name: 'Renamed Since', brewTempC: 94, brewRatio: '1:2' },
        ], grinders: [], recipes: [] });
        const shot = {
            duration: 300, annotation: { coffee: 'Old Name At Save Time', beanId: 1 },
            datapoints: { timeInShot: [0, 10, 20, 30], temperature: [940, 940, 940, 940], targetTemperature: [940, 940, 940, 940] },
        };
        // Just verifying it doesn't throw and resolves without error — the
        // scoring math itself is covered by test/score.test.js.
        expect(() => shotService.computeScore(shot)).not.toThrow();
    });
});

describe('migrateAnnotationBeanIds (#456 backfill)', () => {
    it('sets beanId only when the name matches exactly one current bean', () => {
        libraryService.saveLibrary({ beans: [
            { id: 1, name: 'Lucky Punch' },
            { id: 2, name: 'Ambiguous' },
            { id: 3, name: 'Ambiguous' }, // duplicate name -> ambiguous, must not guess
        ], grinders: [], recipes: [] });
        shotRepo.upsertMany([
            { id: 1, timestamp: 1000, duration: 250 },
            { id: 2, timestamp: 1001, duration: 250 },
            { id: 3, timestamp: 1002, duration: 250 }, // no matching bean at all
        ]);
        shotRepo.saveAnnotation(1, { coffee: 'lucky punch', dose: '18' }); // case-insensitive unique match
        shotRepo.saveAnnotation(2, { coffee: 'Ambiguous', dose: '18' });   // ambiguous, must be skipped
        shotRepo.saveAnnotation(3, { coffee: 'Nonexistent', dose: '18' }); // no match, must be skipped

        const changed = libraryService.migrateAnnotationBeanIds();
        expect(changed).toBe(1);

        expect(shotRepo.getAnnotation(1).beanId).toBe(1);
        expect(shotRepo.getAnnotation(2).beanId).toBeUndefined();
        expect(shotRepo.getAnnotation(3).beanId).toBeUndefined();
    });

    it('is idempotent — a second run is a no-op once every resolvable row has beanId', () => {
        libraryService.saveLibrary({ beans: [{ id: 1, name: 'Lucky Punch' }], grinders: [], recipes: [] });
        shotRepo.upsertMany([{ id: 1, timestamp: 1000, duration: 250 }]);
        shotRepo.saveAnnotation(1, { coffee: 'Lucky Punch', dose: '18' });

        expect(libraryService.migrateAnnotationBeanIds()).toBe(1);
        expect(libraryService.migrateAnnotationBeanIds()).toBe(0);
        expect(shotRepo.getAnnotation(1).beanId).toBe(1);
    });

    it('never overwrites an already-set beanId', () => {
        libraryService.saveLibrary({ beans: [
            { id: 1, name: 'Lucky Punch' }, { id: 2, name: 'El Cubanito' },
        ], grinders: [], recipes: [] });
        shotRepo.upsertMany([{ id: 1, timestamp: 1000, duration: 250 }]);
        // beanId intentionally disagrees with the name — a manual edge case,
        // but the migration must never clobber an existing explicit link.
        shotRepo.saveAnnotation(1, { coffee: 'Lucky Punch', beanId: 2, dose: '18' });

        expect(libraryService.migrateAnnotationBeanIds()).toBe(0);
        expect(shotRepo.getAnnotation(1).beanId).toBe(2);
    });
});
