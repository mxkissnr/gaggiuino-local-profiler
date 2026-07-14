const { getDb }         = require('../db');
const { TRASH_TTL_MS }  = require('../constants');
const { toNativeShotId } = require('../machines');

function _hydrate(row) {
    if (!row) return null;
    const rest = JSON.parse(row.data);
    return {
        id:          row.id,
        timestamp:   row.timestamp,
        duration:    row.duration,
        // profile_name (snake_case) is the DB column's own name, kept for
        // lib/card.js's fallback lookup; profileName (camelCase) is what
        // every frontend view actually reads (shot.profile?.name ||
        // shot.profileName) — both point at the same stored value (#344).
        profile_name: row.profile_name,
        profileName:  row.profile_name,
        ...rest,
        // machineId (#325): surfaced to the frontend so it can filter/badge
        // shots per machine. upsert()/upsertMany() always destructure
        // machineId out of the JSON blob before storing, so `rest` never
        // carries a stale copy of this field.
        machineId:   row.machine_id,
        // nativeId (#359): the machine's own shot number (e.g. 3), as
        // opposed to `id`, the globally-unique synthetic id
        // (machineId * 10,000,000 + nativeId) used everywhere internally so
        // two machines' shots can never collide. Display-only — `id` stays
        // the real identifier for API calls, exports, dataset attrs, etc.
        nativeId:    toNativeShotId(row.machine_id, row.id),
        annotation:  row.ann_data ? JSON.parse(row.ann_data) : (rest.annotation ?? {}),
    };
}

const SELECT_BASE = `
    SELECT s.id, s.timestamp, s.duration, s.profile_name, s.data, s.machine_id, a.data AS ann_data
    FROM shots s LEFT JOIN annotations a ON a.shot_id = s.id
`;

class ShotRepository {
    // machineId is optional everywhere below and defaults to undefined (no
    // filtering) to keep every pre-existing call site — which never passed a
    // machine — returning exactly what it did before multi-machine support
    // (#317). Pass machineId explicitly to scope to one machine.
    findAll(machineId) {
        const db   = getDb();
        const rows = machineId
            ? db.prepare(`${SELECT_BASE} WHERE s.machine_id = ? ORDER BY s.timestamp ASC`).all(machineId)
            : db.prepare(`${SELECT_BASE} ORDER BY s.timestamp ASC`).all();
        return rows.map(_hydrate);
    }

    findById(id) {
        const db  = getDb();
        const row = db.prepare(`${SELECT_BASE} WHERE s.id = ?`).get(id);
        return _hydrate(row);
    }

    findAllExcludingTrash(machineId) {
        const db   = getDb();
        const rows = machineId
            ? db.prepare(
                `${SELECT_BASE} WHERE s.machine_id = ? AND s.id NOT IN (SELECT shot_id FROM trash) ORDER BY s.timestamp ASC`
              ).all(machineId)
            : db.prepare(
                `${SELECT_BASE} WHERE s.id NOT IN (SELECT shot_id FROM trash) ORDER BY s.timestamp ASC`
              ).all();
        return rows.map(_hydrate);
    }

    // shot.machineId (optional, defaults to 1 = the default/legacy machine)
    // selects which machine owns this row; shot.id must already be a
    // globally-unique id (the default machine keeps its native shot ids,
    // additional machines use lib/machines.toGlobalShotId to avoid
    // collisions) — see the shots table comment in lib/db.js.
    upsert(shot) {
        const db = getDb();
        const { id, timestamp, duration, profile_name, profileName, annotation, machineId, ...rest } = shot;
        db.prepare(
            'INSERT OR REPLACE INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,?)'
        ).run(id, timestamp ?? null, duration ?? null, profile_name ?? profileName ?? null, JSON.stringify(rest), machineId ?? 1);
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
            'INSERT OR REPLACE INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,?)'
        );
        db.transaction(() => {
            for (const shot of shots) {
                const { id, timestamp, duration, profile_name, profileName, annotation, machineId, ...rest } = shot;
                ins.run(id, timestamp ?? null, duration ?? null, profile_name ?? profileName ?? null, JSON.stringify(rest), machineId ?? 1);
            }
        })();
    }

    getMachineId(shotId) {
        const row = getDb().prepare('SELECT machine_id FROM shots WHERE id = ?').get(shotId);
        return row ? row.machine_id : null;
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

    // machineId optional (#326) — omitted keeps the original global-latest
    // behavior every pre-existing call site relies on; pass it to scope
    // order-fulfillment routing (routes/orders.js's /:id/complete) to the
    // shot actually pulled on the order's target machine.
    getLatestId(machineId) {
        const row = machineId
            ? getDb().prepare(
                'SELECT id FROM shots WHERE machine_id = ? AND id NOT IN (SELECT shot_id FROM trash) ORDER BY timestamp DESC, id DESC LIMIT 1'
              ).get(machineId)
            : getDb().prepare(
                'SELECT id FROM shots WHERE id NOT IN (SELECT shot_id FROM trash) ORDER BY timestamp DESC, id DESC LIMIT 1'
              ).get();
        return row?.id ?? null;
    }
}

module.exports = new ShotRepository();
