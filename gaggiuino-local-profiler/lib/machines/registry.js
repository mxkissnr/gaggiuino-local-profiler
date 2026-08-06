// Machine registry (#317): one row per configured espresso machine. The
// default machine (id 1) is auto-seeded from the legacy config.yaml
// `machine_host`/`switch_entity` options on first run, so existing
// single-machine installs upgrade with zero manual steps.
'use strict';
const { getDb } = require('../db');
const { log } = require('../helpers');
// loadOptions() used to be duplicated here and in lib/data.js; consolidated
// to the lib/data.js copy (it also logs a parse failure) since this module
// needs getMachineUrl()/getMachineBaseUrl() from there anyway for the
// config facade below -- no cycle: lib/data.js's own require graph
// (repositories/services) never reaches back into this module.
const { loadOptions, getMachineUrl, getMachineBaseUrl } = require('../data');

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

// ── Restore (backup/restore) ────────────────────────────────────────────────
// Distinct from createMachine() above: a restore must preserve the *same*
// ids the backup's shots/orders/maintenance rows reference via their own
// machine_id columns (restored from the same file in the same transaction),
// not mint fresh autoincrement ids. Only ever called from routes/backup.js's
// POST /api/restore, never part of the interactive machine CRUD surface.
function restoreMachines(machines) {
    const db = getDb();
    const { machineSchema } = require('../validation/schemas');

    const oldHosts = listMachines().map(m => m.host).filter(Boolean);

    const valid = [];
    for (const m of machines) {
        if (!m || typeof m !== 'object') continue;
        if (!Number.isInteger(m.id) || m.id <= 0) {
            log(`Machines: restore skipped an entry with an invalid id (${m.id})`, true);
            continue;
        }
        const parsed = machineSchema.safeParse(m);
        if (!parsed.success) {
            log(`Machines: restore skipped machine #${m.id} (${parsed.error.issues[0]?.message || 'invalid'})`, true);
            continue;
        }
        const createdAt = Number.isFinite(m.createdAt) ? m.createdAt : Date.now();
        valid.push({ ...parsed.data, id: m.id, createdAt, isDefault: !!m.isDefault });
    }

    db.transaction(() => {
        db.prepare('DELETE FROM machines').run();
        const ins = db.prepare(
            `INSERT INTO machines (id, name, type, host, switch_entity, theme, is_default, enabled, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`
        );
        for (const m of valid) {
            ins.run(m.id, m.name, m.type, m.host, m.switchEntity || null,
                m.theme ? JSON.stringify(m.theme) : null, m.isDefault ? 1 : 0, m.enabled ? 1 : 0, m.createdAt);
        }

        // Enforce exactly one is_default row (lowest id wins on a tie/absence).
        const rows = db.prepare('SELECT id, is_default FROM machines ORDER BY id ASC').all();
        const defaults = rows.filter(r => r.is_default);
        if (defaults.length !== 1 && rows.length) {
            const winnerId = (defaults[0] || rows[0]).id;
            db.prepare('UPDATE machines SET is_default = (id = ?)').run(winnerId);
            log(`Machines: restore corrected is_default — exactly one machine (#${winnerId}) is now default`);
        }
    })();

    for (const host of oldHosts) evictLiveSession(host);

    // #661: a restored machine row can carry a stale host/switchEntity from
    // whatever this instance's add-on options said at backup time --
    // reconcile against the *current* options.json the same way a live
    // option edit would, so the registry doesn't silently drift from what's
    // actually configured. Lazy require: options-adoption.js requires this
    // module at its own top level, so a top-level require here would form a
    // cycle (see evictLiveSession() above for the same precedent).
    try {
        require('./options-adoption').reconcileAfterRestore();
    } catch (e) {
        log(`Machines: post-restore options reconciliation failed: ${e.message}`, true);
    }

    log(`Machines: restored ${valid.length}/${machines.length} machine(s)`);
    return valid.length;
}

// ── Config facade (#638/#641/#643/#648) ─────────────────────────────────────
//
// Before this, every consumer that needed a machine's host or switch entity
// re-derived it from a raw `opts` (options.json) object -- getMachineUrl(opts)/
// getMachineBaseUrl(opts) look correct at every call site even when they're
// the wrong thing to call, because they never fail loudly, they just quietly
// read the stale value. #643 alone shipped the same three-line
// resolveSwitchEntity(opts) copied into five files. hostFor/switchEntityFor/
// baseUrlFor/apiUrlFor below are the one place that logic lives now: a
// machineId of null means "the default machine", matching every existing
// call site (all of which were hard single-machine before this facade).
//
// Calls route through `module.exports.getMachine`/`getDefaultMachine` (not
// the bare local function) so `vi.spyOn(registry, 'getDefaultMachine')` in
// tests still intercepts these internal lookups -- see
// test/default-machine-host-live-sync.test.js and siblings, which predate
// this facade and spy on the registry module from the outside.
function _machineFor(machineId) {
    return machineId != null ? module.exports.getMachine(machineId) : module.exports.getDefaultMachine();
}

// #679: was copy-pasted verbatim into routes/system.js and
// routes/machine-control.js (an explicit machineId from a query/body param
// if it names a known machine, otherwise the registry's default machine --
// keeps old cached frontends that don't send machineId at all working
// exactly as before, #340) -- exact precursor shape to #638/#643, now
// shared from the one facade the rest of this file already establishes for
// machine-config resolution.
function resolveMachine(rawId) {
    module.exports.ensureDefaultMachine();
    const machineId = rawId != null && rawId !== '' ? parseInt(rawId, 10) : NaN;
    if (!Number.isNaN(machineId)) {
        const machine = module.exports.getMachine(machineId);
        if (machine) return machine;
    }
    return module.exports.getDefaultMachine();
}

// Registry's switchEntity wins even when it's null/empty -- that's a
// deliberate "not configured" (#643), not a hole to fall through to
// options.json. Falling back there only when there's no default-machine row
// at all is what makes clearing the field in Settings actually stick.
function switchEntityFor(machineId = null) {
    const machine = _machineFor(machineId);
    return machine ? machine.switchEntity : (loadOptions().switch_entity || null);
}

// Registry host first; options.json's machine_host only when the registry
// has no usable host for this machine yet (defensive -- ensureDefaultMachine()
// normally seeds one before anything else runs).
function _effectiveOpts(machineId) {
    const machine = _machineFor(machineId);
    const opts    = loadOptions();
    return machine && machine.host ? { ...opts, machine_host: machine.host } : opts;
}

function apiUrlFor(machineId = null) {
    return getMachineUrl(_effectiveOpts(machineId));
}

function baseUrlFor(machineId = null) {
    return getMachineBaseUrl(_effectiveOpts(machineId));
}

function hostFor(machineId = null) {
    try { return new URL(module.exports.apiUrlFor(machineId)).hostname; } catch { return 'gaggiuino'; }
}

module.exports = {
    ensureDefaultMachine, listMachines, getMachine, getDefaultMachine,
    createMachine, updateMachine, deleteMachine, restoreMachines,
    hostFor, switchEntityFor, baseUrlFor, apiUrlFor, resolveMachine,
};
