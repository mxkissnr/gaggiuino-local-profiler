const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();

// Konfiguration aus Umgebungsvariablen oder Fallbacks
const PORT = 8099; 
const DATA_FILE = process.env.DATA_PATH || '/data/shots.json';
const MACHINE_URL = process.env.MACHINE_URL || 'http://gaggia.intern/api/shots';

// Hilfsfunktion für Logs mit deutscher Uhrzeit
function log(message, isError = false) {
    const now = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    if (isError) {
        console.error(`[${now}] ${message}`);
    } else {
        console.log(`[${now}] ${message}`);
    }
}

// Statische Dateien aus dem public-Ordner bereitstellen
app.use(express.static(path.join(__dirname, 'public')));

// Explizite Route für die Startseite (wichtig für HA-Ingress)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API-Endpunkt für das Frontend zum Laden der JSON-Daten (MIT LOGGING!)
app.get('/shots.json', (req, res) => {
    log(`» Frontend fragt shots.json an...`);
    if (fs.existsSync(DATA_FILE)) {
        try {
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            const parsed = JSON.parse(rawData);
            log(`« shots.json erfolgreich gesendet. Anzahl gelieferter Shots: ${parsed.length}`);
            res.json(parsed);
        } catch (err) {
            log(`❌ Fehler beim Lesen/Parsen der shots.json: ${err.message}`, true);
            res.status(500).json({ error: "Fehler beim Lesen der lokalen Daten" });
        }
    } else {
        log(`⚠ shots.json existiert nicht auf dem Pfad. Sende leeres Array [].`);
        res.json([]);
    }
});

// Hilfsfunktion zur Synchronisierung der Shots von der Maschine
async function syncShots() {
    log(`Starte Synchronisierung mit der Maschine: ${MACHINE_URL}...`);
    try {
        // 1. Neueste ID von der Maschine holen
        const latestResponse = await axios.get(`${MACHINE_URL}/latest`);
        if (!latestResponse.data || latestResponse.data.length === 0) {
            log('Keine Antwort von der Maschine erhalten.');
            return;
        }
        const latestMachineId = latestResponse.data[0].lastShotId;
        log(`Neueste Shot-ID auf der Maschine: ${latestMachineId}`);

        // 2. Lokale Daten laden, falls vorhanden
        let localShots = [];
        if (fs.existsSync(DATA_FILE)) {
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            localShots = JSON.parse(rawData);
        }

        // Höchste ID ermitteln, die wir lokal schon gespeichert haben
        const maxLocalId = localShots.length > 0 
            ? localShots.reduce((max, shot) => shot.id > max ? shot.id : max, 0) 
            : 0;

        log(`Lokale maximale Shot-ID: ${maxLocalId} | Maschine maximale Shot-ID: ${latestMachineId}`);

        // Wenn wir wirklich schon alles haben, abbrechen
        if (localShots.length > 0 && maxLocalId >= latestMachineId) {
            log('Alles up to date. Keine neuen Shots auf der SD-Karte.');
            return;
        }

        // 3. Fehlende Shots einzeln von der Maschine abrufen
        let newShotsCount = 0;
        const startId = maxLocalId === 0 ? 1 : maxLocalId + 1;

        for (let i = startId; i <= latestMachineId; i++) {
            try {
                const shotResponse = await axios.get(`${MACHINE_URL}/${i}`);
                if (shotResponse.status === 200 && shotResponse.data) {
                    localShots.push(shotResponse.data);
                    newShotsCount++;
                    log(`Shot ${i} erfolgreich von SD-Karte importiert.`);
                }
            } catch (shotErr) {
                log(`Fehler beim Laden von Shot ${i}: ${shotErr.message}`, true);
            }
        }

        // 4. Aktualisierte Liste wieder abspeichern, wenn neue Shots geladen wurden
        if (newShotsCount > 0) {
            fs.writeFileSync(DATA_FILE, JSON.stringify(localShots, null, 2), 'utf8');
            log(`Sync beendet. ${newShotsCount} neue Shots geladen und in ${DATA_FILE} gespeichert.`);
        }

    } catch (err) {
        log(`Fehler bei der Synchronisierung: ${err.message}`, true);
    }
}

// Server starten und aktiven Port-Check durchführen
const server = app.listen(PORT, () => {
    console.log(`==================================================`);
    log(`🚀 GLP Add-on erfolgreich gestartet!`);
    log(`📂 Datenpfad: ${DATA_FILE}`);
    log(`🌍 Dashboard erreichbar unter: http://localhost:${PORT}`);
    console.log(`==================================================`);

    // Nach erfolgreichem Start den ersten Sync-Vorgang anstoßen
    syncShots();
    
    // Alle 5 Minuten automatisch im Hintergrund synchronisieren
    setInterval(syncShots, 5 * 60 * 1000);
});

// Fehlerbehandlung für den Server-Start (fängt besetzte Ports ab)
server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
        log(`❌ CRITICAL ERROR: Port ${PORT} wird bereits verwendet!`, true);
        console.error(`   Das Add-on kann nicht auf diesem Port starten.`);
        console.error(`   Bitte prüfe, ob ein anderes Add-on (z.B. OpenThread)`);
        console.error(`   denselben Port belegt und ändere ihn in der config.`);
        console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
        process.exit(1);
    } else {
        log(`❌ Unerwarteter Serverfehler beim Starten: ${error.message}`, true);
    }
});