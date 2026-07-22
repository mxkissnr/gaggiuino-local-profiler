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

    it('falls back to a name match when beanId points at a bean that no longer exists', () => {
        // Same underlying rule as computeBeanRemaining's beanId-first-with-
        // fallback matching (see the "deleted and reimported" test below).
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
    it('a bean deleted and reimported under the same name DOES recover the old shots\' consumption via name fallback', () => {
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
        // fresh bag. The library now only contains the new bean; bean id 1000
        // no longer exists anywhere.
        libraryService.saveLibrary({ beans: [
            { id: 2000, name: 'Kiraz', stock_g: 250, bags: [{ id: 2, openedAt: 0, stock_g: 250 }] },
        ], grinders: [], recipes: [] });

        const lib      = libraryService.getLibrary();
        const doseRows = shotRepo.getAnnotatedDoses();
        // Identity-preservation across delete+reimport ("Identität über
        // Löschen/Neu-Import hinweg erhalten bleibt") was the whole point of
        // moving to beanId — the old shots' beanId (1000) no longer resolves
        // to ANY current bean, so they fall back to the shared name and
        // recover onto the reimported bean.
        expect(libraryService.computeBeanRemaining(lib.beans[0], doseRows, lib.beans)).toBe(250 - 18 - 19);
    });

    it('does NOT rescue by name when beanId resolves to a different, still-existing bean (precision case)', () => {
        // Two distinct beans that happen to share a name, both still active.
        libraryService.saveLibrary({ beans: [
            { id: 1000, name: 'House Espresso', stock_g: 250, bags: [{ id: 1, openedAt: 0, stock_g: 250 }] },
            { id: 2000, name: 'House Espresso', stock_g: 500, bags: [{ id: 2, openedAt: 0, stock_g: 500 }] },
        ], grinders: [], recipes: [] });
        shotRepo.upsertMany([{ id: 1, timestamp: 1000, duration: 250 }]);
        // beanId explicitly points at bean 2000 — the dose genuinely belongs
        // there, even though its stored coffee name also matches bean 1000.
        shotRepo.saveAnnotation(1, { coffee: 'House Espresso', beanId: 2000, dose: '18' });

        const lib       = libraryService.getLibrary();
        const doseRows  = shotRepo.getAnnotatedDoses();
        const bean1000  = lib.beans.find(b => b.id === 1000);
        const bean2000  = lib.beans.find(b => b.id === 2000);

        // A resolvable beanId is trusted exclusively — must NOT be
        // miscounted toward bean 1000 just because the name matches.
        expect(libraryService.computeBeanRemaining(bean1000, doseRows, lib.beans)).toBe(250);
        // Correctly counted toward bean 2000, the bean the id actually points at.
        expect(libraryService.computeBeanRemaining(bean2000, doseRows, lib.beans)).toBe(500 - 18);
    });

    it('consumption still tracks correctly across a rename when beanId matches (the actual regression fix)', () => {
        libraryService.saveLibrary({ beans: [
            { id: 1000, name: 'Kiraz', stock_g: 250, bags: [{ id: 1, openedAt: 0, stock_g: 250 }] },
        ], grinders: [], recipes: [] });
        shotRepo.upsertMany([{ id: 1, timestamp: 1000, duration: 250 }]);
        shotRepo.saveAnnotation(1, { coffee: 'Kiraz', beanId: 1000, dose: '18' });

        // Bean renamed in place (same id) — name-matching alone would have
        // broken here; beanId still resolving to bean 1000 must win over the
        // now-mismatched name.
        const lib = libraryService.getLibrary();
        lib.beans[0].name = 'Kiraz Reserve';
        libraryService.saveLibrary(lib);

        const freshLib  = libraryService.getLibrary();
        const bean      = freshLib.beans[0];
        const remaining = libraryService.computeBeanRemaining(bean, shotRepo.getAnnotatedDoses(), freshLib.beans);
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

        const lib  = libraryService.getLibrary();
        const bean = lib.beans[0];
        expect(libraryService.computeBeanRemaining(bean, shotRepo.getAnnotatedDoses(), lib.beans)).toBe(232);
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
