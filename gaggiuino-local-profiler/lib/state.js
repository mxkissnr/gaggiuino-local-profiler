// Shared mutable runtime state. All modules require() this and read/write its properties.
// CommonJS module cache ensures every require() returns the same object.
//
// Machine-scoped fields (per-machine temperature/brew-switch/profile state)
// moved to lib/machine-runtime-state.js's MachineRuntimeState (#549) — only
// genuinely global fields remain here.
module.exports = {
    apiToken:             '',
    lastSyncTime:         null,
    lastSyncError:        null,
    syncRetryCount:       0,
    // Machine connection state (first-run onboarding, see #274). null = never checked.
    machineReachable:     null,
    lastMachineError:     null,
    lastMachineSuccess:   null,
    lastManualSync:       0,
    lastKnownShotId:      0,
    cachedMachineVersion: null,
    preheatNotifySent:    false,
    liveAccum:            null,
    isPollRunning:        false,
    liveSeq:              0,
    // Ready-by preheat (#541): wall-clock target set via
    // POST /api/preheat/ready-by, and the switch-on time computed from it
    // (targetAt - preheat_time). Both null when no target is set.
    readyByTargetAt:      null,
    plannedSwitchOnAt:    null,
};
