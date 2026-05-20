const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 8080;

app.use(express.json({ limit: '10mb' }));

// Nutzt /data in Home Assistant (überlebt Updates), lokal den public-Ordner
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'public');
const SHOTS_FILE = path.join(DATA_DIR, 'shots.json');

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

app.post('/api/shots', (req, res) => {
    try {
        const newDatapoints = req.body;
        
        let shots = [];
        if (fs.existsSync(SHOTS_FILE)) {
            const raw = fs.readFileSync(SHOTS_FILE);
            shots = JSON.parse(raw);
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

app.listen(PORT, () => {
    console.log(`GLP Add-on läuft auf Port ${PORT}. Datenpfad: ${SHOTS_FILE}`);
});
