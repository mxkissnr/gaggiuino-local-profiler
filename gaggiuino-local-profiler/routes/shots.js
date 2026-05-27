const express = require('express');
const fs      = require('fs');
const router  = express.Router();

const { DATA_FILE, ANNOTATIONS_FILE, MAX_SHOT_ID } = require('../lib/constants');
const { loadAnnotations, saveAnnotations, loadTrash, saveTrash,
        loadBlocklist, saveBlocklist } = require('../lib/data');
const { log, writeFileSafe } = require('../lib/helpers');

router.get('/shots.json', (req, res) => {
    try {
        let shots = [];
        if (fs.existsSync(DATA_FILE)) shots = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const annotations  = loadAnnotations();
        const trash        = loadTrash();
        const includeTrash = req.query.trash === '1';
        const filtered = includeTrash
            ? shots.filter(s => trash[String(s.id)])
            : shots.filter(s => !trash[String(s.id)]);
        const merged = filtered.map(s => {
            const ann      = annotations[String(s.id)];
            const trashedAt = trash[String(s.id)] || null;
            return { ...s, ...(ann ? { annotation: ann } : {}), ...(trashedAt ? { trashedAt } : {}) };
        });
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(merged));
    } catch (err) {
        log(`Read error: ${err.message}`, true);
        res.status(500).json({ error: 'Fehler beim Laden' });
    }
});

router.get('/api/shots/last', (req, res) => {
    try {
        if (!fs.existsSync(DATA_FILE)) return res.json(null);
        const shots       = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const trash       = loadTrash();
        const annotations = loadAnnotations();
        const last        = shots.filter(s => !trash[String(s.id)]).slice(-1)[0] || null;
        if (!last) return res.json(null);
        const ann = annotations[String(last.id)];
        res.json(ann ? { ...last, annotation: ann } : last);
    } catch { res.json(null); }
});

router.get('/api/shots/:id', (req, res) => {
    try {
        if (!fs.existsSync(DATA_FILE)) return res.json(null);
        const shots       = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const trash       = loadTrash();
        const annotations = loadAnnotations();
        const id          = req.params.id;
        const shot        = shots.find(s => String(s.id) === id && !trash[id]) || null;
        if (!shot) return res.json(null);
        const ann = annotations[id];
        res.json(ann ? { ...shot, annotation: ann } : shot);
    } catch { res.json(null); }
});

router.post('/api/shots/:id/annotate', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id < 1 || id > MAX_SHOT_ID)
        return res.status(400).json({ error: 'Ungültige Shot-ID' });
    try {
        const annotations = loadAnnotations();
        const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
        const num = (v, min, max) => (typeof v === 'number' && v >= min && v <= max) ? v : null;
        annotations[String(id)] = {
            rating:       Number.isInteger(req.body.rating) && req.body.rating >= 1 && req.body.rating <= 5
                              ? req.body.rating : null,
            coffee:       str(req.body.coffee,       200),
            grinder:      str(req.body.grinder,      200),
            grindSetting: str(req.body.grindSetting, 100),
            dose:         num(req.body.dose,    0.1, 100),
            roastDate:    str(req.body.roastDate, 10),
            tds:          num(req.body.tds,     0.1,  30),
            notes:        str(req.body.notes,       2000),
            drinkType:    str(req.body.drinkType,     50) || null,
        };
        saveAnnotations(annotations);
        res.json({ ok: true });
    } catch (err) {
        log(`Annotation error: ${err.message}`, true);
        res.status(500).json({ error: 'Fehler beim Speichern' });
    }
});

router.post('/api/shots/:id/trash', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id < 1 || id > MAX_SHOT_ID)
        return res.status(400).json({ error: 'Invalid shot ID' });
    try {
        const trash = loadTrash();
        trash[String(id)] = Date.now();
        saveTrash(trash);
        log(`Shot ${id} moved to trash`);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/shots/:id/restore', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id < 1 || id > MAX_SHOT_ID)
        return res.status(400).json({ error: 'Invalid shot ID' });
    try {
        const trash = loadTrash();
        delete trash[String(id)];
        saveTrash(trash);
        log(`Shot ${id} restored from trash`);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/shots/:id/delete', (req, res) => {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id < 1 || id > MAX_SHOT_ID)
        return res.status(400).json({ error: 'Invalid shot ID' });
    try {
        let shots = [];
        if (fs.existsSync(DATA_FILE)) shots = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        const before = shots.length;
        shots = shots.filter(s => s.id !== id);
        if (shots.length === before) return res.status(404).json({ error: 'Shot not found' });
        writeFileSafe(DATA_FILE, shots);
        const annotations = loadAnnotations();
        delete annotations[String(id)];
        saveAnnotations(annotations);
        const blocklist = loadBlocklist();
        if (!blocklist.includes(id)) { blocklist.push(id); saveBlocklist(blocklist); }
        log(`Shot ${id} deleted (added to blocklist)`);
        res.json({ ok: true });
    } catch (err) {
        log(`Delete error: ${err.message}`, true);
        res.status(500).json({ error: 'Failed to delete' });
    }
});

module.exports = router;
