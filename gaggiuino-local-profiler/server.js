const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

const GLP_VERSION   = '1.35.0';
const DEFAULT_PORT  = 8099;
const DATA_DIR           = '/data';
const TOKEN_FILE         = '/data/api_token.txt';
const PREHEAT_STATE_FILE = '/data/preheat_state.json';
const DATA_FILE          = '/data/shots.json';
const ANNOTATIONS_FILE = '/data/annotations.json';
const TRASH_FILE     = '/data/trash.json';
const BLOCKLIST_FILE = '/data/blocklist.json';
const OPTIONS_FILE   = '/data/options.json';
const LIBRARY_FILE      = '/data/coffee_library.json';
const MAINTENANCE_FILE  = '/data/maintenance.json';
const TRASH_TTL_MS      = 30 * 24 * 60 * 60 * 1000; // 30 days

const MAINTENANCE_DEFAULTS = {
    descaling:   { lastDate: null, threshold_shots: 200, threshold_days: 60  },
    backflush:   { lastDate: null, threshold_shots: 20,  threshold_days: null },
    grouphead:   { lastDate: null, threshold_shots: null, threshold_days: 180 },
    gaskets:     { lastDate: null, threshold_shots: null, threshold_days: 365 },
    waterfilter: { lastDate: null, threshold_shots: null, threshold_days: 90  },
};

function loadMaintenance() {
    try {
        if (fs.existsSync(MAINTENANCE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8'));
            const result = JSON.parse(JSON.stringify(MAINTENANCE_DEFAULTS));
            for (const key of Object.keys(result)) {
                if (saved[key]) Object.assign(result[key], saved[key]);
            }
            return result;
        }
    } catch (e) {}
    return JSON.parse(JSON.stringify(MAINTENANCE_DEFAULTS));
}

function saveMaintenance(data) {
    fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function computeMaintenanceStats(maint) {
    let shots = [];
    try { if (fs.existsSync(DATA_FILE)) shots = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
    const now = Date.now();
    const result = {};
    for (const [key, task] of Object.entries(maint)) {
        const lastTs    = task.lastDate ? new Date(task.lastDate).getTime() : 0;
        const daysSince = lastTs ? Math.floor((now - lastTs) / 86400000) : null;
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

// HA Supervisor API (available when homeassistant_api: true in config.yaml)
const HA_API   = 'http://supervisor/core/api';
const HA_TOKEN = process.env.SUPERVISOR_TOKEN;

const ALLOWED_URL_SCHEMES = ['http:', 'https:'];
const MAX_SHOT_ID = 100000;

let lastSyncTime      = null;
let lastSyncError     = null;
let lastManualSync    = 0;
let lastKnownShotId   = 0;  // tracks latest_shot_id from HA to trigger auto-sync
let cachedMachineVersion = null; // firmware version from controller, fetched once
let apiToken          = ''; // auto-generated on first start, persisted in TOKEN_FILE

function loadOrCreateApiToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            apiToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        } else {
            apiToken = crypto.randomBytes(32).toString('hex');
            fs.writeFileSync(TOKEN_FILE, apiToken, 'utf8');
            log('API token generated');
        }
    } catch (e) {
        log(`Could not load/create API token: ${e.message}`, true);
    }
}

// Live polling state
let livePollTimer  = null;
let liveAccum      = null; // shot data accumulator during brew
let isPollRunning  = false;
let machineOn      = false; // updated by checkAndApplyMachinePower() on startup and every 30s

// Preheat state
let switchOnAt     = null; // ms timestamp when preheat timer started
let switchOffAt    = null; // ms timestamp when machine last switched off
let currentTemp    = null; // latest temperature reading from machine (°C)

// Temperature stability detection
const TEMP_HISTORY_MAX   = 60;  // keep 60 readings (= 60 s at 1 Hz)
const TEMP_STABLE_MIN    = 30;  // need at least 30 readings before deciding
const TEMP_STABLE_VAR    = 1.5; // max variance (°C²) to consider temp stable
const PREHEAT_STATE_TTL  = 24 * 60 * 60 * 1000; // discard persisted state older than 24 h
let tempHistory = [];

function savePreheatState() {
    try { fs.writeFileSync(PREHEAT_STATE_FILE, JSON.stringify({ switchOnAt, switchOffAt }), 'utf8'); } catch (e) {}
}

function loadPreheatState() {
    try {
        if (!fs.existsSync(PREHEAT_STATE_FILE)) return;
        const s = JSON.parse(fs.readFileSync(PREHEAT_STATE_FILE, 'utf8'));
        const now = Date.now();
        if (s.switchOnAt && (now - s.switchOnAt) < PREHEAT_STATE_TTL) switchOnAt = s.switchOnAt;
        if (s.switchOffAt && (now - s.switchOffAt) < PREHEAT_STATE_TTL) switchOffAt = s.switchOffAt;
        if (switchOnAt) log(`Preheat state restored: started ${Math.round((now - switchOnAt) / 60000)} min ago`);
    } catch (e) {}
}

function isTempStable() {
    if (tempHistory.length < TEMP_STABLE_MIN) return false;
    const mean = tempHistory.reduce((a, b) => a + b, 0) / tempHistory.length;
    const variance = tempHistory.reduce((sum, t) => sum + (t - mean) ** 2, 0) / tempHistory.length;
    return variance < TEMP_STABLE_VAR;
}

function log(message, isError = false) {
    const now = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    if (isError) console.error(`[${now}] ${message}`);
    else         console.log(`[${now}] ${message}`);
}

function loadOptions() {
    try {
        if (fs.existsSync(OPTIONS_FILE))
            return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
    } catch (e) { log(`Konnte options.json nicht lesen: ${e.message}`, true); }
    return {};
}

function getMachineUrl(opts) {
    const raw = opts.machine_url || process.env.MACHINE_URL || 'http://gaggia.intern/api/shots';
    try {
        const u = new URL(raw);
        if (!ALLOWED_URL_SCHEMES.includes(u.protocol)) {
            log(`Invalid URL scheme: ${u.protocol} -- using default`, true);
            return 'http://gaggia.intern/api/shots';
        }
        return raw;
    } catch (e) {
        log(`Invalid machine_url -- using default`, true);
        return 'http://gaggia.intern/api/shots';
    }
}

function getMachineBaseUrl(opts) {
    const machineUrl = getMachineUrl(opts);
    try {
        const u = new URL(machineUrl);
        return `${u.protocol}//${u.host}`;
    } catch (e) {
        return 'http://gaggia.intern';
    }
}

function getSyncIntervalMs(opts) {
    return (opts.sync_interval || 5) * 60 * 1000;
}

function loadAnnotations() {
    try {
        if (fs.existsSync(ANNOTATIONS_FILE))
            return JSON.parse(fs.readFileSync(ANNOTATIONS_FILE, 'utf8'));
    } catch (e) {}
    return {};
}

function loadTrash() {
    try {
        if (fs.existsSync(TRASH_FILE))
            return JSON.parse(fs.readFileSync(TRASH_FILE, 'utf8'));
    } catch (e) {}
    return {};
}

function saveTrash(trash) {
    fs.writeFileSync(TRASH_FILE, JSON.stringify(trash, null, 2), 'utf8');
}

function loadBlocklist() {
    try {
        if (fs.existsSync(BLOCKLIST_FILE))
            return JSON.parse(fs.readFileSync(BLOCKLIST_FILE, 'utf8'));
    } catch (e) {}
    return [];
}

function saveBlocklist(list) {
    fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function loadLibrary() {
    try {
        if (fs.existsSync(LIBRARY_FILE))
            return JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
    } catch (e) {}
    return { beans: [], grinders: [] };
}

function saveLibrary(lib) {
    fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2), 'utf8');
}

async function fetchMachineVersion() {
    if (cachedMachineVersion) return;
    const opts    = loadOptions();
    const baseUrl = getMachineBaseUrl(opts);
    try {
        const res  = await axios.get(`${baseUrl}/api/system/info`, { timeout: 3000 });
        const data = res.data || {};
        const ver  = data.version || data.firmware || data.softwareVersion || data.fw_version || null;
        if (ver) { cachedMachineVersion = String(ver); log(`Gaggiuino firmware: ${cachedMachineVersion}`); }
    } catch (_) { /* endpoint may not exist — silently ignore */ }
}

function purgeExpiredTrash() {
    const trash = loadTrash();
    const now = Date.now();
    const expired = Object.entries(trash)
        .filter(([, ts]) => now - ts > TRASH_TTL_MS)
        .map(([id]) => parseInt(id));
    if (expired.length === 0) return;
    try {
        let shots = [];
        if (fs.existsSync(DATA_FILE)) shots = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        shots = shots.filter(s => !expired.includes(s.id));
        fs.writeFileSync(DATA_FILE, JSON.stringify(shots, null, 2), 'utf8');
        const annotations = loadAnnotations();
        expired.forEach(id => { delete annotations[String(id)]; delete trash[String(id)]; });
        fs.writeFileSync(ANNOTATIONS_FILE, JSON.stringify(annotations, null, 2), 'utf8');
        saveTrash(trash);
        log(`Auto-purged ${expired.length} shot(s) from trash (>30 days): ${expired.join(', ')}`);
    } catch (e) {
        log(`Trash purge error: ${e.message}`, true);
    }
}

try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, '[]', 'utf8');
        log(`Database initialized: ${DATA_FILE}`);
    } else {
        log(`Database loaded: ${DATA_FILE}`);
    }
    if (!fs.existsSync(ANNOTATIONS_FILE)) fs.writeFileSync(ANNOTATIONS_FILE, '{}', 'utf8');
    if (!fs.existsSync(LIBRARY_FILE))    fs.writeFileSync(LIBRARY_FILE, JSON.stringify({ beans: [], grinders: [] }, null, 2), 'utf8');
} catch (err) {
    log(`Init error: ${err.message}`, true);
}

app.use(express.json({ limit: '16kb' }));

// ── API token auth middleware ─────────────────────────────────────────────
app.use((req, res, next) => {
    if (!apiToken) return next();
    if (req.headers['x-ingress-path'] !== undefined) return next(); // HA ingress → already authed
    if (req.path === '/api/status') return next(); // status is public — used to distribute token
    if (!req.path.startsWith('/api/') && req.path !== '/shots.json') return next(); // static files
    if (req.headers['x-glp-token'] === apiToken) return next();
    res.status(401).json({ error: 'Unauthorized' });
});

// ── API routes (before static) ────────────────────────────────────────────

app.get('/shots.json', (req, res) => {
    try {
        let shots = [];
        if (fs.existsSync(DATA_FILE)) shots = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const annotations = loadAnnotations();
        const trash = loadTrash();
        const includeTrash = req.query.trash === '1';
        const filtered = includeTrash
            ? shots.filter(s => trash[String(s.id)])
            : shots.filter(s => !trash[String(s.id)]);
        const merged = filtered.map(s => {
            const ann = annotations[String(s.id)];
            const trashedAt = trash[String(s.id)] || null;
            return { ...s, ...(ann ? { annotation: ann } : {}), ...(trashedAt ? { trashedAt } : {}) };
        });
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(merged));
    } catch (err) {
        log(`Read error: ${err.message}`, true);
        res.status(500).json({ error: 'Fehler beim Laden' });
    }
});

app.get('/api/status', (req, res) => {
    const opts       = loadOptions();
    const machineUrl = getMachineUrl(opts);
    let shotCount = 0;
    let machineHostname = '';
    try { shotCount = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).length; } catch (e) {}
    try { machineHostname = new URL(machineUrl).hostname; } catch (e) {}
    res.json({
        shotCount,
        lastSync:        lastSyncTime,
        lastSyncError,
        machineUrl,
        machineHostname,
        machineVersion:  cachedMachineVersion,
        syncInterval:    opts.sync_interval || 5,
        haConnected:     !!HA_TOKEN,
        switchEntity:    opts.switch_entity || null,
        glpVersion:      GLP_VERSION,
        apiToken:        apiToken || null
    });
});

// ── Debug: raw machine status passthrough ────────────────────────────────
app.get('/api/debug/machine', async (req, res) => {
    const opts    = loadOptions();
    const baseUrl = getMachineBaseUrl(opts);
    try {
        const r = await axios.get(`${baseUrl}/api/system/status`, { timeout: 5000 });
        res.json({ ok: true, baseUrl, data: r.data });
    } catch (e) {
        res.json({ ok: false, baseUrl, error: e.message });
    }
});

// ── Machine power switch ──────────────────────────────────────────────────
async function getSwitchState(entity) {
    if (!HA_TOKEN || !entity) return null;
    try {
        const r = await axios.get(`${HA_API}/states/${entity}`,
            { headers: { Authorization: `Bearer ${HA_TOKEN}` }, timeout: 3000 });
        return r.data.state === 'on';
    } catch (e) { return null; }
}

app.get('/api/switch', async (req, res) => {
    const opts   = loadOptions();
    const entity = opts.switch_entity;
    if (!entity) return res.json({ configured: false });
    const state  = await getSwitchState(entity);
    res.json({ configured: true, entity, state });
});

app.post('/api/switch/toggle', async (req, res) => {
    const opts   = loadOptions();
    const entity = opts.switch_entity;
    if (!HA_TOKEN || !entity)
        return res.status(400).json({ error: 'switch_entity nicht konfiguriert' });
    try {
        const current = await getSwitchState(entity);
        const action  = current ? 'turn_off' : 'turn_on';
        await axios.post(`${HA_API}/services/switch/${action}`,
            { entity_id: entity },
            { headers: { Authorization: `Bearer ${HA_TOKEN}` }, timeout: 5000 });
        res.json({ ok: true, state: !current });
        log(`Switch ${entity} -> ${action}`);
    } catch (e) {
        log(`Switch toggle error: ${e.message}`, true);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/sync', (req, res) => {
    const now = Date.now();
    if (now - lastManualSync < 30000)
        return res.status(429).json({ error: 'Bitte 30 Sekunden zwischen manuellen Syncs warten.' });
    lastManualSync = now;
    res.json({ ok: true });
    syncShots();
});

app.post('/api/shots/:id/annotate', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id < 1 || id > MAX_SHOT_ID)
        return res.status(400).json({ error: 'Ungültige Shot-ID' });
    try {
        const annotations = loadAnnotations();
        const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
        const num = (v, min, max) => (typeof v === 'number' && v >= min && v <= max) ? v : null;
        annotations[String(id)] = {
            rating:       Number.isInteger(req.body.rating) && req.body.rating >= 1 && req.body.rating <= 5
                              ? req.body.rating : null,
            coffee:       str(req.body.coffee,       200),
            grinder:      str(req.body.grinder,      200),
            grindSetting: str(req.body.grindSetting, 100),
            dose:         num(req.body.dose,    0.1, 100),
            roastDate:    str(req.body.roastDate, 10),
            tds:          num(req.body.tds,     0.1,  30),
            notes:        str(req.body.notes,       2000)
        };
        fs.writeFileSync(ANNOTATIONS_FILE, JSON.stringify(annotations, null, 2), 'utf8');
        res.json({ ok: true });
    } catch (err) {
        log(`Annotation error: ${err.message}`, true);
        res.status(500).json({ error: 'Fehler beim Speichern' });
    }
});

app.post('/api/shots/:id/trash', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id < 1 || id > MAX_SHOT_ID)
        return res.status(400).json({ error: 'Invalid shot ID' });
    try {
        const trash = loadTrash();
        trash[String(id)] = Date.now();
        saveTrash(trash);
        log(`Shot ${id} moved to trash`);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/shots/:id/restore', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id < 1 || id > MAX_SHOT_ID)
        return res.status(400).json({ error: 'Invalid shot ID' });
    try {
        const trash = loadTrash();
        delete trash[String(id)];
        saveTrash(trash);
        log(`Shot ${id} restored from trash`);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/shots/:id/delete', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id < 1 || id > MAX_SHOT_ID)
        return res.status(400).json({ error: 'Invalid shot ID' });
    try {
        let shots = [];
        if (fs.existsSync(DATA_FILE)) shots = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const before = shots.length;
        shots = shots.filter(s => s.id !== id);
        if (shots.length === before) return res.status(404).json({ error: 'Shot not found' });
        fs.writeFileSync(DATA_FILE, JSON.stringify(shots, null, 2), 'utf8');
        const annotations = loadAnnotations();
        delete annotations[String(id)];
        fs.writeFileSync(ANNOTATIONS_FILE, JSON.stringify(annotations, null, 2), 'utf8');
        const blocklist = loadBlocklist();
        if (!blocklist.includes(id)) { blocklist.push(id); saveBlocklist(blocklist); }
        log(`Shot ${id} deleted (added to blocklist)`);
        res.json({ ok: true });
    } catch (err) {
        log(`Delete error: ${err.message}`, true);
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// ── Coffee Library ────────────────────────────────────────────────────────────

app.get('/api/library', (req, res) => {
    res.json(loadLibrary());
});

app.post('/api/library/bean', (req, res) => {
    const { name, roaster, roastDate, notes, stock_g } = req.body;
    if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });
    const s   = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const lib  = loadLibrary();
    const bean = { id: Date.now(), name: s(name, 200), roaster: s(roaster, 200), roastDate: s(roastDate, 10), notes: s(notes, 1000), stock_g: parseFloat(stock_g) || null };
    lib.beans.push(bean);
    saveLibrary(lib);
    res.json(bean);
});

app.put('/api/library/bean/:id', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    const idx = lib.beans.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const s = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : undefined;
    const { name, roaster, roastDate, notes, stock_g } = req.body;
    if (name !== undefined)      lib.beans[idx].name      = s(name, 200) || lib.beans[idx].name;
    if (roaster !== undefined)   lib.beans[idx].roaster   = s(roaster, 200);
    if (roastDate !== undefined) lib.beans[idx].roastDate = s(roastDate, 10);
    if (notes !== undefined)     lib.beans[idx].notes     = s(notes, 1000);
    if (stock_g !== undefined)   lib.beans[idx].stock_g   = parseFloat(stock_g) || null;
    saveLibrary(lib);
    res.json(lib.beans[idx]);
});

app.post('/api/library/bean/:id/delete', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    lib.beans = lib.beans.filter(b => b.id !== id);
    saveLibrary(lib);
    res.json({ ok: true });
});

app.post('/api/library/grinder', (req, res) => {
    const { name, notes } = req.body;
    if (!name || typeof name !== 'string' || !name.trim())
        return res.status(400).json({ error: 'name required' });
    const s       = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const lib     = loadLibrary();
    const grinder = { id: Date.now(), name: s(name, 200), notes: s(notes, 1000) };
    lib.grinders.push(grinder);
    saveLibrary(lib);
    res.json(grinder);
});

app.put('/api/library/grinder/:id', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    const idx = lib.grinders.findIndex(g => g.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const s = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : undefined;
    const { name, notes } = req.body;
    if (name !== undefined)  lib.grinders[idx].name  = s(name, 200) || lib.grinders[idx].name;
    if (notes !== undefined) lib.grinders[idx].notes = s(notes, 1000);
    saveLibrary(lib);
    res.json(lib.grinders[idx]);
});

app.post('/api/library/grinder/:id/delete', (req, res) => {
    const id  = parseInt(req.params.id, 10);
    const lib = loadLibrary();
    lib.grinders = lib.grinders.filter(g => g.id !== id);
    saveLibrary(lib);
    res.json({ ok: true });
});

// ── Live polling endpoint (replaces SSE — HA ServiceWorker blocks EventSource) ──

let liveSeq = 0; // increments on each brew-end so frontend can detect new shots

// ── Backup & Restore ─────────────────────────────────────────────────────

app.get('/api/backup', (req, res) => {
    try {
        const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
        const bundle = {
            glp_backup:     true,
            version:        GLP_VERSION,
            created:        new Date().toISOString(),
            shots:          read(DATA_FILE, []),
            annotations:    read(ANNOTATIONS_FILE, {}),
            coffee_library: read(LIBRARY_FILE, { beans: [], grinders: [] }),
            blocklist:      read(BLOCKLIST_FILE, []),
            trash:          read(TRASH_FILE, {})
        };
        const filename = `glp-backup-${new Date().toISOString().slice(0,10)}.json`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/json');
        res.json(bundle);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/restore', express.json({ limit: '50mb' }), (req, res) => {
    try {
        const b = req.body;
        if (!b || b.glp_backup !== true || !Array.isArray(b.shots)) {
            return res.status(400).json({ error: 'Invalid backup file' });
        }
        if (Array.isArray(b.shots))          fs.writeFileSync(DATA_FILE,       JSON.stringify(b.shots, null, 2), 'utf8');
        if (b.annotations && typeof b.annotations === 'object')
                                             fs.writeFileSync(ANNOTATIONS_FILE, JSON.stringify(b.annotations, null, 2), 'utf8');
        if (b.coffee_library && typeof b.coffee_library === 'object') fs.writeFileSync(LIBRARY_FILE, JSON.stringify(b.coffee_library, null, 2), 'utf8');
        if (Array.isArray(b.blocklist))      fs.writeFileSync(BLOCKLIST_FILE,  JSON.stringify(b.blocklist, null, 2), 'utf8');
        if (b.trash && typeof b.trash === 'object')
                                             fs.writeFileSync(TRASH_FILE,      JSON.stringify(b.trash, null, 2), 'utf8');
        log(`Restore completed from backup v${b.version || '?'} (${b.shots.length} shots)`);
        res.json({ ok: true, shots: b.shots.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/maintenance', (req, res) => {
    res.json(computeMaintenanceStats(loadMaintenance()));
});

const VALID_MAINTENANCE_TASKS = new Set(['descaling', 'backflush', 'grouphead', 'gaskets', 'waterfilter']);

app.post('/api/maintenance/:task/done', (req, res) => {
    if (!VALID_MAINTENANCE_TASKS.has(req.params.task)) return res.status(404).json({ error: 'Unknown task' });
    const maint = loadMaintenance();
    maint[req.params.task].lastDate = new Date().toISOString().split('T')[0];
    saveMaintenance(maint);
    res.json(computeMaintenanceStats(maint));
});

app.post('/api/maintenance/:task/threshold', express.json(), (req, res) => {
    if (!VALID_MAINTENANCE_TASKS.has(req.params.task)) return res.status(404).json({ error: 'Unknown task' });
    const maint = loadMaintenance();
    const { threshold_shots, threshold_days } = req.body;
    if (threshold_shots !== undefined) maint[req.params.task].threshold_shots = parseInt(threshold_shots) || null;
    if (threshold_days  !== undefined) maint[req.params.task].threshold_days  = parseInt(threshold_days)  || null;
    saveMaintenance(maint);
    res.json(computeMaintenanceStats(maint));
});

app.get('/api/preheat', (req, res) => {
    const opts        = loadOptions();
    const preheatMins = Math.max(1, parseInt(opts.preheat_time) || 20);
    const preheatMs   = preheatMins * 60 * 1000;

    const machineOff  = !machineOn && !!opts.switch_entity;
    if (machineOff || !switchOnAt) {
        return res.json({ ready: false, elapsed: 0, remaining: preheatMins * 60, pct: 0, preheatTime: preheatMins, temp: currentTemp });
    }

    const elapsedMs = Date.now() - switchOnAt;
    const elapsed   = Math.floor(elapsedMs / 1000);
    const remaining = Math.max(0, Math.ceil((preheatMs - elapsedMs) / 1000));
    const pct       = Math.min(1, elapsedMs / preheatMs);

    res.json({ ready: remaining === 0, elapsed, remaining, pct, preheatTime: preheatMins, temp: currentTemp });
});

app.get('/api/live/data', (req, res) => {
    res.json({
        isLive:      !!liveAccum,
        profileName: liveAccum?.profileName || '',
        datapoints:  liveAccum ? liveAccum.datapoints : null,
        seq:         liveSeq
    });
});

function startLivePolling() {
    if (livePollTimer) return;

    const WARM_TEMP_MIN   = 80;              // °C — machine considered still warm
    const WARM_OFF_MAX_MS = 5 * 60 * 1000;  // off < 5 min + warm temp = keep timer

    const offMs     = switchOffAt ? Date.now() - switchOffAt : Infinity;
    const stillWarm = currentTemp !== null && currentTemp > WARM_TEMP_MIN && offMs < WARM_OFF_MAX_MS;

    if (!switchOnAt || !stillWarm) { switchOnAt = Date.now(); savePreheatState(); }

    tempHistory = []; // reset stability buffer on new session
    log('Live polling started via /api/system/status');
    livePollTimer = setInterval(pollLive, 1000);
}

function stopLivePolling() {
    if (!livePollTimer) return;
    clearInterval(livePollTimer);
    livePollTimer = null;
    liveAccum     = null;
    switchOffAt   = Date.now();
    tempHistory   = [];
    savePreheatState();
    log('Live polling stopped');
}

async function checkAndApplyMachinePower() {
    const opts   = loadOptions();
    const entity = opts.switch_entity;
    if (!entity || !HA_TOKEN) {
        if (!livePollTimer) startLivePolling();
        return;
    }
    const isOn = await getSwitchState(entity);
    if (isOn === null) return; // HA unreachable — keep current state
    if (isOn === machineOn) return; // no change
    machineOn = isOn;
    if (isOn) {
        log('Machine on -- live polling and sync resumed');
        startLivePolling();
        setTimeout(syncShots, 2000); // give machine time to boot
    } else {
        log('Machine off -- live polling and sync paused');
        stopLivePolling();
    }
}

// ── Live polling: direct machine status API ───────────────────────────────

async function pollLive() {
    if (isPollRunning) return;
    isPollRunning = true;
    try { await pollViaGaggiuinoStatus(); }
    finally { isPollRunning = false; }
}

async function pollViaGaggiuinoStatus() {
    const opts    = loadOptions();
    const baseUrl = getMachineBaseUrl(opts);

    try {
        const statusRes = await axios.get(`${baseUrl}/api/system/status`, { timeout: 3000 });
        const raw       = statusRes.data;
        const status    = Array.isArray(raw) ? raw[0] : raw;

        const isBrewing = !!status.brewSwitchState;
        const presVal   = parseFloat(status.pressure)          || 0;
        const tempVal   = parseFloat(status.temperature)       || 0;
        currentTemp     = tempVal || currentTemp; // keep last known value if reading is 0
        const weightVal = parseFloat(status.weight)            || 0;
        const tTempVal  = parseFloat(status.targetTemperature) || 0;
        const profile   = status.profileName || 'Unknown';

        // Temperature stability — track history, detect completed preheat
        if (tempVal > 0 && !isBrewing) {
            tempHistory.push(tempVal);
            if (tempHistory.length > TEMP_HISTORY_MAX) tempHistory.shift();
            // If temp is stable and at/near target, preheat is done — advance switchOnAt so remaining = 0
            if (switchOnAt && tTempVal > 0 && tempVal >= tTempVal - 2 && isTempStable()) {
                const opts = loadOptions();
                const preheatMs = (Math.max(1, parseInt(opts.preheat_time) || 20)) * 60 * 1000;
                if (Date.now() - switchOnAt < preheatMs) {
                    switchOnAt = Date.now() - preheatMs;
                    savePreheatState();
                    log('Temperature stable -- preheat marked complete');
                }
            }
        } else if (isBrewing) {
            tempHistory = []; // clear during brew so next session starts fresh
        }

        // Brew start
        if (isBrewing && !liveAccum) {
            liveAccum = {
                startTime:   Date.now(),
                profileName: profile,
                prevWeight:  weightVal,
                datapoints: {
                    timeInShot:        [],
                    pressure:          [],
                    temperature:       [],
                    shotWeight:        [],
                    weightFlow:        [],
                    pumpFlow:          [],
                    targetTemperature: []
                }
            };
            log(`Brew started: profile ${profile}`);
        }

        // Brew end
        if (!isBrewing && liveAccum) {
            log('Brew finished');
            liveAccum = null;
            liveSeq++;
            setTimeout(syncAfterBrew, 3000);
        }

        // Accumulate datapoints during brew (×10 to match Gaggiuino shot format)
        if (isBrewing && liveAccum) {
            const elapsed    = Math.round((Date.now() - liveAccum.startTime) / 100);
            const weightFlow = Math.max(0, weightVal - liveAccum.prevWeight);
            liveAccum.prevWeight = weightVal;

            liveAccum.datapoints.timeInShot.push(elapsed);
            liveAccum.datapoints.pressure.push(Math.round(presVal * 10));
            liveAccum.datapoints.temperature.push(Math.round(tempVal * 10));
            liveAccum.datapoints.shotWeight.push(Math.round(weightVal * 10));
            liveAccum.datapoints.weightFlow.push(Math.round(weightFlow * 10));
            liveAccum.datapoints.pumpFlow.push(0);
            liveAccum.datapoints.targetTemperature.push(Math.round(tTempVal * 10));
        }

    } catch (err) {
        log(`Live poll error: ${err.message}`, true);
    }
}

// ── Background: check latest_shot_id via HA for auto-sync ─────────────────

async function backgroundHaCheck() {
    if (!HA_TOKEN) return;
    await checkAndApplyMachinePower();
    if (!cachedMachineVersion) fetchMachineVersion();
    try {
        const headers = { Authorization: `Bearer ${HA_TOKEN}` };
        const res     = await axios.get(
            `${HA_API}/states/sensor.gaggiuino_latest_shot_id`,
            { headers, timeout: 3000 }
        );
        const shotId = parseInt(res.data.state) || 0;
        if (shotId > lastKnownShotId && lastKnownShotId > 0) {
            log(`New shot ID detected: ${shotId} -- auto-sync`);
            setTimeout(syncShots, 2000);
        }
        lastKnownShotId = shotId;
    } catch (e) {}
}

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ── Sync after brew: notify live clients of new shot ID ───────────────────

async function syncAfterBrew() {
    let prevMaxId = 0;
    try {
        const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        prevMaxId = existing.length > 0
            ? existing.reduce((m, s) => s.id > m ? s.id : m, 0) : 0;
    } catch (e) {}

    await syncShots();

    try {
        const updated  = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const newShots = updated.filter(s => s.id > prevMaxId);
        if (newShots.length > 0) {
            log(`New shot saved: #${newShots.map(s => s.id).join(', ')}`);
        }
    } catch (e) {}
}

// ── Background sync ───────────────────────────────────────────────────────

async function syncShots() {
    const opts       = loadOptions();
    if (!machineOn && opts.switch_entity) return; // machine off — skip sync
    const machineUrl = getMachineUrl(opts);
    try {
        const latestResponse  = await axios.get(`${machineUrl}/latest`, { timeout: 10000 });
        const latestMachineId = latestResponse.data[0].lastShotId;

        let localShots = [];
        if (fs.existsSync(DATA_FILE)) {
            const content = fs.readFileSync(DATA_FILE, 'utf8');
            localShots = content ? JSON.parse(content) : [];
        }

        const blocklist    = loadBlocklist();
        const maxLocalId   = localShots.length > 0
            ? localShots.reduce((max, s) => s.id > max ? s.id : max, 0) : 0;
        const maxBlockedId = blocklist.length > 0 ? Math.max(...blocklist) : 0;
        const effectiveMax = Math.max(maxLocalId, maxBlockedId);

        if (effectiveMax >= latestMachineId) {
            log(`Already up to date. Shots: ${localShots.length}`);
            lastSyncTime  = new Date().toISOString();
            lastSyncError = null;
            return;
        }

        for (let i = effectiveMax + 1; i <= latestMachineId; i++) {
            const r = await axios.get(`${machineUrl}/${i}`, { timeout: 10000 });
            if (!r.data || typeof r.data.id === 'undefined' || !r.data.datapoints) {
                log(`Shot ${i} has invalid data -- skipped`, true);
                continue;
            }
            if (cachedMachineVersion) r.data.glpFirmwareVersion = cachedMachineVersion;
            localShots.push(r.data);
        }

        fs.writeFileSync(DATA_FILE, JSON.stringify(localShots, null, 2), 'utf8');
        lastSyncTime  = new Date().toISOString();
        lastSyncError = null;
        log(`Sync complete: ${localShots.length} shots stored`);
    } catch (err) {
        lastSyncError = err.message.replace(/https?:\/\/\S+/g, '[url]');
        lastSyncTime  = new Date().toISOString();
        log(`Sync error: ${err.message}`, true);
    }
}

function scheduleNextSync() {
    const opts = loadOptions();
    setTimeout(async () => {
        await syncShots();
        scheduleNextSync();
    }, getSyncIntervalMs(opts));
}

loadOrCreateApiToken();
loadPreheatState();
const opts0 = loadOptions();
const PORT = opts0.port || DEFAULT_PORT;
app.listen(PORT, () => {
    log(`Gaggiuino Local Profiler v${GLP_VERSION} started on port ${PORT}`);
    const opts = loadOptions();
    log(`Machine URL: ${getMachineUrl(opts)} | sync every ${opts.sync_interval || 5} min`);
    log(`HA integration: ${HA_TOKEN ? 'active (auto-sync via latest_shot_id)' : 'unavailable (no SUPERVISOR_TOKEN)'}`);
    setInterval(backgroundHaCheck, 30000);
    purgeExpiredTrash();
    setInterval(purgeExpiredTrash, 24 * 60 * 60 * 1000); // daily
    fetchMachineVersion();
    checkAndApplyMachinePower().then(() => syncShots().then(scheduleNextSync));
});
