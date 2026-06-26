const { getDb }            = require('../db');
const { MAINTENANCE_DEFAULTS } = require('../constants');

class LibraryRepository {
    getLibrary() {
        const db  = getDb();
        const row = db.prepare("SELECT data FROM library WHERE key = 'main'").get();
        const lib = row ? JSON.parse(row.data) : {};
        return {
            beans:    lib.beans    ?? [],
            grinders: lib.grinders ?? [],
            recipes:  lib.recipes  ?? [],
            milks:    lib.milks    ?? [],
        };
    }

    saveLibrary(lib) {
        getDb().prepare("INSERT OR REPLACE INTO library (key, data) VALUES ('main', ?)").run(JSON.stringify(lib));
    }

    getMaintenance() {
        const db      = getDb();
        const rows    = db.prepare('SELECT key, data FROM maintenance').all();
        const saved   = Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.data)]));
        const result  = JSON.parse(JSON.stringify(MAINTENANCE_DEFAULTS));
        for (const key of Object.keys(result)) {
            if (saved[key]) Object.assign(result[key], saved[key]);
        }
        const { grinders } = this.getLibrary();
        for (const grinder of grinders) {
            const key = `grinder_${grinder.id}`;
            const s   = saved[key] || {};
            result[key] = {
                lastDate:        s.lastDate        ?? null,
                threshold_shots: 'threshold_shots' in s ? s.threshold_shots : 200,
                threshold_days:  'threshold_days'  in s ? s.threshold_days  : null,
                grinderName:     grinder.name,
            };
        }
        return result;
    }

    saveMaintenance(data) {
        const db  = getDb();
        const ins = db.prepare('INSERT OR REPLACE INTO maintenance (key, data) VALUES (?,?)');
        db.transaction(() => {
            for (const [key, val] of Object.entries(data)) ins.run(key, JSON.stringify(val));
        })();
    }

    getMaintenanceLog() {
        const rows = getDb().prepare('SELECT * FROM maintenance_log ORDER BY ts DESC').all();
        return rows.map(r => ({
            id:             r.id,
            ts:             r.ts,
            date:           r.date,
            task:           r.task,
            machine:        r.machine,
            shotCountAtTime: r.shot_count,
            notes:          r.notes,
        }));
    }

    addMaintenanceLogEntry(task, notes, machine, shotCount) {
        const db    = getDb();
        const entry = {
            id:      Date.now(),
            ts:      Math.floor(Date.now() / 1000),
            date:    new Date().toISOString().split('T')[0],
            task,
            machine: machine || '',
            shot_count: shotCount ?? 0,
            notes:   notes || '',
        };
        db.prepare(
            'INSERT INTO maintenance_log (id, ts, date, task, machine, shot_count, notes) VALUES (?,?,?,?,?,?,?)'
        ).run(entry.id, entry.ts, entry.date, entry.task, entry.machine, entry.shot_count, entry.notes);
        db.prepare('DELETE FROM maintenance_log WHERE id NOT IN (SELECT id FROM maintenance_log ORDER BY ts DESC LIMIT 500)').run();
        return { ...entry, shotCountAtTime: entry.shot_count };
    }
}

module.exports = new LibraryRepository();
