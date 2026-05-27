// Shared mutable runtime state. All modules require() this and read/write its properties.
// CommonJS module cache ensures every require() returns the same object.
module.exports = {
    apiToken:             '',
    lastSyncTime:         null,
    lastSyncError:        null,
    syncRetryCount:       0,
    lastManualSync:       0,
    lastKnownShotId:      0,
    cachedMachineVersion: null,
    machineOn:            false,
    livePollTimer:        null,
    liveAccum:            null,
    isPollRunning:        false,
    liveSeq:              0,
    switchOnAt:           null,
    switchOffAt:          null,
    currentTemp:          null,
    currentTargetTemp:    null,
    tempHistory:          [],
    // Full machine status (cached from /api/system/status polls)
    machineStatus:        null,
    // Profile list (cached from /api/profiles/all)
    machineProfiles:      [],
};
