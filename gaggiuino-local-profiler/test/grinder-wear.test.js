import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// In-memory DB swap (same pattern as low-stock-notify.test.js)
const Database = require('better-sqlite3');
const dbPath   = require.resolve('../lib/db');
const realDb   = require(dbPath);
const memDb    = new Database(':memory:');
realDb.initSchema(memDb);
require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

const libraryService = require('../lib/services/LibraryService');
const shotRepo       = require('../lib/repositories/ShotRepository');
const { getDb }      = require('../lib/db');

beforeEach(() => {
    getDb().exec('DELETE FROM shots; DELETE FROM annotations; DELETE FROM library;');
});

function seedShots(rows) {
    shotRepo.upsertMany(rows.map(r => ({ id: r.id, timestamp: r.timestamp, duration: 250 })));
    rows.forEach(r => shotRepo.saveAnnotation(r.id, { grinder: r.grinder, dose: r.dose }));
}

describe('computeGrinderWearStats', () => {
    it('counts shots and grams matching the grinder name (case-insensitive) when burrsResetAt is unset', () => {
        seedShots([
            { id: 1, timestamp: 100, grinder: 'Niche Zero', dose: '18' },
            { id: 2, timestamp: 200, grinder: 'niche zero', dose: '18.5' },
            { id: 3, timestamp: 300, grinder: 'Other Grinder', dose: '20' },
        ]);
        const stats = libraryService.computeGrinderWearStats({ name: 'Niche Zero' });
        expect(stats.shotsSinceBurrs).toBe(2);
        expect(stats.gramsSinceBurrs).toBe(36.5);
    });

    it('only counts shots after burrsResetAt', () => {
        seedShots([
            { id: 1, timestamp: 100, grinder: 'Niche Zero', dose: '18' }, // before reset
            { id: 2, timestamp: 2000000000, grinder: 'Niche Zero', dose: '19' }, // after reset (year ~2033)
        ]);
        // Reset date between the two shots (year 2020)
        const stats = libraryService.computeGrinderWearStats({ name: 'Niche Zero', burrsResetAt: '2020-01-01' });
        expect(stats.shotsSinceBurrs).toBe(1);
        expect(stats.gramsSinceBurrs).toBe(19);
    });

    it('returns zero stats for a grinder with no matching shots', () => {
        seedShots([{ id: 1, timestamp: 100, grinder: 'Other Grinder', dose: '18' }]);
        const stats = libraryService.computeGrinderWearStats({ name: 'Niche Zero' });
        expect(stats.shotsSinceBurrs).toBe(0);
        expect(stats.gramsSinceBurrs).toBe(0);
    });

    it('treats shots with no dose annotation as 0 grams without breaking the count', () => {
        seedShots([
            { id: 1, timestamp: 100, grinder: 'Niche Zero', dose: undefined },
            { id: 2, timestamp: 200, grinder: 'Niche Zero', dose: '18' },
        ]);
        const stats = libraryService.computeGrinderWearStats({ name: 'Niche Zero' });
        expect(stats.shotsSinceBurrs).toBe(2);
        expect(stats.gramsSinceBurrs).toBe(18);
    });
});
