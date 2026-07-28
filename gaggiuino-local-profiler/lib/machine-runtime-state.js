'use strict';

// Per-machine runtime state (#549). Previously these ten fields lived on the
// lib/state.js singleton even though they describe exactly one machine's
// live polling/preheat state (temperature, brew switch, cached profiles...).
// lib/poll.js, lib/preheat.js and the live-status routes in routes/system.js
// are hard single-machine today (always the default/legacy machine, id 1),
// so this keeps that behavior unchanged while giving each machine id its
// own instance -- ready for those call sites to eventually loop over more
// than one machine without the fields colliding.
class MachineRuntimeState {
    constructor() {
        this.machineOn          = false;
        this.currentTemp        = null;
        this.currentTargetTemp  = null;
        this.tempHistory        = [];
        this.switchOnAt         = null;
        this.switchOffAt        = null;
        this.stabilityReady     = false;
        this.livePollTimer      = null;
        this.machineStatus      = null;
        this.machineProfiles    = [];
    }
}

const instances = new Map(); // machineId -> MachineRuntimeState

function getMachineRuntimeState(machineId = 1) {
    if (!instances.has(machineId)) instances.set(machineId, new MachineRuntimeState());
    return instances.get(machineId);
}

module.exports = { MachineRuntimeState, getMachineRuntimeState };
