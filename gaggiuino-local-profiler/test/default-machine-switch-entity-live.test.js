// #643: the default machine's switch_entity must always be read live from
// the registry, same as #638 established for machine_host. Before this fix,
// lib/poll.js's checkAndApplyMachinePower(), lib/preheat.js's
// buildPreheatResponse() (and the internal _checkReadyByPreheat() it shares
// resolveSwitchEntity() with), lib/sync.js's syncShots(),
// routes/orders.js's _getPreheatInfo(), and routes/system.js's
// /api/status, /api/switch, /api/switch/toggle, /api/preheat/ready-by all
// read switch_entity straight off options.json -- so editing the default
// machine's switch entity via the Settings UI (registry.updateMachine())
// never reached any of them, which kept gating/toggling the original
// (possibly empty) entity forever.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath         = require.resolve('../lib/db');
const realDb         = require(dbPath);
const constantsPath  = require.resolve('../lib/constants');
const realConstants  = require(constantsPath);
const registryPath   = require.resolve('../lib/machines/registry');
const dataPath       = require.resolve('../lib/data');
const pollPath       = require.resolve('../lib/poll');
const syncPath       = require.resolve('../lib/sync');
const preheatPath    = require.resolve('../lib/preheat');

describe('#643 default-machine switch_entity stays live (registry, not stale options.json)', () => {
    let memDb, tmpFile;

    beforeEach(() => {
        memDb = new Database(':memory:');
        realDb.initSchema(memDb);
        require.cache[dbPath].exports = { getDb: () => memDb, initSchema: realDb.initSchema };

        tmpFile = path.join(os.tmpdir(), `glp-test-options-643-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify({ machine_host: 'gaggiuino.local', switch_entity: 'switch.options_stale' }));
        require.cache[constantsPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile };

        delete require.cache[registryPath];
        delete require.cache[dataPath];
        delete require.cache[pollPath];
        delete require.cache[syncPath];
        delete require.cache[preheatPath];

        const registry = require('../lib/machines/registry');
        registry.ensureDefaultMachine(); // seeds machine #1's switch_entity from options.json ('switch.options_stale')
    });

    afterEach(() => {
        memDb.close();
        require.cache[dbPath].exports = realDb;
        require.cache[constantsPath].exports = realConstants;
        fs.rmSync(tmpFile, { force: true });
    });

    it('lib/preheat.js buildPreheatResponse() gates on the registry\'s current switch_entity, not the stale options.json one', () => {
        // machineOff (!runtime.machineOn && !!resolveSwitchEntity(opts)) forces
        // an early return with elapsed:0 whenever a switch_entity resolves as
        // configured. options.json still has the stale 'switch.options_stale'
        // seeded in beforeEach -- if the fix incorrectly fell back to it, this
        // would still gate off (elapsed:0) even after the registry's entity is
        // explicitly cleared below.
        const registry = require('../lib/machines/registry');
        registry.updateMachine(1, { switchEntity: '' }); // explicitly "not configured"

        const { buildPreheatResponse } = require('../lib/preheat');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = new MachineRuntimeState();
        runtime.machineOn = false;
        runtime.switchOnAt = Date.now() - 5000; // mid-preheat, if ever reached

        const resp = buildPreheatResponse(runtime);
        // Registry's cleared switchEntity must win -> machineOff === false ->
        // falls through to the elapsed-time branch (elapsed > 0), NOT the
        // early machineOff/no-switchOnAt return (which always has elapsed:0).
        expect(resp.elapsed).toBeGreaterThan(0);
    });

    it('lib/preheat.js buildPreheatResponse() still gates off when the registry\'s switch_entity is set', () => {
        const registry = require('../lib/machines/registry');
        registry.updateMachine(1, { switchEntity: 'switch.updated' });

        const { buildPreheatResponse } = require('../lib/preheat');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = new MachineRuntimeState();
        runtime.machineOn = false;
        runtime.switchOnAt = Date.now() - 5000;

        const resp = buildPreheatResponse(runtime);
        expect(resp.elapsed).toBe(0); // machineOff gate trips, early return
    });

    it('lib/poll.js checkAndApplyMachinePower() resolves the registry\'s current switch_entity, not the stale options.json one', async () => {
        const registry = require('../lib/machines/registry');
        registry.updateMachine(1, { switchEntity: 'switch.updated' });

        const haPath = require.resolve('../lib/ha');
        const realHa = require(haPath);
        const getSwitchStateMock = vi.fn().mockResolvedValue('off');
        require.cache[haPath].exports = { ...realHa, getSwitchState: getSwitchStateMock, HA_TOKEN: 'test-token' };
        const constantsHaPath = require.resolve('../lib/constants');
        require.cache[constantsHaPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile, HA_TOKEN: 'test-token' };
        delete require.cache[pollPath];

        const { checkAndApplyMachinePower } = require('../lib/poll');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        await checkAndApplyMachinePower(new MachineRuntimeState());

        expect(getSwitchStateMock).toHaveBeenCalledWith('switch.updated');

        // eslint-disable-next-line require-atomic-updates -- test cleanup, no concurrent access
        require.cache[haPath].exports = realHa;
    });

    it('lib/sync.js syncShots() gates on the registry\'s current switch_entity, not the stale options.json one', async () => {
        const registry = require('../lib/machines/registry');
        registry.updateMachine(1, { switchEntity: '' }); // cleared -> no entity configured

        const { syncShots } = require('../lib/sync');
        const ok = await syncShots({ machineOn: false });

        // With switch_entity cleared in the registry, the machine-off skip
        // gate must NOT trip on the stale options.json value ('switch.options_stale')
        // -- sync should proceed (and fail for an unrelated reason: no real
        // machine to reach), not short-circuit with ok === true.
        expect(ok).not.toBe(true);
    });

    it('falls back to options.json\'s switch_entity when the registry has no usable value', () => {
        const registry = require('../lib/machines/registry');
        const spy = vi.spyOn(registry, 'getDefaultMachine').mockReturnValue(null);

        const { buildPreheatResponse } = require('../lib/preheat');
        const { MachineRuntimeState } = require('../lib/machine-runtime-state');
        const runtime = new MachineRuntimeState();
        runtime.machineOn = false;

        const resp = buildPreheatResponse(runtime);
        expect(resp.ready).toBe(false); // still gates off the options.json fallback, doesn't throw

        spy.mockRestore();
    });
});
