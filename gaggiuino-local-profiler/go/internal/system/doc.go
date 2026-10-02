// Package system provides the REST endpoints for machine status, live data,
// preheat, version, token/status, demo seeding and manual sync, plus the
// background polling mechanism the other domains depend on for live machine
// data.
//
// # Scope
//
// Implemented: GET /api/machine/status, GET /api/live/data, GET /api/preheat,
// POST /api/preheat/ready-by, GET /api/version, GET /api/token,
// GET /api/status, GET /api/switch, POST /api/switch/toggle,
// GET /api/openapi.json, POST /api/sync, POST /api/demo/seed, POST
// /api/demo/end and GET /api/menu (routed ungated from internal/orders, which
// owns the menu Repository), plus the background polling loop (live polling,
// checkAndApplyMachinePower/backgroundHaCheck) and the preheat machinery
// (buildPreheatResponse/setReadyByTarget/isTempStable/save-load state and the
// ready-by auto turn-on watcher).
//
// GET /api/token is the only way any consumer (glp-integration's GlpAuth, the
// installable PWA) ever obtains a working X-GLP-Token, and GET /api/status is
// glp-integration's config-flow discovery probe AND every GlpDataCoordinator
// poll's first call, so both are load-bearing for real clients. See
// handlers.go's getToken/getStatus doc comments for exactly which fields those
// two report. GET /api/status's lastSync/lastSyncError come from POST
// /api/sync's manual pull loop (sync.go); syncRetryCount stays permanently 0
// because there is no automatic retry/backoff scheduler for it to hang off.
//
// The H2 debug-only GET /api/debug/machine lives in internal/debug alongside
// export-db/import-db.
//
// # File layout
//
//	runtime.go   RuntimeState — the shared machine runtime state,
//	             mutex-guarded because the 1s/30s/30s tickers plus
//	             concurrent HTTP reads run in parallel.
//	derive.go    deriveMachineState/isStillWarm — pure functions,
//	             unit-tested without any I/O.
//	poll.go      Poller — the polling loop + checkAndApplyMachinePower/
//	             backgroundHaCheck, plus pollGlobalState (per-machine
//	             reachability/error/firmware state keyed by machine id since
//	             #1201), plus StatusInfo()/MachineStatus() snapshotting what
//	             GET /api/status reads.
//	preheat.go   buildPreheatResponse, SetReadyByTarget,
//	             checkReadyByPreheat, save/load preheat_state.json.
//	options.go   loadPreheatMinutes() — a narrow options.json read, same
//	             pattern as internal/orders/options.go's isOrdersEnabled();
//	             also isApiPortExposed()/loadSyncIntervalMinutes()/its own
//	             isOrdersEnabled() duplicate, all GET /api/status fields.
//	status.go    GET /api/status's pure-logic pieces —
//	             statusMachine/buildStatusMachines (the `machines` array),
//	             apiURLAndHostnameFor/hostnameOnly (machineUrl/
//	             machineHostname string formatting), and
//	             hasUnconfirmedLegacyMachineOptions (a documented stub —
//	             see its own doc comment for why).
//	version.go   GET /api/version's GitHub-release check.
//	demo.go      POST /api/demo/{seed,end}.
//	handlers.go  the REST surface for everything above.
//
// # Live-snapshot production
//
// This package's Poller.emitLiveSnapshot is the sole live-snapshot producer.
// It reads the WS cache through machines.Adapter's
// GetLiveSensorSnapshot/GetLiveSystemState and publishes the openapi.yaml
// LiveData schema (isLive/profileName/datapoints/seq/machineReachable) that
// the live-snapshot SSE event and GET /api/live/data are both bound to.
//
// One deliberate simplification: #708's optimization (an immediate SSE push
// the instant a fresh WS/MQTT sample arrives, via an event-emitter bridge, on
// top of the 1s poll tick) is NOT implemented — every live-snapshot push here
// is tick-driven only, adding up to ~1s of extra latency before a fresh sensor
// reading reaches an open SSE connection. The #655 correctness fix this
// event-bridge sits on top of (distinguishing a powered-off machine from an
// idle-but-reachable one via machineReachable) IS fully implemented and is the
// one that actually matters for glp-integration/glp-order-card's correctness —
// #708 is pure latency polish. Wiring the bridge would mean exposing an event
// stream from internal/machines' live client, which doesn't exist yet; tracked
// as a follow-up.
//
// # Deliberately not implemented (and why)
//
//   - Most of the shot-sync engine. The default machine's syncShots() pull
//     loop backs POST /api/sync's manual trigger (sync.go); #953
//     (sync_triggers.go) added its three automatic drivers — the 3s post-brew
//     pull, the periodic pull + retry-backoff, and the #725
//     reachability-recovery catch-up. syncOtherMachines() (#341, #1146) rides
//     along with the manual and scheduled triggers — a non-default Gaggiuino
//     machine is pulled over the same /api/shots REST surface as the default
//     one, a GaggiMate through its history adapter — so the default machine's
//     own retry/backoff stays the only thing driven by a sync result. Still
//     not implemented are syncNativeMaintenance() (#578), syncProgress,
//     syncRetryCount (the backoff is tracked locally in runScheduledSync, not
//     exposed), and the backgroundHaCheck `if (!cachedMachineVersion)
//     fetchMachineVersion()` fallback: pollViaGaggiuinoStatus already
//     opportunistically captures each machine's cached version from its
//     successful status polls and shot syncs, and drops it again on an
//     unreachable->reachable transition (#1197/#1201); fetchMachineVersion is
//     only a fallback path for when polling itself isn't running, e.g. switch
//     off. GET /api/status's syncRetryCount field is consequently always 0 —
//     it describes exactly this unimplemented piece of the engine — see
//     handlers.go's getStatus doc comment.
//   - The rolling-window debug-log connectivity summary
//     (recordConnectivity/summarizeConnectivity) — pure logging diagnostics,
//     not part of any response contract.
//   - The MQTT live-transport branch — already out of scope per
//     internal/machines/doc.go; this package's poll.go calls
//     machines.Adapter.GetLiveSensorSnapshot/GetLiveSystemState directly,
//     which is always the WS-backed cache (GaggiuinoAdapter), matching the
//     behavior for every install that hasn't opted into the MQTT Settings
//     toggle.
//   - The barista "preheat ready" HA push (_checkPreheatNotify), gated by
//     orders settings' notify_preheat_ready/baristaNotifyService plus its
//     localized text — see preheat.go's header comment: wiring it needs a read
//     dependency on internal/orders' settings, and internal/orders already
//     depends on this package (see below) for its own shop-broadcast — adding
//     the reverse dependency too would need a second round of callback
//     plumbing. Still a follow-up (GET/POST /api/switch itself is
//     implemented).
//   - The write side of reconciling a legacy machine_host/switch_entity
//     add-on option into the registry (adoptOptionChanges) — GET /api/status's
//     legacyMachineOptionsPending field is consequently a documented
//     always-false stub; see status.go's hasUnconfirmedLegacyMachineOptions
//     doc comment for why implementing the read side alone isn't meaningful
//     without it.
//
// # internal/orders' shop-broadcast
//
// internal/orders/doc.go flagged its POST /api/orders/settings shop-open/
// shop-closed HA-notify broadcast as deferred pending the default machine's
// live runtime state from the system domain. That dependency is now
// resolvable: internal/orders/handlers.go takes a PreheatInfoFunc callback
// (not a direct import of this package, which would close a cycle — this
// package's own preheat-ready-notify would need to import internal/orders
// right back for its settings, see above) that cmd/server wires to
// Poller.PreheatInfo, closing that gap. See internal/orders/handlers.go's own
// comment on _broadcastShopState.
package system
