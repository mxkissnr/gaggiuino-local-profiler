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
// two report. GET /api/status's lastSync/lastSyncError come from the default
// machine's shot-history pull (sync.go).
//
// The H2 debug-only GET /api/debug/machine lives in internal/debug alongside
// export-db/import-db.
//
// # File layout
//
//	runtime.go          RuntimeState — the default machine's mutex-guarded
//	                    power/preheat runtime state.
//	derive.go           deriveMachineState/isStillWarm — pure functions.
//	poll.go             Poller — the polling loop, checkAndApplyMachinePower/
//	                    backgroundHaCheck, pollGlobalState (per-machine
//	                    reachability/error/firmware state keyed by machine id,
//	                    #1201) and StatusInfo()/MachineStatus().
//	poll_live.go        the live-data accumulator and emitLiveSnapshot.
//	poll_gaggiuino.go   per-tick machine status polling (pollViaGaggiuinoStatus).
//	sync.go             the shot-history pull (default + other machines).
//	sync_triggers.go    post-brew, scheduled and recovery sync drivers.
//	maintenance_sync.go mirrors a Gaggiuino's service log onto maintenance
//	                    tasks (#1639).
//	profile_sync.go     pushes locally edited profiles to the machine.
//	preheat.go          buildPreheatResponse, SetReadyByTarget,
//	                    checkReadyByPreheat, the preheat-ready notifier and
//	                    preheat_state.json; preheat_history.go its history.
//	switch.go           GET /api/switch, POST /api/switch/toggle.
//	options.go          thin wrappers over internal/config's shared
//	                    options.json reader.
//	status.go           GET /api/status's pure-logic pieces.
//	version.go          GET /api/version's GitHub-release check.
//	demo.go             POST /api/demo/{seed,end}.
//	openapi.go          serves openapi.yaml as GET /api/openapi.json.
//	handlers.go         the REST surface for everything above.
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
// # Not implemented
//
//   - syncProgress: the shot-history backfill runs, but nothing tracks or
//     streams its progress.
//   - The rolling-window debug-log connectivity summary
//     (recordConnectivity/summarizeConnectivity).
//   - Adopting a legacy machine_host/switch_entity app option into the
//     registry: those options were removed (#662), and GET /api/status's
//     legacyMachineOptionsPending was removed as dead code (#1621).
//
// The MQTT live transport (internal/mqtt) is wired in through
// SetLiveTransport, and the preheat-ready push through
// SetPreheatReadyNotifier (see preheat.go).
//
// # internal/orders' shop-broadcast
//
// internal/orders' shop-open/closed HA-notify broadcast needs the default
// machine's preheat state. internal/orders takes a PreheatInfoFunc callback
// (a direct import of this package would close a cycle, since the
// preheat-ready notifier needs the orders settings) that cmd/server wires to
// Poller.PreheatInfo.
package system
