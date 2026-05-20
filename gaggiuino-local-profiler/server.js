const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();

// Konfiguration
const PORT = 8099; 
const DATA_DIR = '/data'; 
const DATA_FILE = '/data/shots.json';
const MACHINE_URL = process.env.MACHINE_URL || 'http://gaggia.intern/api/shots';

// Hilfsfunktion für Logs
function log(message, isError = false) {
    const now = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    if (isError) {
        console.error(`[${now}] ${message}`);
    } else {
        console.log(`[${now}] ${message}`);
    }
}

// Initialisierung der Daten-Datei
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

// Statische Dateien
app.use(express.static(path.join(__dirname, 'public')));

// API-Endpunkt für das Frontend (muss shots.json heißen!)
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
        res.status(500).json({ error: "Fehler beim Laden" });
    }
});

// Sync-Logik
async function syncShots() {
    try {
        const latestResponse = await axios.get(`${MACHINE_URL}/latest`);
        const latestMachineId = latestResponse.data[0].lastShotId;

        // Lese aus DIESER Datei
        let localShots = [];
        if (fs.existsSync(DATA_FILE)) {
            const content = fs.readFileSync(DATA_FILE, 'utf8');
            localShots = content ? JSON.parse(content) : [];
        }
        
        const maxLocalId = localShots.length > 0 ? Math.max(...localShots.map(s => s.id)) : 0;

        if (maxLocalId >= latestMachineId) {
            log(`Alles aktuell. Shots in Datei: ${localShots.length}`);
            return;
        }

        for (let i = maxLocalId + 1; i <= latestMachineId; i++) {
            const shotResponse = await axios.get(`${MACHINE_URL}/${i}`);
            localShots.push(shotResponse.data);
        }

        // Schreibe in DIESE Datei
        fs.writeFileSync(DATA_FILE, JSON.stringify(localShots, null, 2), 'utf8');
        log(`Sync beendet. Gespeichert in ${DATA_FILE}. Aktueller Stand: ${localShots.length} Shots.`);
    } catch (err) {
        log(`❌ Sync-Fehler: ${err.message}`, true);
    }
}

// Server-Start
app.listen(PORT, () => {
    log(`🚀 GLP Add-on v1.3.11 gestartet. Pfad: ${DATA_FILE}`);
    syncShots();
    setInterval(syncShots, 5 * 60 * 1000);
});