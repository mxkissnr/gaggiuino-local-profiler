const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();

const PORT = 8099;
const DATA_DIR = '/data';
const DATA_FILE = '/data/shots.json';
const OPTIONS_FILE = '/data/options.json';

let lastSyncTime = null;
let lastSyncError = null;

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
} catch (err) {
    log(`❌ Fehler bei der Initialisierung: ${err.message}`, true);
}

// API routes (before express.static so they take priority)

app.get('/shots.json', (req, res) => {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            res.setHeader('Content-Type', 'application/json');
            res.send(rawData);
        } else {
            res.json([]);
        }
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
    res.json({ ok: true, message: 'Sync gestartet' });
    syncShots();
});

app.use(express.static(path.join(__dirname, 'public')));

async function syncShots() {
    const opts = loadOptions();
    const machineUrl = getMachineUrl(opts);
    try {
        const latestResponse = await axios.get(`${machineUrl}/latest`);
        const latestMachineId = latestResponse.data[0].lastShotId;

        let localShots = [];
        if (fs.existsSync(DATA_FILE)) {
            const content = fs.readFileSync(DATA_FILE, 'utf8');
            localShots = content ? JSON.parse(content) : [];
        }

        const maxLocalId = localShots.length > 0 ? Math.max(...localShots.map(s => s.id)) : 0;

        if (maxLocalId >= latestMachineId) {
            log(`Alles aktuell. Shots: ${localShots.length}`);
            lastSyncTime = new Date().toISOString();
            lastSyncError = null;
            return;
        }

        for (let i = maxLocalId + 1; i <= latestMachineId; i++) {
            const shotResponse = await axios.get(`${machineUrl}/${i}`);
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
    log(`🚀 Gaggiuino Local Profiler v1.4.0 gestartet auf Port ${PORT}`);
    const opts = loadOptions();
    log(`🔗 Maschinenurl: ${getMachineUrl(opts)}, Sync-Intervall: ${opts.sync_interval || 5} min`);
    syncShots().then(scheduleNextSync);
});
