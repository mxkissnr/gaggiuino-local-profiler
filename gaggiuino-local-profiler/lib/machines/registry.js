// Machine registry (#317): one row per configured espresso machine. The
// default machine (id 1) is auto-seeded from the legacy config.yaml
// `machine_host`/`switch_entity` options on first run, so existing
// single-machine installs upgrade with zero manual steps.
'use strict';
const fs = require('fs');
const { getDb } = require('../db');
const { OPTIONS_FILE } = require('../constants');
const { log } = require('../helpers');

function loadOptions() {
    try {
        if (fs.existsSync(OPTIONS_FILE)) return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
    } catch { /* fall through to {} */ }
    return {};
}

// theme is stored as a JSON string (see lib/db.js's machines table comment
// for the exact contract); parse defensively so a hand-edited/corrupt row
// never 500s the whole registry — falls back to "no theme set".
function parseTheme(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

// #600: closes the stale gaggiuino-live-client.js WS session (if any) for a
// machine's old host after it's removed or re-hosted — otherwise that
// session keeps retrying every RECONNECT_DELAY_MS forever, an unbounded leak
// over a long-running add-on process. Lazy require (not a top-level one):
// gaggiuino-live-client.js has no back-reference to this module today (no
// actual cycle), but keeping registry.js's own top-level require graph
// unchanged for every caller that never touches host/machine-removal
// matches this repo's existing lazy-require precedent for optional
// cross-module hooks (see lib/services/LibraryService.js). Best-effort: a
// failure here must never break the machine CRUD it's hooked onto.
function evictLiveSession(host) {
    if (!host) return;
    try {
        require('../gaggiuino-live-client').disconnectForHost(host);
    } catch (e) {
        log(`Machines: failed to evict stale live session for ${host}: ${e.message}`, true);
    }
}

function row(r) {
    if (!r) return null;
    return {
        id:           r.id,
        name:         r.name,
        type:         r.type,
        host:         r.host,
        switchEntity: r.switch_entity || null,
        theme:        parseTheme(r.theme),
        isDefault:    !!r.is_default,
        enabled:      !!r.enabled,
        createdAt:    r.created_at,
    };
}

// Idempotent: seeds machine #1 from options.json only if the registry is
// still empty. Safe to call on every request (routes/machines.js does).
function ensureDefaultMachine() {
    const db    = getDb();
    const count = db.prepare('SELECT COUNT(*) AS n FROM machines').get().n;
    if (count > 0) return;

    const opts = loadOptions();
    const host = (opts.machine_host || opts.machine_url || 'gaggia.intern').trim();
    db.prepare(
        `INSERT INTO machines (id, name, type, host, switch_entity, is_default, enabled, created_at)
         VALUES (1, ?, 'gaggiuino', ?, ?, 1, 1, ?)`
    ).run('Gaggiuino', host, opts.switch_entity || null, Date.now());
    log(`Machines: seeded default machine #1 "Gaggiuino" (${host})`);
}

function listMachines() {
    return getDb().prepare('SELECT * FROM machines ORDER BY is_default DESC, id ASC').all().map(row);
}

function getMachine(id) {
    if (id == null) return null;
    return row(getDb().prepare('SELECT * FROM machines WHERE id = ?').get(id));
}

function getDefaultMachine() {
    ensureDefaultMachine();
    return row(getDb().prepare('SELECT * FROM machines WHERE is_default = 1 LIMIT 1').get())
        || listMachines()[0]
        || null;
}

function createMachine({ name, type, host, switchEntity, theme, enabled = true }) {
    const db   = getDb();
    const info = db.prepare(
        `INSERT INTO machines (name, type, host, switch_entity, theme, is_default, enabled, created_at)
         VALUES (?,?,?,?,?,0,?,?)`
    ).run(name, type, host, switchEntity || null, theme ? JSON.stringify(theme) : null, enabled ? 1 : 0, Date.now());
    return getMachine(info.lastInsertRowid);
}

function updateMachine(id, fields) {
    const existing = getMachine(id);
    if (!existing) return null;
    const db           = getDb();
    const name         = fields.name ?? existing.name;
    const type         = fields.type ?? existing.type;
    const host         = fields.host ?? existing.host;
    const switchEntity = fields.switchEntity !== undefined ? fields.switchEntity : existing.switchEntity;
    const theme        = fields.theme !== undefined ? fields.theme : existing.theme;
    const enabled      = fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : (existing.enabled ? 1 : 0);
    db.prepare('UPDATE machines SET name=?, type=?, host=?, switch_entity=?, theme=?, enabled=? WHERE id=?')
        .run(name, type, host, switchEntity, theme ? JSON.stringify(theme) : null, enabled, id);
    // Evict the *old* host's session, not the new one — the new host's
    // session is opened lazily on its own next live-data read (same as any
    // other cold cache), same pattern as the delete case below.
    if (fields.host !== undefined && fields.host !== existing.host) {
        evictLiveSession(existing.host);
    }
    return getMachine(id);
}

function deleteMachine(id) {
    const existing = getMachine(id);
    if (!existing) return false;
    if (existing.isDefault) throw new Error('cannot delete the default machine');
    getDb().prepare('DELETE FROM machines WHERE id = ?').run(id);
    evictLiveSession(existing.host);
    return true;
}

module.exports = {
    ensureDefaultMachine, listMachines, getMachine, getDefaultMachine,
    createMachine, updateMachine, deleteMachine,
};
