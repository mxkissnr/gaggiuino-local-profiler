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

// Mock axios before lib/geo.js captures it
const axiosPath = require.resolve('axios');
const axiosGet  = vi.fn();
require.cache[axiosPath] = { exports: { get: axiosGet, default: { get: axiosGet } } };

const { geocodeRegion } = require('../lib/geo');
const { getDb }         = require('../lib/db');

beforeEach(() => {
    getDb().prepare('DELETE FROM kv').run();
    axiosGet.mockReset();
});

describe('geocodeRegion', () => {
    it('queries Nominatim with region + country and caches the hit', async () => {
        axiosGet.mockResolvedValueOnce({ data: [{ lat: '6.8', lon: '38.4' }] });
        const r1 = await geocodeRegion('Sidama, Bensa', 'Ethiopia');
        expect(r1).toEqual({ lat: 6.8, lon: 38.4, label: 'Sidama, Bensa' });
        expect(axiosGet).toHaveBeenCalledTimes(1);
        const [, opts] = axiosGet.mock.calls[0];
        expect(opts.params.q).toBe('Sidama, Bensa, Ethiopia');
        expect(opts.headers['User-Agent']).toContain('GLP/');

        // second identical call: served from cache, no new request
        const r2 = await geocodeRegion('Sidama, Bensa', 'Ethiopia');
        expect(r2).toEqual(r1);
        expect(axiosGet).toHaveBeenCalledTimes(1);
    });

    it('caches misses (empty result) so failures are not re-queried', async () => {
        axiosGet.mockResolvedValueOnce({ data: [] });
        expect(await geocodeRegion('Mondbasis Alpha', 'Ethiopia')).toBeNull();
        expect(await geocodeRegion('Mondbasis Alpha', 'Ethiopia')).toBeNull();
        expect(axiosGet).toHaveBeenCalledTimes(1);
    });

    it('tolerates network errors and returns null', async () => {
        axiosGet.mockRejectedValueOnce(new Error('timeout'));
        expect(await geocodeRegion('Huila', 'Colombia')).toBeNull();
    });

    it('rejects empty input without querying', async () => {
        expect(await geocodeRegion('', 'Ethiopia')).toBeNull();
        expect(await geocodeRegion(null, 'Ethiopia')).toBeNull();
        expect(axiosGet).not.toHaveBeenCalled();
    });
});
