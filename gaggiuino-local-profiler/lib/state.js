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
    // Shot-import progress (#729): keyed by machineId (Map<machineId,
    // {current,total}>), one entry per backfill currently running in
    // lib/sync.js's syncShots()/syncMachineShots() -- a Map (not a single
    // object) so the default machine's sync and another machine's sync can
    // run concurrently (e.g. two newly-added machines saved back-to-back,
    // or a manual save landing mid-way through the periodic
    // syncAllMachines() tick) without one clobbering the other's progress
    // or prematurely clearing it out from under it (#730 review).
    syncProgress:         new Map(),
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
