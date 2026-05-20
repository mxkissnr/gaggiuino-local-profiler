const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 8080;

app.use(express.json({ limit: '50mb' }));

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'public');
const SHOTS_FILE = path.join(DATA_DIR, 'shots.json');
const OPTIONS_FILE = '/data/options.json';

// Funktion zum Auslesen der konfigurierten IP/DNS-Adresse
function getMachineAddress() {
    try {
        if (fs.existsSync(OPTIONS_FILE)) {
            const options = JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
            return options.machine_address || "gaggiuino.local";
        }
    } catch (e) {
        console.error("Fehler beim Lesen der HA-Optionen:", e.message);
    }
    return "gaggiuino.local"; // Lokaler Fallback
}

if (!fs.existsSync(SHOTS_FILE)) {
    const initialFile = path.join(__dirname, 'public', 'shots.json');
    if (fs.existsSync(initialFile)) {
        fs.copyFileSync(initialFile, SHOTS_FILE);
    } else {
        fs.writeFileSync(SHOTS_FILE, JSON.stringify([], null, 4));
    }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/shots.json', (req, res) => {
    res.sendFile(SHOTS_FILE);
});

// Neue API-Route, damit das Frontend weiß, wie die Maschine erreichbar ist
app.get('/api/machine-config', (req, res) => {
    res.json({ machineAddress: getMachineAddress() });
});

// Einzelnen Shot speichern
app.post('/api/shots', (req, res) => {
    try {
        const newDatapoints = req.body;
        let shots = [];
        if (fs.existsSync(SHOTS_FILE)) {
            shots = JSON.parse(fs.readFileSync(SHOTS_FILE));
        }

        const nextId = shots.length > 0 ? Math.max(...shots.map(s => s.id)) + 1 : 1;
        const newShot = {
            id: nextId,
            timestamp: Math.floor(Date.now() / 1000),
            profileName: newDatapoints.profileName || "Adaptive",
            duration: newDatapoints.duration || 0,
            datapoints: newDatapoints.datapoints || {}
        };

        shots.push(newShot);
        fs.writeFileSync(SHOTS_FILE, JSON.stringify(shots, null, 4));
        res.status(201).json({ success: true, message: `Shot ${nextId} gespeichert.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Massen-Import von alten Shots
app.post('/api/shots/import', (req, res) => {
    try {
        const oldShots = req.body;
        if (!Array.isArray(oldShots)) {
            return res.status(400).json({ success: false, error: "Payload muss ein JSON-Array sein." });
        }

        let currentShots = [];
        if (fs.existsSync(SHOTS_FILE)) {
            currentShots = JSON.parse(fs.readFileSync(SHOTS_FILE));
        }

        let importedCount = 0;
        let nextId = currentShots.length > 0 ? Math.max(...currentShots.map(s => s.id)) + 1 : 1;

        oldShots.forEach(shot => {
            currentShots.push({
                id: nextId++,
                timestamp: shot.timestamp || Math.floor(Date.now() / 1000),
                profileName: shot.profileName || shot.profile?.name || "Imported Profile",
                duration: shot.duration || 0,
                datapoints: shot.datapoints || {}
            });
            importedCount++;
        });

        fs.writeFileSync(SHOTS_FILE, JSON.stringify(currentShots, null, 4));
        res.status(200).json({ success: true, message: `${importedCount} alte Shots erfolgreich importiert.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`GLP Add-on läuft auf Port ${PORT}. Konfigurierte Maschine: ${getMachineAddress()}`);
});