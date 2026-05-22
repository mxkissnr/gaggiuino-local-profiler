const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();

const PORT          = 8099;
const DATA_DIR      = '/data';
const DATA_FILE     = '/data/shots.json';
const ANNOTATIONS_FILE = '/data/annotations.json';
const TRASH_FILE    = '/data/trash.json';
const OPTIONS_FILE  = '/data/options.json';
const TRASH_TTL_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days

// HA Supervisor API (available when homeassistant_api: true in config.yaml)
const HA_API   = 'http://supervisor/core/api';
const HA_TOKEN = process.env.SUPERVISOR_TOKEN;

const ALLOWED_URL_SCHEMES = ['http:', 'https:'];
const MAX_SHOT_ID = 100000;

let lastSyncTime    = null;
let lastSyncError   = null;
let lastManualSync  = 0;
let lastKnownShotId = 0;  // tracks latest_shot_id from HA to trigger auto-sync

// Live polling state
const liveClients = new Set();
let livePollTimer  = null;
let liveAccum      = null; // shot data accumulator during brew
let isPollRunning  = false;

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
            log(`⚠️ Ungültiges URL-Schema: ${u.protocol} – Fallback auf Standard`, true);
            return 'http://gaggia.intern/api/shots';
        }
        return raw;
    } catch (e) {
        log(`⚠️ Ungültige machine_url – Fallback auf Standard`, true);
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
        log(`🗑 Auto-purged ${expired.length} shot(s) from trash (>30 days): ${expired.join(', ')}`);
    } catch (e) {
        log(`❌ Trash purge error: ${e.message}`, true);
    }
}

try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, '[]', 'utf8');
        log(`📂 Neue Datenbank unter ${DATA_FILE} initialisiert.`);
    } else {
        log(`📂 Bestehende Datenbank unter ${DATA_FILE} gefunden.`);
    }
    if (!fs.existsSync(ANNOTATIONS_FILE)) fs.writeFileSync(ANNOTATIONS_FILE, '{}', 'utf8');
} catch (err) {
    log(`❌ Fehler bei der Initialisierung: ${err.message}`, true);
}

app.use(express.json({ limit: '16kb' }));

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
        log(`❌ Fehler beim Auslesen: ${err.message}`, true);
        res.status(500).json({ error: 'Fehler beim Laden' });
    }
});

app.get('/api/status', (req, res) => {
    const opts = loadOptions();
    let shotCount = 0;
    try { shotCount = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).length; } catch (e) {}
    res.json({
        shotCount,
        lastSync:      lastSyncTime,
        lastSyncError,
        machineUrl:    getMachineUrl(opts),
        syncInterval:  opts.sync_interval || 5,
        haConnected:   !!HA_TOKEN,
        switchEntity:  opts.switch_entity || null
    });
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
        log(`🔌 Switch ${entity} → ${action}`);
    } catch (e) {
        log(`❌ Switch toggle Fehler: ${e.message}`, true);
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
        annotations[String(id)] = {
            rating:       Number.isInteger(req.body.rating) && req.body.rating >= 1 && req.body.rating <= 5
                              ? req.body.rating : null,
            coffee:       str(req.body.coffee,       200),
            grinder:      str(req.body.grinder,      200),
            grindSetting: str(req.body.grindSetting, 100),
            dose:         (typeof req.body.dose === 'number' && req.body.dose > 0 && req.body.dose < 100)
                              ? req.body.dose : null,
            notes:        str(req.body.notes, 2000)
        };
        fs.writeFileSync(ANNOTATIONS_FILE, JSON.stringify(annotations, null, 2), 'utf8');
        res.json({ ok: true });
    } catch (err) {
        log(`❌ Annotation-Fehler: ${err.message}`, true);
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
        log(`🗑 Shot ${id} moved to trash`);
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
        log(`♻️ Shot ${id} restored from trash`);
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
        log(`🗑 Shot ${id} deleted`);
        res.json({ ok: true });
    } catch (err) {
        log(`❌ Delete error: ${err.message}`, true);
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// ── Live SSE endpoint ─────────────────────────────────────────────────────

app.get('/api/live', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'connected', haConnected: !!HA_TOKEN })}\n\n`);
    liveClients.add(res);
    if (liveClients.size === 1) startLivePolling();

    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (e) {}
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        liveClients.delete(res);
        if (liveClients.size === 0) stopLivePolling();
    });
});

function broadcastLive(payload) {
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of liveClients) {
        try { client.write(msg); } catch (e) { liveClients.delete(client); }
    }
}

function startLivePolling() {
    if (livePollTimer) return;
    log('▶ Live-Polling gestartet via Gaggiuino /api/system/status');
    livePollTimer = setInterval(pollLive, 1000);
}

function stopLivePolling() {
    if (!livePollTimer) return;
    clearInterval(livePollTimer);
    livePollTimer = null;
    liveAccum     = null;
    log('⏹ Live-Polling gestoppt');
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
        const status    = statusRes.data;

        const isBrewing = status.brewSwitchState === true;
        const presVal   = parseFloat(status.pressure)          || 0;
        const tempVal   = parseFloat(status.temperature)       || 0;
        const weightVal = parseFloat(status.weight)            || 0;
        const tTempVal  = parseFloat(status.targetTemperature) || 0;
        const profile   = status.profileName || 'Unknown';

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
            log(`☕ Bezug gestartet – Profil: ${profile}`);
        }

        // Brew end
        if (!isBrewing && liveAccum) {
            log('✅ Bezug beendet');
            liveAccum = null;
            setTimeout(syncAfterBrew, 3000);
        }

        // Accumulate datapoints during brew (×10 to match Gaggiuino shot format)
        if (isBrewing && liveAccum) {
            const elapsed    = Math.round((Date.now() - liveAccum.startTime) / 100);
            const weightFlow = Math.max(0, weightVal - liveAccum.prevWeight);
            liveAccum.prevWeight = weightVal;

            liveAccum.datapoints.timeInShot.push(elapsed * 10);
            liveAccum.datapoints.pressure.push(Math.round(presVal * 10));
            liveAccum.datapoints.temperature.push(Math.round(tempVal * 10));
            liveAccum.datapoints.shotWeight.push(Math.round(weightVal * 10));
            liveAccum.datapoints.weightFlow.push(Math.round(weightFlow * 10));
            liveAccum.datapoints.pumpFlow.push(0);
            liveAccum.datapoints.targetTemperature.push(Math.round(tTempVal * 10));
        }

        broadcastLive({
            type:        'data',
            isLive:      isBrewing,
            profileName: liveAccum ? liveAccum.profileName : profile,
            datapoints:  liveAccum ? liveAccum.datapoints : null
        });

    } catch (err) {
        broadcastLive({ type: 'error', message: err.message });
    }
}

// ── Background: check latest_shot_id via HA for auto-sync ─────────────────

async function backgroundHaCheck() {
    if (!HA_TOKEN) return;
    try {
        const headers = { Authorization: `Bearer ${HA_TOKEN}` };
        const res     = await axios.get(
            `${HA_API}/states/sensor.gaggiuino_latest_shot_id`,
            { headers, timeout: 3000 }
        );
        const shotId = parseInt(res.data.state) || 0;
        if (shotId > lastKnownShotId && lastKnownShotId > 0) {
            log(`📥 Neue Shot-ID erkannt: ${shotId} – auto-sync`);
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
            const ids = newShots.map(s => s.id);
            broadcastLive({ type: 'shot_saved', shotIds: ids });
            log(`📤 Neuer Shot gespeichert: #${ids.join(', ')}`);
        }
    } catch (e) {}
}

// ── Background sync ───────────────────────────────────────────────────────

async function syncShots() {
    const opts       = loadOptions();
    const machineUrl = getMachineUrl(opts);
    try {
        const latestResponse  = await axios.get(`${machineUrl}/latest`, { timeout: 10000 });
        const latestMachineId = latestResponse.data[0].lastShotId;

        let localShots = [];
        if (fs.existsSync(DATA_FILE)) {
            const content = fs.readFileSync(DATA_FILE, 'utf8');
            localShots = content ? JSON.parse(content) : [];
        }

        const maxLocalId = localShots.length > 0
            ? localShots.reduce((max, s) => s.id > max ? s.id : max, 0) : 0;

        if (maxLocalId >= latestMachineId) {
            log(`Alles aktuell. Shots: ${localShots.length}`);
            lastSyncTime  = new Date().toISOString();
            lastSyncError = null;
            return;
        }

        for (let i = maxLocalId + 1; i <= latestMachineId; i++) {
            const r = await axios.get(`${machineUrl}/${i}`, { timeout: 10000 });
            if (!r.data || typeof r.data.id === 'undefined' || !r.data.datapoints) {
                log(`⚠️ Shot ${i} hat ungültige Daten – übersprungen`, true);
                continue;
            }
            localShots.push(r.data);
        }

        fs.writeFileSync(DATA_FILE, JSON.stringify(localShots, null, 2), 'utf8');
        lastSyncTime  = new Date().toISOString();
        lastSyncError = null;
        log(`✅ Sync abgeschlossen. ${localShots.length} Shots gespeichert.`);
    } catch (err) {
        lastSyncError = err.message;
        lastSyncTime  = new Date().toISOString();
        log(`❌ Sync-Fehler: ${err.message}`, true);
    }
}

function scheduleNextSync() {
    const opts = loadOptions();
    setTimeout(async () => {
        await syncShots();
        scheduleNextSync();
    }, getSyncIntervalMs(opts));
}

app.listen(PORT, () => {
    log(`🚀 Gaggiuino Local Profiler v1.18.4 gestartet auf Port ${PORT}`);
    const opts = loadOptions();
    log(`🔗 ${getMachineUrl(opts)}  |  Sync alle ${opts.sync_interval || 5} min`);
    log(`🏠 HA-Integration: ${HA_TOKEN ? 'aktiv (auto-sync via latest_shot_id)' : 'nicht verfügbar (kein SUPERVISOR_TOKEN)'}`);
    setInterval(backgroundHaCheck, 30000);
    purgeExpiredTrash();
    setInterval(purgeExpiredTrash, 24 * 60 * 60 * 1000); // daily
    syncShots().then(scheduleNextSync);
});
