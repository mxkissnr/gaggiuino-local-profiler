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
    // #773: mutex guarding syncShots() (default machine) against overlapping
    // calls -- lib/poll.js's reachability-recovery catch-up sync is
    // fire-and-forget and could otherwise start a second backfill while the
    // scheduled one is still running, with each call's independently
    // computed `total` clobbering the same syncProgress entry above and
    // making the displayed progress denominator jump around mid-backfill.
    // Same pattern as isPollRunning below. A Set (not a boolean) for
    // syncMachineShots()'s other-machine backfills, keyed by machine.id, so
    // two different machines can still sync concurrently -- only a second
    // call for the SAME machine is skipped.
    defaultSyncInFlight:  false,
    otherMachineSyncInFlight: new Set(),
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
    // #902: steam/flush live sessions, same hard-single-machine slot
    // pattern as liveAccum/liveSeq above (lib/poll.js is explicitly
    // single-machine, see its own header comment) -- a genuine
    // multi-machine migration of this whole tracking scheme is out of
    // scope here, not attempted.
    steamAccum:           null,
    steamSeq:             0,
    flushAccum:           null,
    flushSeq:             0,
    // Ready-by preheat (#541): wall-clock target set via
    // POST /api/preheat/ready-by, and the switch-on time computed from it
    // (targetAt - preheat_time). Both null when no target is set.
    // Same single-machine scope as steamAccum/flushAccum above (lib/preheat.js
    // is explicitly single-machine, see its own header comment) -- extending
    // ready-by to a non-default machine needs a real Map<machineId,...> here.
    readyByTargetAt:      null,
    plannedSwitchOnAt:    null,
};
