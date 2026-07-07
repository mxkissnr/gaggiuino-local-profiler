const { getDb }         = require('../db');
const { TRASH_TTL_MS }  = require('../constants');

function _hydrate(row) {
    if (!row) return null;
    const rest = JSON.parse(row.data);
    return {
        id:          row.id,
        timestamp:   row.timestamp,
        duration:    row.duration,
        profile_name: row.profile_name,
        ...rest,
        annotation:  row.ann_data ? JSON.parse(row.ann_data) : (rest.annotation ?? {}),
    };
}

const SELECT_BASE = `
    SELECT s.id, s.timestamp, s.duration, s.profile_name, s.data, a.data AS ann_data
    FROM shots s LEFT JOIN annotations a ON a.shot_id = s.id
`;

class ShotRepository {
    findAll() {
        const db   = getDb();
        const rows = db.prepare(`${SELECT_BASE} ORDER BY s.timestamp ASC`).all();
        return rows.map(_hydrate);
    }

    findById(id) {
        const db  = getDb();
        const row = db.prepare(`${SELECT_BASE} WHERE s.id = ?`).get(id);
        return _hydrate(row);
    }

    findAllExcludingTrash() {
        const db   = getDb();
        const rows = db.prepare(
            `${SELECT_BASE} WHERE s.id NOT IN (SELECT shot_id FROM trash) ORDER BY s.timestamp ASC`
        ).all();
        return rows.map(_hydrate);
    }

    upsert(shot) {
        const db = getDb();
        const { id, timestamp, duration, profile_name, profileName, annotation, ...rest } = shot;
        db.prepare(
            'INSERT OR REPLACE INTO shots (id, timestamp, duration, profile_name, data) VALUES (?,?,?,?,?)'
        ).run(id, timestamp ?? null, duration ?? null, profile_name ?? profileName ?? null, JSON.stringify(rest));
        if (annotation !== undefined) {
            db.prepare('INSERT OR REPLACE INTO annotations (shot_id, data) VALUES (?,?)').run(id, JSON.stringify(annotation));
        }
        return this.findById(id);
    }

    // Merges a single field into the shot's JSON blob without touching the
    // rest of the payload — unlike upsert(), which replaces the whole blob
    // and would be unsafe for a partial update like "set the photo extension".
    setImage(shotId, ext) {
        const db  = getDb();
        const row = db.prepare('SELECT data FROM shots WHERE id = ?').get(shotId);
        if (!row) return null;
        const data = JSON.parse(row.data);
        data.image = ext;
        db.prepare('UPDATE shots SET data = ? WHERE id = ?').run(JSON.stringify(data), shotId);
        return this.findById(shotId);
    }

    clearImage(shotId) {
        const db  = getDb();
        const row = db.prepare('SELECT data FROM shots WHERE id = ?').get(shotId);
        if (!row) return null;
        const data = JSON.parse(row.data);
        delete data.image;
        db.prepare('UPDATE shots SET data = ? WHERE id = ?').run(JSON.stringify(data), shotId);
        return this.findById(shotId);
    }

    upsertMany(shots) {
        const db  = getDb();
        const ins = db.prepare(
            'INSERT OR REPLACE INTO shots (id, timestamp, duration, profile_name, data) VALUES (?,?,?,?,?)'
        );
        db.transaction(() => {
            for (const shot of shots) {
                const { id, timestamp, duration, profile_name, profileName, annotation, ...rest } = shot;
                ins.run(id, timestamp ?? null, duration ?? null, profile_name ?? profileName ?? null, JSON.stringify(rest));
            }
        })();
    }

    deleteById(id) {
        const db = getDb();
        db.transaction(() => {
            db.prepare('DELETE FROM annotations WHERE shot_id = ?').run(id);
            db.prepare('DELETE FROM trash WHERE shot_id = ?').run(id);
            db.prepare('DELETE FROM shots WHERE id = ?').run(id);
        })();
    }

    getAnnotation(shotId) {
        const db  = getDb();
        const row = db.prepare('SELECT data FROM annotations WHERE shot_id = ?').get(shotId);
        return row ? JSON.parse(row.data) : {};
    }

    saveAnnotation(shotId, annotation) {
        getDb().prepare('INSERT OR REPLACE INTO annotations (shot_id, data) VALUES (?,?)').run(shotId, JSON.stringify(annotation));
    }

    getTrash() {
        const db   = getDb();
        const rows = db.prepare('SELECT shot_id, deleted_at FROM trash').all();
        return Object.fromEntries(rows.map(r => [String(r.shot_id), r.deleted_at]));
    }

    moveToTrash(shotId) {
        getDb().prepare('INSERT OR REPLACE INTO trash (shot_id, deleted_at) VALUES (?,?)').run(shotId, Date.now());
    }

    restoreFromTrash(shotId) {
        getDb().prepare('DELETE FROM trash WHERE shot_id = ?').run(shotId);
    }

    purgeExpiredTrash() {
        const db      = getDb();
        const cutoff  = Date.now() - TRASH_TTL_MS;
        const expired = db.prepare('SELECT shot_id FROM trash WHERE deleted_at < ?').all(cutoff);
        if (!expired.length) return [];
        const ids = expired.map(r => r.shot_id);
        db.transaction(() => {
            for (const id of ids) {
                db.prepare('DELETE FROM annotations WHERE shot_id = ?').run(id);
                db.prepare('DELETE FROM trash WHERE shot_id = ?').run(id);
                db.prepare('DELETE FROM shots WHERE id = ?').run(id);
            }
        })();
        return ids;
    }

    getBlocklist() {
        return getDb().prepare('SELECT value FROM blocklist').all().map(r => r.value);
    }

    saveBlocklist(list) {
        const db = getDb();
        db.transaction(() => {
            db.prepare('DELETE FROM blocklist').run();
            const ins = db.prepare('INSERT INTO blocklist (value) VALUES (?)');
            for (const v of list) ins.run(String(v));
        })();
    }

    getMaxId() {
        const row = getDb().prepare('SELECT MAX(id) AS max FROM shots').get();
        return row?.max ?? 0;
    }

    count() {
        return getDb().prepare('SELECT COUNT(*) AS n FROM shots').get().n;
    }

    // Lightweight (coffee, dose, timestamp) rows for bean-consumption math —
    // avoids hydrating full shot payloads just to sum annotated doses.
    getAnnotatedDoses() {
        return getDb().prepare(`
            SELECT json_extract(a.data, '$.coffee') AS coffee,
                   json_extract(a.data, '$.dose')   AS dose,
                   s.timestamp                      AS timestamp
            FROM annotations a JOIN shots s ON s.id = a.shot_id
            WHERE json_extract(a.data, '$.coffee') IS NOT NULL
              AND s.id NOT IN (SELECT shot_id FROM trash)
        `).all();
    }

    getLatestId() {
        const row = getDb().prepare(
            'SELECT id FROM shots WHERE id NOT IN (SELECT shot_id FROM trash) ORDER BY timestamp DESC, id DESC LIMIT 1'
        ).get();
        return row?.id ?? null;
    }
}

module.exports = new ShotRepository();
