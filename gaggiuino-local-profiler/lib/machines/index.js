// Adapter dispatch + shot-id namespacing helpers for multi-machine support
// (#317). See adapter-base.js for the interface every adapter implements.
'use strict';

// The default machine (id 1) keeps its native Gaggiuino shot ids completely
// unchanged (zero-touch upgrade for existing installs — same ids, same
// image filenames, same annotation keys). Any additional machine's shots get
// a synthetic id in a disjoint range so two machines can never collide on
// the same shots.id, without ever having to rebuild the shots table's
// PRIMARY KEY.
const MACHINE_ID_OFFSET = 10_000_000;

function toGlobalShotId(machineId, nativeId) {
    return machineId === 1 ? nativeId : machineId * MACHINE_ID_OFFSET + nativeId;
}

function toNativeShotId(machineId, globalId) {
    return machineId === 1 ? globalId : globalId - machineId * MACHINE_ID_OFFSET;
}

// Best-effort reverse lookup from a bare global id alone (no machine_id
// column available, e.g. legacy callers) — ids below the offset are the
// default machine's own native ids.
function ownerOfShotId(globalId) {
    if (globalId < MACHINE_ID_OFFSET) return 1;
    return Math.floor(globalId / MACHINE_ID_OFFSET);
}

function getAdapter(machine) {
    if (!machine || !machine.type) throw new Error('getAdapter requires a machine record with a type');
    switch (machine.type) {
        case 'gaggiuino': return require('./gaggiuino/adapter');
        case 'gaggimate':  return require('./gaggimate/adapter');
        default: throw new Error(`Unknown machine type: ${machine.type}`);
    }
}

module.exports = {
    MACHINE_ID_OFFSET, toGlobalShotId, toNativeShotId, ownerOfShotId, getAdapter,
};
