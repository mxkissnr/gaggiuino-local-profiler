const fs = require('fs');
const {
    OPTIONS_FILE, ANNOTATIONS_FILE, TRASH_FILE, BLOCKLIST_FILE, LIBRARY_FILE,
    MAINTENANCE_FILE, MAINTENANCE_LOG_FILE, ORDERS_FILE, MENU_FILE, ORDERS_SETTINGS_FILE,
    NOTIFY_MAPPING_FILE, DATA_FILE,
    ORDERS_HISTORY_TTL_MS, TRASH_TTL_MS,
    DEFAULT_MENU, MAINTENANCE_DEFAULTS, ALLOWED_URL_SCHEMES,
} = require('./constants');
const { log, writeFileSafe } = require('./helpers');

function loadJson(file, defaultValue) {
    try {
        if (fs.existsSync(file))
            return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {}
    return typeof defaultValue === 'function' ? defaultValue() : defaultValue;
}

// ── Machine URL helpers ───────────────────────────────────────────────────

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
    } catch (e) {
        log(`Invalid machine_host value -- using default`, true);
        return 'http://gaggia.intern/api/shots';
    }
}

function getMachineBaseUrl(opts) {
    try {
        const u = new URL(getMachineUrl(opts));
        return `${u.protocol}//${u.host}`;
    } catch (e) { return 'http://gaggia.intern'; }
}

function getSyncIntervalMs(opts) {
    return (opts.sync_interval || 5) * 60 * 1000;
}

// ── Shots / Annotations / Trash / Blocklist ───────────────────────────────

function loadAnnotations()   { return loadJson(ANNOTATIONS_FILE, {}); }
function saveAnnotations(a)  { writeFileSafe(ANNOTATIONS_FILE, a); }

function loadTrash()         { return loadJson(TRASH_FILE, {}); }
function saveTrash(trash)    { writeFileSafe(TRASH_FILE, trash); }

function loadBlocklist()     { return loadJson(BLOCKLIST_FILE, []); }
function saveBlocklist(list) { writeFileSafe(BLOCKLIST_FILE, list); }

// ── Library ───────────────────────────────────────────────────────────────

function loadLibrary() {
    try {
        if (fs.existsSync(LIBRARY_FILE)) {
            const lib = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
            if (!lib.recipes) lib.recipes = [];
            if (!lib.milks)   lib.milks   = [];
            return lib;
        }
    } catch (e) {}
    return { beans: [], grinders: [], recipes: [], milks: [] };
}
function saveLibrary(lib) { writeFileSafe(LIBRARY_FILE, lib); }

// ── Maintenance ───────────────────────────────────────────────────────────

function loadMaintenance() {
    try {
        const saved  = fs.existsSync(MAINTENANCE_FILE)
            ? JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8')) : {};
        const result = JSON.parse(JSON.stringify(MAINTENANCE_DEFAULTS));
        for (const key of Object.keys(result)) {
            if (saved[key]) Object.assign(result[key], saved[key]);
        }
        for (const grinder of loadLibrary().grinders) {
            const key = `grinder_${grinder.id}`;
            const s   = saved[key] || {};
            result[key] = {
                lastDate:        s.lastDate        ?? null,
                threshold_shots: 'threshold_shots' in s ? s.threshold_shots : 200,
                threshold_days:  'threshold_days'  in s ? s.threshold_days  : null,
                grinderName:     grinder.name,
            };
        }
        return result;
    } catch (e) {}
    return JSON.parse(JSON.stringify(MAINTENANCE_DEFAULTS));
}
function saveMaintenance(data) { writeFileSafe(MAINTENANCE_FILE, data); }

// ── Maintenance Log ───────────────────────────────────────────────────────

function loadMaintenanceLog()        { return loadJson(MAINTENANCE_LOG_FILE, []); }
function saveMaintenanceLog(entries) { writeFileSafe(MAINTENANCE_LOG_FILE, entries); }

function addMaintenanceLogEntry(task, notes, machine) {
    let shotCount = 0;
    try { if (fs.existsSync(DATA_FILE)) shotCount = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).length; } catch {}
    const entries = loadMaintenanceLog();
    const entry = {
        id:              Date.now(),
        ts:              Math.floor(Date.now() / 1000),
        date:            new Date().toISOString().split('T')[0],
        task,
        machine:         machine || '',
        shotCountAtTime: shotCount,
        notes:           notes || '',
    };
    entries.unshift(entry);
    if (entries.length > 500) entries.splice(500);
    saveMaintenanceLog(entries);
    return entry;
}

function computeMaintenanceStats(maint) {
    let shots = [];
    try { if (fs.existsSync(DATA_FILE)) shots = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
    const now = Date.now();
    const result = {};
    for (const [key, task] of Object.entries(maint)) {
        const lastTs     = task.lastDate ? new Date(task.lastDate).getTime() : 0;
        const daysSince  = lastTs ? Math.floor((now - lastTs) / 86400000) : null;
        const shotsSince = shots.filter(s => s.timestamp * 1000 > lastTs).length;
        let pct = 0;
        if (task.threshold_shots && task.threshold_days)
            pct = Math.max(shotsSince / task.threshold_shots, daysSince !== null ? daysSince / task.threshold_days : 0);
        else if (task.threshold_shots)
            pct = shotsSince / task.threshold_shots;
        else if (task.threshold_days)
            pct = daysSince !== null ? daysSince / task.threshold_days : 0;
        const status = !task.lastDate ? 'never' : pct >= 1 ? 'due' : pct >= 0.8 ? 'soon' : 'ok';
        result[key] = { ...task, daysSince, shotsSince, pct: Math.min(pct, 1), status };
    }
    return result;
}

// ── Orders ────────────────────────────────────────────────────────────────

function loadMenu()          { return loadJson(MENU_FILE, DEFAULT_MENU); }
function saveMenu(menu)      { writeFileSafe(MENU_FILE, menu); }

function loadOrders() {
    try {
        if (!fs.existsSync(ORDERS_FILE)) return [];
        const orders  = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
        const cutoff  = Date.now() - ORDERS_HISTORY_TTL_MS;
        return orders.filter(o =>
            ['pending', 'accepted'].includes(o.status) ||
            (o.completedAt && o.completedAt > cutoff));
    } catch { return []; }
}
function saveOrders(orders) { writeFileSafe(ORDERS_FILE, orders); }

function loadOrdersSettings()  { return loadJson(ORDERS_SETTINGS_FILE, { enabled: true, broadcastRecipients: [] }); }
function saveOrdersSettings(s) { writeFileSafe(ORDERS_SETTINGS_FILE, s); }

function loadNotifyMapping()  { return loadJson(NOTIFY_MAPPING_FILE, {}); }
function saveNotifyMapping(m) { writeFileSafe(NOTIFY_MAPPING_FILE, m); }

function isOrdersEnabled() { return !!loadOptions().enable_orders; }

// ── Trash purge ───────────────────────────────────────────────────────────

function purgeExpiredTrash() {
    const trash = loadTrash();
    const now   = Date.now();
    const expired = Object.entries(trash)
        .filter(([, ts]) => now - ts > TRASH_TTL_MS)
        .map(([id]) => parseInt(id));
    if (expired.length === 0) return;
    try {
        let shots = [];
        if (fs.existsSync(DATA_FILE)) shots = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        shots = shots.filter(s => !expired.includes(s.id));
        writeFileSafe(DATA_FILE, shots);
        const annotations = loadAnnotations();
        expired.forEach(id => { delete annotations[String(id)]; delete trash[String(id)]; });
        saveAnnotations(annotations);
        saveTrash(trash);
        log(`Auto-purged ${expired.length} shot(s) from trash (>30 days): ${expired.join(', ')}`);
    } catch (e) {
        log(`Trash purge error: ${e.message}`, true);
    }
}

module.exports = {
    loadOptions, getMachineUrl, getMachineBaseUrl, getSyncIntervalMs,
    loadAnnotations, saveAnnotations, loadTrash, saveTrash,
    loadBlocklist, saveBlocklist, loadLibrary, saveLibrary,
    loadMaintenance, saveMaintenance, computeMaintenanceStats,
    loadMaintenanceLog, saveMaintenanceLog, addMaintenanceLogEntry,
    loadMenu, saveMenu, loadOrders, saveOrders,
    loadOrdersSettings, saveOrdersSettings,
    loadNotifyMapping, saveNotifyMapping,
    isOrdersEnabled, purgeExpiredTrash,
};
