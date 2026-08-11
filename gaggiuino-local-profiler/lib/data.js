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
const shotDefaultsRepo   = require('./repositories/ShotDefaultsRepository');

function loadOptions() {
    try {
        if (fs.existsSync(OPTIONS_FILE))
            return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
    } catch (e) { log(`Could not read options.json: ${e.message}`, true); }
    // #764: standalone Docker (no Supervisor) never gets an options.json
    // written -- Supervisor is the only writer, see the module comment above.
    // Fall back to env vars, same pattern as MACHINE_URL in getMachineUrl()
    // below. Values are left undefined/false when unset, matching what an
    // absent key in options.json already means to every caller here.
    return {
        sync_interval: process.env.GLP_SYNC_INTERVAL ? Number(process.env.GLP_SYNC_INTERVAL) : undefined,
        preheat_time:  process.env.GLP_PREHEAT_TIME  ? Number(process.env.GLP_PREHEAT_TIME)  : undefined,
        enable_orders: process.env.GLP_ENABLE_ORDERS === 'true',
        debug_logging: process.env.GLP_DEBUG_LOGGING === 'true',
        // #803: unlike the booleans above, this one defaults to true (open),
        // so unset/anything-but-'false' must resolve to true here too -- see
        // isApiPortExposed() below for why the default can't be "off".
        expose_api_port: process.env.GLP_EXPOSE_API_PORT !== 'false',
    };
}

// #718: null means "genuinely nothing configured anywhere" -- callers must
// treat that as "skip, don't request" rather than contacting a fallback
// host. A malformed-but-non-empty value (bad scheme, unparseable) is a
// different case -- that keeps its own explicit-default fallback below
// (#699's tests cover it), since there the user typed *something* and a
// clear signal beats a silent null.
function getMachineUrl(opts) {
    const raw = (opts.machine_host || opts.machine_url || process.env.MACHINE_URL || '').trim();
    if (!raw) return null;
    // #699: normalise unconditionally instead of only appending /api/shots
    // when no scheme is present -- a host entered *with* a scheme (e.g.
    // "http://192.168.1.50/", the format the Machines "Add machine" dialog
    // and the legacy machine_host option both accept) used to be returned
    // as-is, silently dropping /api/shots and breaking shot sync while
    // status/live polling (which only ever reduce to origin) kept working.
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
        const u = new URL(withScheme);
        if (!ALLOWED_URL_SCHEMES.includes(u.protocol)) {
            log(`Invalid URL scheme: ${u.protocol} -- using default`, true);
            return 'http://gaggia.intern/api/shots';
        }
        return `${u.protocol}//${u.host}/api/shots`;
    } catch {
        log('Invalid machine_host value -- using default', true);
        return 'http://gaggia.intern/api/shots';
    }
}

function getMachineBaseUrl(opts) {
    const url = getMachineUrl(opts);
    if (!url) return null;
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}`;
    } catch { return null; }
}

function getSyncIntervalMs(opts) {
    return (opts.sync_interval || 5) * 60 * 1000;
}

function isOrdersEnabled() { return !!loadOptions().enable_orders; }

// #483: add-on config toggle (Home Assistant → Add-on-Konfiguration), same
// pattern as isOrdersEnabled — off by default so debug-level detail never
// spams production logs, switchable on when actually diagnosing something
// (e.g. the import flow, routes/import.js) without a code change.
function isDebugLoggingEnabled() { return !!loadOptions().debug_logging; }
function debugLog(message) { if (isDebugLoggingEnabled()) log(`[debug] ${message}`); }

// #803: opposite default from isOrdersEnabled/isDebugLoggingEnabled above --
// this one must stay true when the key is missing, both when options.json
// exists but predates this option (upgrading install) and when it's absent
// entirely (standalone Docker, env-var fallback above already defaults to
// true too). Only an explicit `false` in options.json turns it off; that is
// the whole point (see routes/system.js GET /api/token) -- a heuristic
// default-off here would repeat the v2.19.1 regression this option exists
// to avoid.
function isApiPortExposed() { return loadOptions().expose_api_port !== false; }

// ── Order shims ───────────────────────────────────────────────────────────────
function loadOrders()          { return orderRepo.findActive(); }
function loadAllOrders()       { return orderRepo.findAll(); }
// #327: this used to DELETE FROM orders then reinsert only `orders` — every
// call site passes an array derived from loadOrders() (the 7-day-filtered
// active view), so that wiped any done/declined order older than 7 days
// from the DB on every single order mutation. saveAll() is upsert-only
// (INSERT OR REPLACE) and never deletes rows absent from the array.
// #326: saveAll()/save() also persist machine_id (the orders table's
// machine_id column, added by #317's migration but unused until now) so an
// order's machine target can be queried/filtered at the SQL level, not just
// read back out of the JSON blob — see OrderRepository.
function saveOrders(orders)    { orderRepo.saveAll(orders); }
function deleteOrder(id)       { orderRepo.delete(id); }
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

// ── Shot defaults shims (#654) ─────────────────────────────────────────────────
function loadShotDefaults()        { return shotDefaultsRepo.getDefaults(); }
function saveShotDefaults(s)       { shotDefaultsRepo.saveDefaults(s); }

module.exports = {
    loadOptions, getMachineUrl, getMachineBaseUrl, getSyncIntervalMs, isOrdersEnabled,
    isDebugLoggingEnabled, debugLog, isApiPortExposed,
    loadOrders, loadAllOrders, saveOrders, deleteOrder, loadMenu, saveMenu,
    loadOrdersSettings, saveOrdersSettings,
    loadNotifyMapping, saveNotifyMapping,
    loadLibrary, saveLibrary,
    loadAnnotations, loadTrash,
    loadImportSettings, saveImportSettings,
    loadShotDefaults, saveShotDefaults,
};
