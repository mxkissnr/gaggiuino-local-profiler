const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();

const PORT = 8099;
const DATA_DIR = '/data';
const DATA_FILE = '/data/shots.json';
const ANNOTATIONS_FILE = '/data/annotations.json';
const OPTIONS_FILE = '/data/options.json';

let lastSyncTime = null;
let lastSyncError = null;
let lastManualSync = 0;

function log(message, isError = false) {
    const now = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    if (isError) {
        console.error(`[${now}] ${message}`);
    } else {
        console.log(`[${now}] ${message}`);
    }
}

function loadOptions() {
    try {
        if (fs.existsSync(OPTIONS_FILE)) {
            return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
        }
    } catch (e) {
        log(`Konnte options.json nicht lesen: ${e.message}`, true);
    }
    return {};
}

function getMachineUrl(opts) {
    return opts.machine_url || process.env.MACHINE_URL || 'http://gaggia.intern/api/shots';
}

function getSyncIntervalMs(opts) {
    return (opts.sync_interval || 5) * 60 * 1000;
}

function loadAnnotations() {
    try {
        if (fs.existsSync(ANNOTATIONS_FILE)) {
            return JSON.parse(fs.readFileSync(ANNOTATIONS_FILE, 'utf8'));
        }
    } catch (e) {}
    return {};
}

try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, '[]', 'utf8');
        log(`📂 Neue Datenbank unter ${DATA_FILE} initialisiert.`);
    } else {
        log(`📂 Bestehende Datenbank unter ${DATA_FILE} gefunden.`);
    }
    if (!fs.existsSync(ANNOTATIONS_FILE)) {
        fs.writeFileSync(ANNOTATIONS_FILE, '{}', 'utf8');
    }
} catch (err) {
    log(`❌ Fehler bei der Initialisierung: ${err.message}`, true);
}

app.use(express.json());

// API routes before express.static

app.get('/shots.json', (req, res) => {
    try {
        let shots = [];
        if (fs.existsSync(DATA_FILE)) {
            shots = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
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
    try {
        const content = fs.readFileSync(DATA_FILE, 'utf8');
        shotCount = JSON.parse(content).length;
    } catch (e) {}
    res.json({
        shotCount,
        lastSync: lastSyncTime,
        lastSyncError,
        machineUrl: getMachineUrl(opts),
        syncInterval: opts.sync_interval || 5
    });
});

app.post('/api/sync', (req, res) => {
    const now = Date.now();
    if (now - lastManualSync < 30000) {
        return res.status(429).json({ error: 'Bitte 30 Sekunden zwischen manuellen Syncs warten.' });
    }
    lastManualSync = now;
    res.json({ ok: true });
    syncShots();
});

app.post('/api/shots/:id/annotate', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Ungültige Shot-ID' });

    try {
        const annotations = loadAnnotations();
        annotations[String(id)] = {
            rating:       req.body.rating       || null,
            coffee:       req.body.coffee       || '',
            grinder:      req.body.grinder      || '',
            grindSetting: req.body.grindSetting || '',
            dose:         req.body.dose         || null,
            notes:        req.body.notes        || ''
        };
        fs.writeFileSync(ANNOTATIONS_FILE, JSON.stringify(annotations, null, 2), 'utf8');
        res.json({ ok: true });
    } catch (err) {
        log(`❌ Fehler beim Speichern der Annotation: ${err.message}`, true);
        res.status(500).json({ error: 'Fehler beim Speichern' });
    }
});

app.use(express.static(path.join(__dirname, 'public')));

async function syncShots() {
    const opts = loadOptions();
    const machineUrl = getMachineUrl(opts);
    try {
        const latestResponse = await axios.get(`${machineUrl}/latest`, { timeout: 10000 });
        const latestMachineId = latestResponse.data[0].lastShotId;

        let localShots = [];
        if (fs.existsSync(DATA_FILE)) {
            const content = fs.readFileSync(DATA_FILE, 'utf8');
            localShots = content ? JSON.parse(content) : [];
        }

        const maxLocalId = localShots.length > 0
            ? localShots.reduce((max, s) => s.id > max ? s.id : max, 0)
            : 0;

        if (maxLocalId >= latestMachineId) {
            log(`Alles aktuell. Shots: ${localShots.length}`);
            lastSyncTime = new Date().toISOString();
            lastSyncError = null;
            return;
        }

        for (let i = maxLocalId + 1; i <= latestMachineId; i++) {
            const shotResponse = await axios.get(`${machineUrl}/${i}`, { timeout: 10000 });
            localShots.push(shotResponse.data);
        }

        fs.writeFileSync(DATA_FILE, JSON.stringify(localShots, null, 2), 'utf8');
        lastSyncTime = new Date().toISOString();
        lastSyncError = null;
        log(`✅ Sync abgeschlossen. ${localShots.length} Shots gespeichert.`);
    } catch (err) {
        lastSyncError = err.message;
        lastSyncTime = new Date().toISOString();
        log(`❌ Sync-Fehler: ${err.message}`, true);
    }
}

function scheduleNextSync() {
    const opts = loadOptions();
    const intervalMs = getSyncIntervalMs(opts);
    setTimeout(async () => {
        await syncShots();
        scheduleNextSync();
    }, intervalMs);
}

app.listen(PORT, () => {
    log(`🚀 Gaggiuino Local Profiler v1.5.0 gestartet auf Port ${PORT}`);
    const opts = loadOptions();
    log(`🔗 Maschinenurl: ${getMachineUrl(opts)}, Sync-Intervall: ${opts.sync_interval || 5} min`);
    syncShots().then(scheduleNextSync);
});
