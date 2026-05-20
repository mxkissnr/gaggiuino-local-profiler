const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();

const PORT          = 8099;
const DATA_DIR      = '/data';
const DATA_FILE     = '/data/shots.json';
const ANNOTATIONS_FILE = '/data/annotations.json';
const OPTIONS_FILE  = '/data/options.json';

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
        const merged = shots.map(s => {
            const ann = annotations[String(s.id)];
            return ann ? { ...s, annotation: ann } : s;
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
        haConnected:   !!HA_TOKEN
    });
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
    const method = HA_TOKEN ? 'HA-Sensoren' : 'Gaggiuino-API (Fallback)';
    log(`▶ Live-Polling gestartet via ${method}`);
    livePollTimer = setInterval(pollLive, 1000);
}

function stopLivePolling() {
    if (!livePollTimer) return;
    clearInterval(livePollTimer);
    livePollTimer = null;
    liveAccum     = null;
    log('⏹ Live-Polling gestoppt');
}

// ── Live polling: HA sensors (primary) ───────────────────────────────────

async function pollLive() {
    if (HA_TOKEN) {
        await pollViaHaSensors();
    } else {
        await pollViaGaggiuinoApi();
    }
}

async function pollViaHaSensors() {
    const headers = { Authorization: `Bearer ${HA_TOKEN}` };

    const get = (entity) =>
        axios.get(`${HA_API}/states/${entity}`, { headers, timeout: 3000 })
             .then(r => r.data)
             .catch(() => ({ state: 'unavailable' }));

    try {
        const [brewSwitch, pressure, temp, weight, profileName, latestShotId, targetTemp] =
            await Promise.all([
                get('binary_sensor.gaggiuino_brew_switch'),
                get('sensor.gaggiuino_pressure'),
                get('sensor.gaggiuino_temperature'),
                get('sensor.gaggiuino_weight'),
                get('sensor.gaggiuino_profile_name'),
                get('sensor.gaggiuino_latest_shot_id'),
                get('sensor.gaggiuino_target_temperature'),
            ]);

        const isBrewing  = brewSwitch.state === 'on';
        const presVal    = parseFloat(pressure.state)   || 0;
        const tempVal    = parseFloat(temp.state)       || 0;
        const weightVal  = parseFloat(weight.state)     || 0;
        const tTempVal   = parseFloat(targetTemp.state) || 0;
        const profile    = profileName.state !== 'unavailable' ? profileName.state : 'Unknown';
        const shotId     = parseInt(latestShotId.state) || 0;

        // Auto-sync when latest_shot_id increases (new shot saved on machine)
        if (shotId > lastKnownShotId && lastKnownShotId > 0) {
            log(`📥 Neue Shot-ID erkannt: ${shotId} – auto-sync`);
            setTimeout(syncShots, 2000);
        }
        lastKnownShotId = shotId;

        // Brew start
        if (isBrewing && !liveAccum) {
            liveAccum = {
                startTime:   Date.now(),
                profileName: profile,
                shotId:      shotId + 1,
                prevWeight:  weightVal,
                datapoints: {
                    timeInShot:         [],
                    pressure:           [],
                    temperature:        [],
                    shotWeight:         [],
                    weightFlow:         [],
                    pumpFlow:           [],
                    targetTemperature:  []
                }
            };
            log(`☕ Bezug gestartet – Profil: ${profile}`);
        }

        // Brew end
        if (!isBrewing && liveAccum) {
            log('✅ Bezug beendet');
            liveAccum = null;
            setTimeout(syncShots, 3000);
        }

        // Accumulate datapoints during brew
        if (isBrewing && liveAccum) {
            // timeInShot in units of 0.1s (×10 to match Gaggiuino format)
            const elapsed    = Math.round((Date.now() - liveAccum.startTime) / 100);
            const weightFlow = Math.max(0, weightVal - liveAccum.prevWeight); // g since last poll
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
            shotId:      isBrewing && liveAccum ? liveAccum.shotId : shotId,
            isLive:      isBrewing,
            profileName: isBrewing && liveAccum ? liveAccum.profileName : profile,
            datapoints:  isBrewing && liveAccum ? liveAccum.datapoints : null
        });

    } catch (err) {
        broadcastLive({ type: 'error', message: err.message });
    }
}

// ── Live polling: Gaggiuino API (fallback when no SUPERVISOR_TOKEN) ────────

async function pollViaGaggiuinoApi() {
    const opts       = loadOptions();
    const machineUrl = getMachineUrl(opts);
    try {
        const latestRes = await axios.get(`${machineUrl}/latest`, { timeout: 3000 });
        const shotId    = latestRes.data[0].lastShotId;
        const shotRes   = await axios.get(`${machineUrl}/${shotId}`,  { timeout: 3000 });
        const shot      = shotRes.data;

        const dpLen   = shot.datapoints?.timeInShot?.length || 0;
        const now     = Date.now();

        if (!liveAccum || liveAccum.shotId !== shotId) {
            liveAccum = { shotId, lastLen: 0, lastDataAt: now };
        }
        const growing = dpLen > liveAccum.lastLen;
        if (growing) liveAccum.lastDataAt = now;
        liveAccum.lastLen = dpLen;

        const isLive = dpLen > 0 && (now - liveAccum.lastDataAt) < 3000;

        broadcastLive({
            type:        'data',
            shotId,
            isLive,
            profileName: shot.profile?.name || shot.profileName || 'Unknown',
            datapoints:  shot.datapoints
        });
    } catch (err) {
        broadcastLive({ type: 'error', message: err.message });
    }
}

app.use(express.static(path.join(__dirname, 'public')));

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
    log(`🚀 Gaggiuino Local Profiler v1.8.0 gestartet auf Port ${PORT}`);
    const opts = loadOptions();
    log(`🔗 ${getMachineUrl(opts)}  |  Sync alle ${opts.sync_interval || 5} min`);
    log(`🏠 HA-Integration: ${HA_TOKEN ? 'aktiv' : 'nicht verfügbar (kein SUPERVISOR_TOKEN)'}`);
    syncShots().then(scheduleNextSync);
});
