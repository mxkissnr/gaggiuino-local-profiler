const axios = require('axios');
const { getDb } = require('./db');
const { GLP_VERSION } = require('./constants');
const { log } = require('./helpers');

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// Nominatim usage policy: identify the app, max 1 request/second.
const MIN_INTERVAL_MS = 1100;
const CACHE_KEY = 'geocode_cache';
const CACHE_MAX = 500;

function loadCache() {
    try {
        const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(CACHE_KEY);
        return row ? JSON.parse(row.value) : {};
    } catch { return {}; }
}

function saveCache(cache) {
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
        keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
        for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
    }
    getDb().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(CACHE_KEY, JSON.stringify(cache));
}

// Serialize all Nominatim requests with >= MIN_INTERVAL_MS between them.
let _queue = Promise.resolve();
let _lastRequestAt = 0;

function enqueue(fn) {
    _queue = _queue.then(async () => {
        const wait = _lastRequestAt + MIN_INTERVAL_MS - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        _lastRequestAt = Date.now();
        return fn();
    }).catch(() => null);
    return _queue;
}

// Resolves "region, country" to { lat, lon, label } — or null. Results
// (including misses) are cached in the kv table so each query hits
// Nominatim at most once.
async function geocodeRegion(region, countryName) {
    if (!region || typeof region !== 'string') return null;
    const query = [region.trim(), countryName || ''].filter(Boolean).join(', ');
    const key   = query.toLowerCase();
    const cache = loadCache();
    if (key in cache) return cache[key].result;

    const result = await enqueue(async () => {
        try {
            const r = await axios.get(NOMINATIM_URL, {
                params: { format: 'jsonv2', limit: 1, q: query },
                headers: { 'User-Agent': `GLP/${GLP_VERSION} (https://github.com/mxkissnr/gaggiuino-local-profiler)` },
                timeout: 8000,
            });
            const hit = Array.isArray(r.data) ? r.data[0] : null;
            if (!hit || !hit.lat || !hit.lon) return null;
            return { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), label: region.trim() };
        } catch (e) {
            log(`Geocode failed for "${query}": ${e.message}`, true);
            return null;
        }
    });

    // re-load: another request may have written meanwhile
    const fresh = loadCache();
    fresh[key] = { result, ts: Date.now() };
    saveCache(fresh);
    return result;
}

module.exports = { geocodeRegion };
