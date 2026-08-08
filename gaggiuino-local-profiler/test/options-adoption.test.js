// options.json is a tracked input to the machine registry, not a live config
// source. These tests pin the two requirements that pull in opposite
// directions and that a plain read-time fallback cannot satisfy at once:
//
//   1. #643: clearing switch_entity in Settings must stick across restarts --
//      an unchanged add-on option must never resurrect the old value.
//   2. Reported on v2.29.0: setting switch_entity in the HA add-on config
//      *after* the initial ensureDefaultMachine() seed must still reach the
//      app -- previously the registry row stayed NULL forever and the power
//      button never appeared.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath        = require.resolve('../lib/db');
const realDb        = require(dbPath);
const constantsPath = require.resolve('../lib/constants');
const realConstants = require(constantsPath);
const registryPath  = require.resolve('../lib/machines/registry');
const dataPath      = require.resolve('../lib/data');
const adoptionPath  = require.resolve('../lib/machines/options-adoption');

describe('options.json adoption into the machine registry', () => {
    let memDb, tmpFile;

    // Rewrites options.json and re-requires the modules that cache it, so a
    // call to boot() below models a fresh add-on start with those options.
    function writeOptions(opts) {
        fs.writeFileSync(tmpFile, JSON.stringify(opts));
        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[adoptionPath];
    }

    // One add-on start: seed (no-op once machine #1 exists) then adopt.
    function boot() {
        require('../lib/machines/registry').ensureDefaultMachine();
        require('../lib/machines/options-adoption').adoptOptionChanges();
    }

    function machine() {
        return require('../lib/machines/registry').getDefaultMachine();
    }

    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

        tmpFile = path.join(os.tmpdir(), `glp-test-options-adopt-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        require.cache[constantsPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile };
    });

    afterEach(() => {
        memDb.close();
        require.cache[dbPath].exports = realDb;
        require.cache[constantsPath].exports = realConstants;
        try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[adoptionPath];
    });

    it('adopts a switch_entity set in the add-on options after the initial seed', () => {
        // Install predates the option: machine #1 is seeded with no switch.
        writeOptions({ machine_host: 'gaggiuino.local' });
        boot();
        expect(machine().switchEntity).toBe(null);

        // User now sets it in the HA add-on configuration.
        writeOptions({ machine_host: 'gaggiuino.local', switch_entity: 'switch.sonoff_espresso' });
        boot();
        expect(machine().switchEntity).toBe('switch.sonoff_espresso');
    });

    it('adopts on the very first pass when the registry field is still empty', () => {
        // Upgrade case: the option was already set in options.json before this
        // module existed, so there is no kv baseline and the registry is NULL.
        writeOptions({ machine_host: 'gaggiuino.local', switch_entity: 'switch.legacy' });
        memDb.prepare(
            `INSERT INTO machines (id, name, type, host, switch_entity, is_default, enabled, created_at)
             VALUES (1, 'Gaggiuino', 'gaggiuino', 'gaggiuino.local', NULL, 1, 1, ?)`
        ).run(Date.now());

        boot();
        expect(machine().switchEntity).toBe('switch.legacy');
    });

    it('does not resurrect a switch entity the user cleared in Settings (#643)', () => {
        writeOptions({ machine_host: 'gaggiuino.local', switch_entity: 'switch.sonoff_espresso' });
        boot();
        expect(machine().switchEntity).toBe('switch.sonoff_espresso');

        // User clears the field in Settings -> Machines. The add-on option is
        // untouched, so the next restart must leave the clear alone.
        require('../lib/machines/registry').updateMachine(1, { switchEntity: null });
        boot();
        expect(machine().switchEntity).toBe(null);
    });

    it('lets the app-side value win over an unchanged add-on option', () => {
        writeOptions({ machine_host: 'gaggiuino.local', switch_entity: 'switch.from_options' });
        boot();

        require('../lib/machines/registry').updateMachine(1, { switchEntity: 'switch.from_app' });
        boot();
        expect(machine().switchEntity).toBe('switch.from_app');
    });

    it('adopts a changed add-on option even when the app set its own value', () => {
        writeOptions({ machine_host: 'gaggiuino.local', switch_entity: 'switch.from_options' });
        boot();
        require('../lib/machines/registry').updateMachine(1, { switchEntity: 'switch.from_app' });

        // Explicit edit in Home Assistant -- the most recent deliberate action
        // wins, same as any other config-reconciliation loop.
        writeOptions({ machine_host: 'gaggiuino.local', switch_entity: 'switch.changed_in_ha' });
        boot();
        expect(machine().switchEntity).toBe('switch.changed_in_ha');
    });

    it('adopts a cleared add-on option as an intentional clear', () => {
        writeOptions({ machine_host: 'gaggiuino.local', switch_entity: 'switch.sonoff_espresso' });
        boot();

        writeOptions({ machine_host: 'gaggiuino.local', switch_entity: '' });
        boot();
        expect(machine().switchEntity).toBe(null);
    });

    // The planned deprecation: once switch_entity is dropped from
    // config.yaml's schema, the Supervisor stops writing the key into
    // options.json. That is not a user clearing the field, and treating it
    // as one would wipe the configured switch entity of every install on
    // that single upgrade.
    it('does not clear the switch entity when the option is removed from the schema', () => {
        writeOptions({ machine_host: 'gaggiuino.local', switch_entity: 'switch.sonoff_espresso' });
        boot();
        expect(machine().switchEntity).toBe('switch.sonoff_espresso');

        writeOptions({ machine_host: 'gaggiuino.local' }); // key gone entirely
        boot();
        expect(machine().switchEntity).toBe('switch.sonoff_espresso');
    });

    // Standalone Docker: no options.json at all (lib/data.js's loadOptions()
    // returns {}). Every tracked option reads as absent, so the registry --
    // the only configuration surface such an install has -- must survive
    // untouched across restarts.
    it('leaves the registry alone when options.json is missing entirely', () => {
        writeOptions({ machine_host: 'gaggiuino.local', switch_entity: 'switch.sonoff_espresso' });
        boot();

        fs.unlinkSync(tmpFile);
        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[adoptionPath];
        boot();

        expect(machine().host).toBe('gaggiuino.local');
        expect(machine().switchEntity).toBe('switch.sonoff_espresso');
    });

    it('adopts a changed machine_host', () => {
        writeOptions({ machine_host: 'old-host.local' });
        boot();
        expect(machine().host).toBe('old-host.local');

        writeOptions({ machine_host: 'new-host.local' });
        boot();
        expect(machine().host).toBe('new-host.local');
    });

    it('never clears machine_host, even if the add-on option is emptied', () => {
        writeOptions({ machine_host: 'gaggiuino.local' });
        boot();

        // An empty host would leave the app with no way to reach the machine,
        // so an emptied option means "leave it alone", not "forget the host".
        writeOptions({ machine_host: '' });
        boot();
        expect(machine().host).toBe('gaggiuino.local');
    });

    it('leaves an app-side host edit alone when the add-on option is unchanged', () => {
        writeOptions({ machine_host: 'gaggiuino.local' });
        boot();

        require('../lib/machines/registry').updateMachine(1, { host: 'edited-in-app.local' });
        boot();
        expect(machine().host).toBe('edited-in-app.local');
    });

    // #661: registry.restoreMachines() writes a backed-up machine row
    // straight into the machines table, bypassing adoptOptionChanges()
    // entirely. Without reconciliation, a restore from a backup taken at a
    // different host/switch_entity silently reintroduces the stale value,
    // and it survives every future restart because options.json itself
    // never changed -- adoptOptionChanges()'s diff against its "seen"
    // baseline sees no difference.
    it('re-adopts the current add-on options after a restore reintroduces a stale host/switch_entity', () => {
        writeOptions({ machine_host: 'gaggia.intern', switch_entity: 'switch.current' });
        boot();
        expect(machine().host).toBe('gaggia.intern');
        expect(machine().switchEntity).toBe('switch.current');

        // Restore a backup taken back when the machine lived at a different
        // host/switch entity -- options.json is untouched throughout.
        require('../lib/machines/registry').restoreMachines([{
            id: 1, name: 'Gaggiuino', type: 'gaggiuino',
            host: 'old-host.local', switchEntity: 'switch.stale',
            isDefault: true, enabled: true, createdAt: Date.now(),
        }]);

        expect(machine().host).toBe('gaggia.intern');
        expect(machine().switchEntity).toBe('switch.current');

        // And the reconciliation must have updated the "seen" baseline too,
        // so a subsequent boot() with the same unchanged options doesn't
        // find a stale-vs-current diff and re-log/re-adopt for no reason.
        boot();
        expect(machine().host).toBe('gaggia.intern');
        expect(machine().switchEntity).toBe('switch.current');
    });

    // #662: machine_host/switch_entity were removed from config.yaml's
    // schema. hasUnconfirmedLegacyMachineOptions() drives the one-time
    // in-app banner pointing an upgrading install at Settings -> Machines --
    // true only while a legacy option is present AND the registry still
    // matches it exactly (the user hasn't touched it since).
    describe('hasUnconfirmedLegacyMachineOptions (#662)', () => {
        function pending() {
            return require('../lib/machines/options-adoption').hasUnconfirmedLegacyMachineOptions();
        }

        it('is false when no legacy option is present in options.json at all', () => {
            writeOptions({});
            boot();
            expect(pending()).toBe(false);
        });

        it('is true right after a legacy machine_host is adopted, unconfirmed', () => {
            writeOptions({ machine_host: 'gaggia.intern' });
            boot();
            expect(pending()).toBe(true);
        });

        it('is true right after a legacy switch_entity is adopted, unconfirmed', () => {
            writeOptions({ machine_host: 'gaggia.intern', switch_entity: 'switch.espresso' });
            boot();
            expect(pending()).toBe(true);
        });

        it('goes false once the user edits the host in Settings -> Machines', () => {
            writeOptions({ machine_host: 'gaggia.intern' });
            boot();
            expect(pending()).toBe(true);

            require('../lib/machines/registry').updateMachine(1, { host: 'edited-in-app.local' });
            expect(pending()).toBe(false);
        });

        it('goes false once the user edits the switch entity in Settings -> Machines', () => {
            // Isolated to switch_entity alone (no machine_host in options.json,
            // so it reads UNSET and never keeps pending() true on its own) --
            // otherwise an unconfirmed host would still correctly keep the
            // banner showing per the "any unconfirmed tracked field" semantics
            // .some() implements, which is exercised by the next test.
            writeOptions({ switch_entity: 'switch.espresso' });
            boot();
            expect(pending()).toBe(true);

            require('../lib/machines/registry').updateMachine(1, { switchEntity: 'switch.edited' });
            expect(pending()).toBe(false);
        });

        it('keeps pending while any one of two legacy fields is still unconfirmed', () => {
            writeOptions({ machine_host: 'gaggia.intern', switch_entity: 'switch.espresso' });
            boot();

            // Only the switch entity gets confirmed/edited -- the host is
            // still exactly the frozen legacy value, so the banner should
            // keep showing rather than disappearing after a partial edit.
            require('../lib/machines/registry').updateMachine(1, { switchEntity: 'switch.edited' });
            expect(pending()).toBe(true);

            require('../lib/machines/registry').updateMachine(1, { host: 'edited-in-app.local' });
            expect(pending()).toBe(false);
        });

        it('stays false for a genuinely fresh install that never had legacy options', () => {
            writeOptions({}); // no machine_host/switch_entity ever set
            boot(); // ensureDefaultMachine() seeds a placeholder host
            expect(pending()).toBe(false);
        });
    });

    it('restore reconciliation leaves a restored host alone when the add-on option is empty', () => {
        writeOptions({ machine_host: 'gaggia.intern' });
        boot();

        // Add-on option emptied at some point -- required fields are never
        // cleared, so there's nothing for reconciliation to fall back to;
        // the restored value (however stale) stands.
        writeOptions({ machine_host: '' });
        require('../lib/machines/registry').restoreMachines([{
            id: 1, name: 'Gaggiuino', type: 'gaggiuino',
            host: 'old-host.local', switchEntity: null,
            isDefault: true, enabled: true, createdAt: Date.now(),
        }]);

        expect(machine().host).toBe('old-host.local');
    });
});
