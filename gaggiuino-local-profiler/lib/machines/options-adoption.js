// options.json as a *tracked input* to the machine registry.
//
// The registry owns machine config (#317) -- but the same two values are
// also editable in the Home Assistant add-on configuration, and those two
// surfaces never talked to each other in either direction:
//
//   - ensureDefaultMachine() seeds from options.json only while the machines
//     table is still empty, so an option set *after* the first run never
//     reached the registry.
//   - #643 then made every consumer read the registry, deliberately treating
//     an empty registry switchEntity as "not configured" so that clearing the
//     field in Settings actually sticks.
//
// Both decisions are individually right and together they stranded anyone
// who configured switch_entity in the add-on options after the initial seed:
// registry NULL, consumers read NULL, and the power button never appeared
// until the entity was re-entered under Settings -> Machines (reported by a
// user on v2.29.0).
//
// A read-time fallback to options.json cannot fix this without re-breaking
// #643: it would resurrect the old value on every read and make the field
// unclearable. Comparing against the *last seen* options.json value resolves
// both — a changed option is adopted into the registry, an unchanged one is
// ignored, so the app's own edit (including an intentional clear) always
// wins. Same shape as any config-reconciliation loop: the external input is
// authoritative only at the moment it changes.
'use strict';
const { getDb } = require('../db');
const { loadOptions } = require('../data');
const { log } = require('../helpers');
const registry = require('./registry');

// One kv row per tracked option, holding the options.json value as of the
// last adoption pass. Namespaced so it can't collide with the feature-level
// kv keys (menu, orders_settings, ...) that share this table.
const KV_PREFIX = 'options_seen:';

// Three distinct states, and conflating the last two would lose data:
//
//   "switch.x"  -> configured
//   ""          -> present in the schema, deliberately emptied by the user
//   undefined   -> the key is not in options.json at all
//
// The Supervisor writes every schema key into options.json, so `undefined`
// does not mean "the user left it blank" -- it means the option was dropped
// from config.yaml's schema (the planned deprecation of `switch_entity`) or
// this is a standalone Docker install with no options.json. Adopting that as
// a change would push null into the registry and wipe the switch entity of
// every install on the upgrade that removes the option -- exactly the
// silent loss this module was written to end. UNSET is therefore carried
// through as its own value and skipped by adoptOptionChanges().
const UNSET = Symbol('option-absent');

function normalise(value) {
    if (value === undefined || value === null) return UNSET;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

function readSeen(key) {
    const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(KV_PREFIX + key);
    if (!row) return undefined; // no baseline recorded yet -- distinct from a recorded null
    try { return JSON.parse(row.value); } catch { return undefined; }
}

function writeSeen(key, value) {
    getDb().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
        .run(KV_PREFIX + key, JSON.stringify(value));
}

// optionKey: the options.json/config.yaml field; machineField: the registry
// row property it maps to. Kept as data rather than two hand-written blocks
// so a third tracked option can't drift from the other two -- the copy-paste
// drift that produced #643's five identical resolveSwitchEntity() bodies is
// exactly what this module exists to stop repeating.
const TRACKED = [
    { optionKey: 'machine_host',  machineField: 'host',         required: true  },
    { optionKey: 'switch_entity', machineField: 'switchEntity', required: false },
];

// Runs once at startup, after ensureDefaultMachine(). Best-effort: a failure
// here must never stop the add-on from booting, so the caller's try/catch is
// load-bearing and every branch below is side-effect-free until it succeeds.
function adoptOptionChanges() {
    const opts    = loadOptions();
    const machine = registry.getDefaultMachine();
    if (!machine) return;

    for (const { optionKey, machineField, required } of TRACKED) {
        const current = normalise(opts[optionKey]);
        const seen    = readSeen(optionKey);

        // The option is not in options.json at all: nothing to adopt from,
        // and nothing to record either -- the stored baseline is left as it
        // is so that an option which later reappears is still compared
        // against the last value actually seen. Deliberately ahead of every
        // branch below: an absent option must never reach updateMachine().
        if (current === UNSET) continue;

        // machine_host must never be cleared to null -- the app would lose
        // its only way to reach the machine. An empty add-on option means
        // "leave it alone", not "forget the host".
        if (required && current === null) {
            if (seen === undefined) writeSeen(optionKey, current);
            continue;
        }

        let adopt;
        if (seen === undefined) {
            // First pass on an existing install: no baseline exists, so a
            // difference here says nothing about *when* it appeared. Adopt
            // only into an empty registry field -- that is precisely the
            // stranded state described at the top of this file, and it can't
            // be a deliberate clear because #643 shipped after the seed.
            adopt = current !== null && !machine[machineField];
        } else {
            // Steady state: the add-on option changed since the last pass,
            // so the user just edited it in Home Assistant. It wins.
            adopt = current !== seen;
        }

        if (adopt) {
            registry.updateMachine(machine.id, { [machineField]: current });
            log(`Machines: adopted ${optionKey} from add-on options into machine #${machine.id} `
                + `("${machine.name}"): ${machineField} = ${current === null ? '(cleared)' : current}`);
        }
        writeSeen(optionKey, current);
    }
}

// Called right after registry.restoreMachines() restores the default
// machine row (#661). A restored backup's host/switchEntity reflects
// whatever this instance's add-on options said at *backup* time, and
// restoreMachines() writes it straight into the machines table, bypassing
// the tracked-input contract above entirely. Left alone, that stale value
// survives every future startup: adoptOptionChanges() only re-adopts when
// options.json's *current* value differs from the last-seen one, and a
// restore doesn't touch options.json, so the seen baseline still matches —
// no diff, no re-adoption, and the registry is silently stuck on data from
// a point in time (or, restoring across installs, a machine) that may no
// longer be this instance's own.
//
// Unlike adoptOptionChanges()'s diff-based adoption, this instance's add-on
// options win here unconditionally: they describe this instance's actual
// machine right now, and a restore is itself the kind of registry-replacing
// event that a live option edit would also win against.
function reconcileAfterRestore() {
    const opts    = loadOptions();
    const machine = registry.getDefaultMachine();
    if (!machine) return;

    for (const { optionKey, machineField, required } of TRACKED) {
        const current = normalise(opts[optionKey]);
        if (current === UNSET) continue;
        if (required && current === null) { writeSeen(optionKey, current); continue; }

        if (machine[machineField] !== current) {
            registry.updateMachine(machine.id, { [machineField]: current });
            log(`Machines: restore left ${optionKey} out of sync with add-on options, re-adopted into `
                + `machine #${machine.id} ("${machine.name}"): ${machineField} = ${current === null ? '(cleared)' : current}`);
        }
        writeSeen(optionKey, current);
    }
}

// #662: whether the default machine still needs a heads-up about the
// deprecated add-on options -- true only while a legacy option is present
// in options.json AND the registry's current value for that field still
// matches it exactly (i.e. the user hasn't yet touched this field in
// Settings -> Machines since the deprecation). Once they edit even one
// tracked field there, this goes false for good -- the frozen options.json
// value can never catch back up to a value that has since diverged.
function hasUnconfirmedLegacyMachineOptions() {
    const opts    = loadOptions();
    const machine = registry.getDefaultMachine();
    if (!machine) return false;

    return TRACKED.some(({ optionKey, machineField }) => {
        const current = normalise(opts[optionKey]);
        if (current === UNSET || current === null) return false;
        return machine[machineField] === current;
    });
}

module.exports = { adoptOptionChanges, reconcileAfterRestore, hasUnconfirmedLegacyMachineOptions };
