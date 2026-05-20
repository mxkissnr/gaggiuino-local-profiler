const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();

// Konfiguration aus Umgebungsvariablen oder Fallbacks
const PORT = 8099; // Sicherer, freier Port für das GLP-Dashboard
const DATA_FILE = process.env.DATA_PATH || '/data/shots.json';
const MACHINE_URL = process.env.MACHINE_URL || 'http://gaggia.intern/api/shots';

// Statische Dateien aus dem public-Ordner bereitstellen (index.html, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Explizite Route für die Startseite hinzufügen (wichtig für HA-Ingress)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API-Endpunkt für das Frontend zum Laden der JSON-Daten
app.get('/shots.json', (req, res) => {
    if (fs.existsSync(DATA_FILE)) {
        res.sendFile(DATA_FILE);
    } else {
        // Falls noch keine Datei existiert, leeres Array zurückgeben
        res.json([]);
    }
});

// Hilfsfunktion zur Synchronisierung der Shots von der Maschine
async function syncShots() {
    console.log(`Starte Synchronisierung mit der Maschine: ${MACHINE_URL}...`);
    try {
        // 1. Neueste ID von der Maschine holen
        const latestResponse = await axios.get(`${MACHINE_URL}/latest`);
        if (!latestResponse.data || latestResponse.data.length === 0) {
            console.log('Keine Antwort von der Maschine erhalten.');
            return;
        }
        const latestMachineId = latestResponse.data[0].lastShotId;
        console.log(`Neueste Shot-ID auf der Maschine: ${latestMachineId}`);

        // 2. Lokale Daten laden, falls vorhanden
        let localShots = [];
        if (fs.existsSync(DATA_FILE)) {
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            localShots = JSON.parse(rawData);
        }

        // Höchste ID ermitteln, die wir lokal schon gespeichert haben
        // Korrektur: Wenn die Liste leer ist, fangen wir sauber bei 0 an
        const maxLocalId = localShots.length > 0 
            ? localShots.reduce((max, shot) => shot.id > max ? shot.id : max, 0) 
            : 0;

        console.log(`Lokale maximale Shot-ID: ${maxLocalId} | Maschine maximale Shot-ID: ${latestMachineId}`);

        // Wenn wir wirklich schon alles haben, abbrechen
        if (localShots.length > 0 && maxLocalId >= latestMachineId) {
            console.log('Alles up to date. Keine neuen Shots auf der SD-Karte.');
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
                    console.log(`Shot ${i} erfolgreich von SD-Karte importiert.`);
                }
            } catch (shotErr) {
                console.error(`Fehler beim Laden von Shot ${i}: ${shotErr.message}`);
            }
        }

        // 4. Aktualisierte Liste wieder abspeichern, wenn neue Shots geladen wurden
        if (newShotsCount > 0) {
            fs.writeFileSync(DATA_FILE, JSON.stringify(localShots, null, 2), 'utf8');
            console.log(`Sync beendet. ${newShotsCount} neue Shots geladen.`);
        }

    } catch (err) {
        console.error(`Fehler bei der Synchronisierung: ${err.message}`);
    }
}

// Server starten und aktiven Port-Check durchführen
const server = app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 GLP Add-on erfolgreich gestartet!`);
    console.log(`📂 Datenpfad: ${DATA_FILE}`);
    console.log(`🌍 Dashboard erreichbar unter: http://localhost:${PORT}`);
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
        console.error(`❌ CRITICAL ERROR: Port ${PORT} wird bereits verwendet!`);
        console.error(`   Das Add-on kann nicht auf diesem Port starten.`);
        console.error(`   Bitte prüfe, ob ein anderes Add-on (z.B. OpenThread)`);
        console.error(`   denselben Port belegt und ändere ihn in der config.`);
        console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
        process.exit(1); // Beendet den Prozess hart, damit Home Assistant den Fehler meldet
    } else {
        console.error(`❌ Unerwarteter Serverfehler beim Starten:`, error);
    }
});