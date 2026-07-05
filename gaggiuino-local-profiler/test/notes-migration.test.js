import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// In-memory DB swap (same pattern as db-routes.test.js)
const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

const libraryService = require('../lib/services/LibraryService');
const { getDb }      = require('../lib/db');

beforeEach(() => getDb().exec('DELETE FROM library;'));

describe('migrateImportedNotes', () => {
    it('moves Herkunft/Aufbereitung fragments into structured fields and cleans comma artifacts', () => {
        libraryService.saveLibrary({ beans: [{
            id: 1, name: 'Lucky Punch House Espresso',
            notes: 'Karamell, , Nuss, , Vollmilchschokolade · Herkunft: Brasilien · Aufbereitung: Natural',
        }], grinders: [], recipes: [] });

        expect(libraryService.migrateImportedNotes()).toBe(1);
        const [bean] = libraryService.getLibrary().beans;
        expect(bean.origin).toBe('BR');
        expect(bean.process).toBe('Natural');
        expect(bean.notes).toBe('Karamell, Nuss, Vollmilchschokolade');
    });

    it('keeps unmappable blends in the notes and is idempotent', () => {
        libraryService.saveLibrary({ beans: [{
            id: 1, name: 'Blend', notes: 'Schoko · Herkunft: Brasilien, Indien',
        }], grinders: [], recipes: [] });

        libraryService.migrateImportedNotes();
        const [bean] = libraryService.getLibrary().beans;
        expect(bean.origin).toBeUndefined();
        expect(bean.notes).toBe('Schoko · Herkunft: Brasilien, Indien');
        expect(libraryService.migrateImportedNotes()).toBe(0); // second run: no changes
    });

    it('moves the aroma segment of imported beans into flavors (migrateNotesToFlavors)', () => {
        libraryService.saveLibrary({ beans: [
            { id: 1, name: 'Imported', source: 'kaffeebraun.com',
              notes: 'Karamell, Nuss, Vollmilchschokolade · Röstgrad: kräftig (4/5)' },
            { id: 2, name: 'Manual (no source)', notes: 'Karamell, Nuss' },
            { id: 3, name: 'Prose', source: 'hoppenworth-ploch.de',
              notes: 'Dieser Kaffee ist toll. Sehr lecker!' },
            { id: 4, name: 'KeyPrefix', source: 'kaffeebraun.com',
              notes: 'Herkunft: Brasilien, Indien' },
        ], grinders: [], recipes: [] });

        expect(libraryService.migrateNotesToFlavors()).toBe(1);
        const beans = libraryService.getLibrary().beans;
        expect(beans[0].flavors).toEqual(['Karamell', 'Nuss', 'Vollmilchschokolade']);
        expect(beans[0].notes).toBe('Röstgrad: kräftig (4/5)');
        expect(beans[1].flavors).toBeUndefined();       // manual bean untouched
        expect(beans[2].flavors).toBeUndefined();       // prose untouched
        expect(beans[3].flavors).toBeUndefined();       // key-prefixed segment untouched
        expect(libraryService.migrateNotesToFlavors()).toBe(0); // idempotent
    });

    it('never overwrites already-set structured fields and leaves decimals alone', () => {
        libraryService.saveLibrary({ beans: [
            { id: 1, name: 'A', origin: 'ET', notes: 'Herkunft: Brasilien' },
            { id: 2, name: 'B', notes: 'TDS 9,2 gemessen' },
        ], grinders: [], recipes: [] });

        libraryService.migrateImportedNotes();
        const beans = libraryService.getLibrary().beans;
        expect(beans[0].origin).toBe('ET');
        expect(beans[0].notes).toBe('Herkunft: Brasilien');
        expect(beans[1].notes).toBe('TDS 9,2 gemessen');
    });
});
