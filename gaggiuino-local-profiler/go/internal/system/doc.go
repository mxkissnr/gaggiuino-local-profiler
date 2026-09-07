// Package system is the Go port of Phase 1g (#901): the last REST domain
// from the migration plan, plus the background polling mechanism the other
// domains depend on for live machine data.
//
// # Scope
//
// Ported: GET /api/machine/status, GET /api/live/data, GET /api/preheat,
// POST /api/preheat/ready-by, GET /api/version, POST /api/demo/seed, POST
// /api/demo/end, and lib/poll.js's background polling loop
// (startLivePolling/stopLivePolling/pollLive/pollViaGaggiuinoStatus,
// checkAndApplyMachinePower/backgroundHaCheck) plus lib/preheat.js's
// buildPreheatResponse/setReadyByTarget/isTempStable/save-load state and
// the ready-by auto turn-on watcher (_checkReadyByPreheat). Phase 3b
// (#901) added GET /api/token and GET /api/status: Phase 1g's own "not
// required to make the endpoints above correct" reasoning for deferring
// them turned out wrong once verified against a real glp-integration
// install — GET /api/token is the ONLY way any consumer (glp-integration's
// GlpAuth, the installable PWA) ever obtains a working X-GLP-Token, and
// GET /api/status is glp-integration's config-flow discovery probe AND
// every GlpDataCoordinator poll's first call — without both, nothing
// downstream of Phase 1g's own endpoints was ever reachable by a real
// client. See handlers.go's getToken/getStatus doc comments for exactly
// which fields those two report. Phase 2a (#901) wired GET /api/status's
// lastSync/lastSyncError from POST /api/sync's manual pull loop (sync.go);
// syncRetryCount stays permanently 0 — the automatic retry/backoff
// scheduler is still unported (no automatic sync loop for it to hang off).
//
// Phase 2a (#901) routed the rest of routes/system.js's surface the
// embedded Vite frontend / glp-integration call: GET /api/switch +
// POST /api/switch/toggle (switch.go), GET /api/openapi.json (openapi.go —
// the repo-root openapi.yaml is committed as go/internal/system/
// openapi.yaml and served as JSON), POST /api/sync (sync.go — see its
// header for exactly what of lib/sync.js it does and does not port), and
// GET /api/menu (routed ungated from internal/orders, which owns the menu
// Repository). routes/system.js's whole surface is now routed: the last
// holdout, the H2 debug-only GET /api/debug/machine, moved to
// internal/debug alongside routes/debug.js's export-db/import-db in Phase
// 2e (#901).
//
// # File layout
//
//	runtime.go   RuntimeState — lib/machine-runtime-state.js's
//	             MachineRuntimeState, mutex-guarded (Node's single-
//	             threaded event loop needed no lock; Go's 1s/30s/30s
//	             tickers plus concurrent HTTP reads do).
//	derive.go    deriveMachineState/isStillWarm — lib/machine-state.js,
//	             pure functions, unit-tested without any I/O.
//	poll.go      Poller — lib/poll.js's polling loop + checkAndApplyMachinePower/
//	             backgroundHaCheck, plus lib/state.js's module-level
//	             fields this package needs (pollGlobalState), plus
//	             StatusInfo() (Phase 3b) snapshotting the subset GET
//	             /api/status reads.
//	preheat.go   lib/preheat.js: buildPreheatResponse, SetReadyByTarget,
//	             checkReadyByPreheat, save/load preheat_state.json.
//	options.go   loadPreheatMinutes() — a narrow options.json read, same
//	             pattern as internal/orders/options.go's isOrdersEnabled();
//	             Phase 3b added the same narrow-read pattern for
//	             isApiPortExposed()/loadSyncIntervalMinutes()/its own
//	             isOrdersEnabled() duplicate, all GET /api/status fields.
//	status.go    Phase 3b: GET /api/status's pure-logic pieces —
//	             statusMachine/buildStatusMachines (the `machines` array),
//	             apiURLAndHostnameFor/hostnameOnly (machineUrl/
//	             machineHostname string formatting), and
//	             hasUnconfirmedLegacyMachineOptions (a documented stub —
//	             see its own doc comment for why).
//	version.go   lib/version-check.js — GET /api/version's GitHub-release
//	             check.
//	demo.go      lib/services/DemoService.js + lib/demo-seed.js — POST
//	             /api/demo/{seed,end}.
//	handlers.go  routes/system.js's REST surface for everything above.
//
// # Reconciling with Phase 1e's live.go
//
// Phase 1e's internal/machines/live.go published every WS
// sensor-snap/sys-state push directly onto the shared internal/sse.Hub as
// EventLiveSnapshot, explicitly as a stand-in ("closing the loop the task
// brief asked for... Reconciling the two into one payload shape is
// system-domain work, out of this package's scope" — see that file's own
// header comment as it stood before this phase). That payload shape
// ({machineHost, sensorSnap} / {machineHost, sysState}) never matched
// openapi.yaml's LiveData schema (isLive/profileName/datapoints/seq/
// machineReachable) the live-snapshot SSE event and GET /api/live/data are
// both bound to — and Node's own architecture agrees: only lib/poll.js's
// emitLiveSnapshot() ever publishes LIVE_SNAPSHOT there; the WS client
// (lib/gaggiuino-live-client.js) only ever updates a cache lib/poll.js
// reads from via lib/live-transport.js, never publishes itself.
//
// This phase removes machines/live.go's direct Hub.Publish calls (see its
// updated header comment) and makes this package's Poller.emitLiveSnapshot
// the sole live-snapshot producer, reading the same WS cache through
// machines.Adapter's GetLiveSensorSnapshot/GetLiveSystemState — exactly
// Node's live-transport.js dispatch seam, minus the MQTT branch (see
// poll.go's header comment on what else lib/poll.js/lib/live-transport.js
// this package does not port).
//
// One deliberate simplification versus Node: #708's optimization (an
// immediate SSE push the instant a fresh WS/MQTT sample arrives, via an
// event-emitter bridge, on top of the 1s poll tick) is NOT ported — every
// live-snapshot push here is tick-driven only, adding up to ~1s of extra
// latency before a fresh sensor reading reaches an open SSE connection.
// The #655 correctness fix this event-bridge sits on top of (distinguishing
// a powered-off machine from an idle-but-reachable one via
// machineReachable) IS fully ported and is the one that actually matters
// for glp-integration/glp-order-card's correctness — #708 is pure latency
// polish. Wiring the bridge would mean exposing an event stream from
// internal/machines' live client, which doesn't exist yet; tracked as a
// follow-up, not attempted in this already-large phase.
//
// # Deliberately not ported (and why)
//
//   - most of lib/sync.js. Phase 2a (#901) ported the default machine's
//     syncShots() pull loop for POST /api/sync's manual trigger (sync.go);
//     #953 (sync_triggers.go) added its three automatic drivers —
//     syncAfterBrew()'s 3s post-brew pull, scheduleNextSync()'s periodic
//     pull + retry-backoff, and lib/poll.js's #725 reachability-recovery
//     catch-up. Still not ported are syncOtherMachines()/syncMachineShots()
//     (needs adapter GetShot/GetLatestShotId methods — machines-domain
//     work), syncNativeMaintenance() (#578), the SYNC_PROGRESS/SYNC_COMPLETE
//     bus events (state.syncProgress), state.syncRetryCount (the backoff is
//     tracked locally in runScheduledSync, not exposed), and
//     fetchMachineVersion() — backgroundHaCheck's
//     `if (!cachedMachineVersion) fetchMachineVersion()` fallback (this
//     package's own pollViaGaggiuinoStatus already opportunistically
//     captures cachedMachineVersion from every successful status poll, the
//     same field Node's inline capture in lib/poll.js also fills — Node's
//     fetchMachineVersion is a *fallback path* for when polling itself
//     isn't running, e.g. switch off).
//     GET /api/status's syncRetryCount field (Phase 3b, #901) is
//     consequently always 0 in this Go port — it describes exactly this
//     unported piece of the engine
//     — see handlers.go's getStatus doc comment.
//   - lib/connectivity-stats.js's rolling-window debug-log summary
//     (recordConnectivity/summarizeConnectivity) — pure logging
//     diagnostics, not part of any response contract.
//   - lib/live-transport.js's MQTT branch — already out of scope per
//     internal/machines/doc.go (Phase 1e); this package's poll.go calls
//     machines.Adapter.GetLiveSensorSnapshot/GetLiveSystemState directly,
//     which is always the WS-backed cache (GaggiuinoAdapter), matching
//     live-transport.js's behavior for every install that hasn't opted
//     into the MQTT Settings toggle.
//   - lib/preheat.js's _checkPreheatNotify (the barista "preheat ready" HA
//     push, gated by orders settings' notify_preheat_ready/
//     baristaNotifyService plus lib/notify-i18n.js's localized text) — see
//     preheat.go's header comment: wiring it needs a read dependency on
//     internal/orders' settings, and internal/orders already depends on
//     this package (see below) for its own shop-broadcast — adding the
//     reverse dependency too, in the same phase, would need a second round
//     of callback plumbing this phase's budget didn't cover. Still a
//     follow-up (GET/POST /api/switch itself is now ported — Phase 2a).
//   - lib/machines/options-adoption.js's adoptOptionChanges() (the write
//     side of reconciling a legacy machine_host/switch_entity add-on
//     option into the registry) — GET /api/status's
//     legacyMachineOptionsPending field (Phase 3b) is consequently a
//     documented always-false stub; see status.go's
//     hasUnconfirmedLegacyMachineOptions doc comment for why porting the
//     read side alone isn't meaningful without it.
//   - GET /api/debug/machine (Phase 2e's debug-routes brief). Everything
//     else in routes/system.js is now routed — see "Scope" above.
//
// # internal/orders' shop-broadcast (closed in this phase)
//
// internal/orders/doc.go flagged its POST /api/orders/settings shop-open/
// shop-closed HA-notify broadcast as deferred pending "the default
// machine's live runtime state from the still-unported system domain."
// That dependency is now resolvable: internal/orders/handlers.go takes a
// PreheatInfoFunc callback (not a direct import of this package, which
// would close a cycle — this package's own preheat-ready-notify would need
// to import internal/orders right back for its settings, see above) that
// cmd/server wires to Poller.PreheatInfo, closing that gap. See
// internal/orders/handlers.go's own comment on _broadcastShopState for the
// port itself.
package system
