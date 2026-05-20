const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 8080;

app.use(express.json({ limit: '50mb' }));

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'public');
const SHOTS_FILE = path.join(DATA_DIR, 'shots.json');
const OPTIONS_FILE = '/data/options.json';

function getMachineAddress() {
    try {
        if (fs.existsSync(OPTIONS_FILE)) {
            const options = JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
            return options.machine_address || "gaggia.intern";
        }
    } catch (e) {
        console.error("Fehler beim Lesen der HA-Optionen:", e.message);
    }
    return "gaggia.intern";
}

if (!fs.existsSync(SHOTS_FILE)) {
    fs.writeFileSync(SHOTS_FILE, JSON.stringify([], null, 4));
}

// --- AUTOMATISCHER SYNC VON SD-KARTE (LOGIK AUS PROXY.PY) ---
async function syncShotsFromMachine() {
    const host = getMachineAddress();
    const baseUrl = `http://${host}/api/shots`;
    
    console.log(`Starte Synchronisierung mit der Maschine: ${baseUrl}...`);
    
    try {
        // 1. Neueste Shot-ID von der Maschine holen
        const latestResponse = await fetch(`${baseUrl}/latest`);
        if (!latestResponse.ok) throw new Error("Konnte /latest nicht abfragen");
        const latestData = await latestResponse.json();
        const latestId = latestData[0]?.lastShotId;
        
        if (!latestId) {
            console.log("Keine Shots auf der Maschine gefunden.");
            return;
        }
        
        console.log(`Neueste Shot-ID auf der Maschine: ${latestId}`);
        
        // 2. Lokale Datenbank laden
        let localShots = JSON.parse(fs.readFileSync(SHOTS_FILE, 'utf8'));
        
        // Wir merken uns, welche Timestamps oder IDs wir schon haben, um Duplikate zu vermeiden
        // Da die ID auf der SD-Karte mitgeliefert wird, nutzen wir die als Identifikator im Datapoint
        let existingIds = new Set(localShots.map(s => s.externalId));
        
        let importedCount = 0;

        // 3. Alle IDs von 1 bis latestId durchgehen und fehlende abrufen
        for (let i = 1; i <= latestId; i++) {
            if (existingIds.has(i)) continue; // Haben wir schon? Überspringen!
            
            try {
                const shotResponse = await fetch(`${baseUrl}/${i}`);
                if (shotResponse.status !== 200) {
                    console.log(`Überspringe Shot ${i} (Status ${shotResponse.status})`);
                    continue;
                }
                
                const rawShot = await shotResponse.json();
                
                // Format anpassen für dein Frontend
                const nextId = localShots.length > 0 ? Math.max(...localShots.map(s => s.id)) + 1 : 1;
                const normalizedShot = {
                    id: nextId,
                    externalId: i, // ID von der SD-Karte merken
                    timestamp: rawShot.timestamp || Math.floor(Date.now() / 1000),
                    profileName: rawShot.profileName || rawShot.profile?.name || "Adaptive",
                    duration: rawShot.duration || 0,
                    datapoints: rawShot.datapoints || {}
                };
                
                localShots.push(normalizedShot);
                existingIds.add(i);
                importedCount++;
                console.log(`Shot ${i} erfolgreich von SD-Karte importiert.`);
                
            } catch (shotErr) {
                console.error(`Fehler bei Shot ${i}:`, shotErr.message);
            }
        }
        
        if (importedCount > 0) {
            fs.writeFileSync(SHOTS_FILE, JSON.stringify(localShots, null, 4));
            console.log(`Sync beendet. ${importedCount} neue Shots geladen.`);
        } else {
            console.log("Alles up to date. Keine neuen Shots auf der SD-Karte.");
        }
        
    } catch (error) {
        console.error("Fehler beim Sync von SD-Karte:", error.message);
    }
}

// Beim Start des Add-ons direkt einmal syncen
setTimeout(syncShotsFromMachine, 5000);

// Alle 10 Minuten im Hintergrund nach neuen Shots suchen
setInterval(syncShotsFromMachine, 10 * 60 * 1000);
// ------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.get('/shots.json', (req, res) => {
    res.sendFile(SHOTS_FILE);
});

// Manueller Trigger für den Sync über das Frontend (falls man nicht warten will)
app.post('/api/sync', async (req, res) => {
    await syncShotsFromMachine();
    res.json({ success: true, message: "Sync-Vorgang im Hintergrund gestartet." });
});

app.listen(PORT, () => {
    console.log(`GLP Add-on läuft auf Port ${PORT}.`);
});