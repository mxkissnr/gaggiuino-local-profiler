// Compatibility layer — machine config helpers + shims for routes not yet
// updated to import directly from lib/services/ or lib/repositories/.

const fs = require('fs');
const { OPTIONS_FILE, ALLOWED_URL_SCHEMES } = require('./constants');
const { log } = require('./helpers');
const { getDb } = require('./db');
const orderRepo  = require('./repositories/OrderRepository');
const shotRepo   = require('./repositories/ShotRepository');
const libService = require('./services/LibraryService');
const importSettingsRepo = require('./repositories/ImportSettingsRepository');

function loadOptions() {
    try {
        if (fs.existsSync(OPTIONS_FILE))
            return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
    } catch (e) { log(`Could not read options.json: ${e.message}`, true); }
    return {};
}

function getMachineUrl(opts) {
    const raw = (opts.machine_host || opts.machine_url || process.env.MACHINE_URL || 'gaggia.intern').trim();
    const normalised = /^https?:\/\//i.test(raw) ? raw : `http://${raw}/api/shots`;
    try {
        const u = new URL(normalised);
        if (!ALLOWED_URL_SCHEMES.includes(u.protocol)) {
            log(`Invalid URL scheme: ${u.protocol} -- using default`, true);
            return 'http://gaggia.intern/api/shots';
        }
        return normalised;
    } catch {
        log('Invalid machine_host value -- using default', true);
        return 'http://gaggia.intern/api/shots';
    }
}

function getMachineBaseUrl(opts) {
    try {
        const u = new URL(getMachineUrl(opts));
        return `${u.protocol}//${u.host}`;
    } catch { return 'http://gaggia.intern'; }
}

function getSyncIntervalMs(opts) {
    return (opts.sync_interval || 5) * 60 * 1000;
}

function isOrdersEnabled() { return !!loadOptions().enable_orders; }

// ── Order shims ───────────────────────────────────────────────────────────────
function loadOrders()          { return orderRepo.findActive(); }
function saveOrders(orders) {
    const db = getDb();
    db.transaction(() => {
        db.prepare('DELETE FROM orders').run();
        const ins = db.prepare('INSERT INTO orders (id, data) VALUES (?,?)');
        for (const o of orders) ins.run(o.id, JSON.stringify(o));
    })();
}
function loadMenu()            { return orderRepo.getMenu(); }
function saveMenu(m)           { orderRepo.saveMenu(m); }
function loadOrdersSettings()  { return orderRepo.getSettings(); }
function saveOrdersSettings(s) { orderRepo.saveSettings(s); }
function loadNotifyMapping()   { return orderRepo.getNotifyMapping(); }
function saveNotifyMapping(m)  { orderRepo.saveNotifyMapping(m); }

// ── Library shims ─────────────────────────────────────────────────────────────
function loadLibrary()         { return libService.getLibrary(); }
function saveLibrary(lib)      { libService.saveLibrary(lib); }

// ── Shot / annotation shims ───────────────────────────────────────────────────
function loadAnnotations() {
    const db   = getDb();
    const rows = db.prepare('SELECT shot_id, data FROM annotations').all();
    const out  = {};
    for (const r of rows) out[String(r.shot_id)] = JSON.parse(r.data);
    return out;
}
function loadTrash() { return shotRepo.getTrash(); }

// ── Import settings shims ─────────────────────────────────────────────────────
function loadImportSettings()      { return importSettingsRepo.getSettings(); }
function saveImportSettings(s)     { importSettingsRepo.saveSettings(s); }

module.exports = {
    loadOptions, getMachineUrl, getMachineBaseUrl, getSyncIntervalMs, isOrdersEnabled,
    loadOrders, saveOrders, loadMenu, saveMenu,
    loadOrdersSettings, saveOrdersSettings,
    loadNotifyMapping, saveNotifyMapping,
    loadLibrary, saveLibrary,
    loadAnnotations, loadTrash,
    loadImportSettings, saveImportSettings,
};
