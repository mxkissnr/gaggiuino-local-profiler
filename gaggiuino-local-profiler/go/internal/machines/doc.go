// Package machines is the machine-registry and machine-control domain
// (#901 — the third and largest REST domain after shots/library, and the
// first to also run a background WebSocket client): registry CRUD and the
// reachability probe, the Gaggiuino settings/opmode/tare/service-test/
// firmware proxy, machine profiles and live status, and the per-machine-
// type adapter layer (Gaggiuino WebSocket/protobuf client, GaggiMate JSON
// WebSocket client, registry facade).
//
// # Layout
//
//   - model.go / theme_presets.go — Machine/MachineInput/Theme and the
//     theme presets.
//   - ssrf.go — assertMachineHost, the narrower loopback/link-local-only
//     SSRF guard (a real machine legitimately lives in RFC1918 space,
//     unlike internal/library's assertPublicHost).
//   - registry.go — the `machines` table CRUD (already created by
//     internal/db — see that package's schema), ResolveMachine, and
//     BaseURLFor (the shared per-adapter base-URL helper, defined once
//     here instead of once per adapter).
//   - adapter.go — the Adapter interface (the documented per-machine-type
//     contract, extended with the #597 settings-proxy methods) and
//     per-machine-type dispatch.
//   - validation.go — profile-input types (phaseSchema et al.) and
//     ToWireProfile(), which converts a profile to its wire representation.
//   - proto/ — the reconstructed Gaggiuino binary protobuf schema (see its
//     own doc.go for the full story: no `.proto` sources exist anywhere,
//     hand-written Go structs + wire codec, cross-validated against real
//     captured runtime output).
//   - ws.go / live.go — the short-lived-connection-per-request client
//     (profile CRUD, #597 commands) and the persistent auto-reconnecting
//     session (cached d_sensor_snap/d_sys_state pushes), both on
//     github.com/coder/websocket.
//   - gaggiuino_adapter.go / http.go — the Gaggiuino Adapter implementation:
//     REST calls (net/http) plus ws.go/live.go for what has no REST
//     equivalent.
//   - gaggimate_ws.go / gaggimate_profiles.go / gaggimate_adapter.go — the
//     GaggiMate Adapter implementation: a short-lived JSON WebSocket
//     client (request()/waitForStatus() only — see gaggimate_ws.go's
//     header comment for what's deliberately not implemented) plus profile
//     pass-throughs.
//   - firmware_check.go — the #620 GitHub-releases update-availability
//     check.
//   - handlers.go / handlers_registry.go / handlers_control.go /
//     handlers_profiles.go — the REST surface, split the same way
//     internal/library splits its handler files by sub-domain.
//
// # The settings bool-as-string quirk
//
// The Gaggiuino REST API's settings endpoints encode several boolean
// fields as the JSON *strings* `"true"`/`"false"` instead of real JSON
// booleans: boiler.brewDeltaState/dreamSteamState, display.lcdDarkMode,
// scales.forcePredictive/hwScalesEnabled/btScalesEnabled, and
// led.state/disco (verified against glp-integration's
// custom_components/gaggiuino_profiler/gaggiuino_bool.py, the consumer
// this quirk exists for — it coerces exactly this field list on read and
// re-encodes matching the original representation on write). The settings
// endpoints never normalize these — getSettings/updateSettings are thin
// passthroughs, forwarding whatever JSON shape the machine itself
// returns/expects.
//
// This package replicates that passthrough exactly by treating a settings
// payload as opaque bytes end-to-end, never as a typed Go struct with real
// bool fields: GetSettings/UpdateSettings both move json.RawMessage/raw
// []byte only (see http.go's httpGetBytes/httpPostBytes and
// gaggiuino_adapter.go's doc comments), and handlers_control.go's
// updateSettings handler forwards the exact client request bytes it read
// off the wire, not a JSON-decoded-then-re-encoded value. See
// gaggiuino_adapter_test.go's TestGaggiuinoAdapter_SettingsQuirkPassthrough
// and handlers_test.go's TestHandlers_SettingsQuirkPassthrough_EndToEnd
// for the tests that verify this field-by-field, at both the adapter and
// full-HTTP-handler layers.
//
// # 501 = adapter unsupported
//
// The settings/control proxy's 501="adapter unsupported" status code
// (requireSettingsProxySupport in handlers.go, returned when an adapter's
// capabilities().settingsProxy is false — only GaggiMate) is used by every
// handler in handlers_control.go. requireProfileEditSupport (also 501,
// gated on capabilities().profileEdit) is the same pattern for the
// profile-write routes in handlers_profiles.go. This package has no
// "feature disabled" 404 case of its own — that pattern (isOrdersEnabled)
// belongs to the orders package; see go/internal/orders/doc.go.
//
// # Machine.Host is registry-facade-only (#989)
//
// BaseURLFor (registry.go) is the only sanctioned path from a Machine to an
// actual outbound connection — every Adapter method resolves its baseURL
// through it, which re-runs assertMachineHost's SSRF guard on every call
// (see BaseURLFor's own doc comment). By construction, nothing in this
// package currently bypasses it. Nothing *enforces* that staying true,
// though, beyond code review and Machine.Host's own field comment
// (model.go) pointing here.
//
// A static check for the equivalent invariant was considered and rejected:
// Machine.Host is a real exported Go struct field, and "Host" alone is
// common enough elsewhere in ordinary Go code (http.Request.Host,
// url.URL.Host, this very package's own machineRow.Host in registry.go)
// that a textual pattern match can't reliably tell "a Machine.Host read
// outside registry.go" from unrelated code without type information a
// shell script doesn't have. A check that noisy would train reviewers to
// ignore its failures — worse than no check at all. The doc comment plus
// review is the deliberate substitute; revisit if this package ever gains
// enough Adapter implementations or call sites that review alone stops
// being reliable.
//
// # What this package deliberately does NOT implement (and why)
//
//   - GET /api/machine/status, GET /api/preheat, POST /api/preheat/ready-by,
//     GET /api/live/data — all four depend on the single-machine 1s
//     background polling loop (machine status, preheat scheduling), which
//     is the `system` package's job, not this one's. GET /api/machine/live
//     (which IS implemented here, backed by live.go's own WS session cache
//     rather than the poller's) is genuinely machine-adapter-scoped;
//     internal/system's poll.go reads that same cache through this
//     package's Adapter interface rather than duplicating it.
//   - GET /api/machine/profiles' default-machine special case, which would
//     read the system poller's cached machine status instead of calling
//     adapter.GetStatus() directly for the default machine only.
//     handlers_profiles.go's listMachineProfiles calls adapter.GetStatus()
//     unconditionally for every machine, default or not — functionally
//     equivalent (same response shape) but one extra round trip to the
//     machine for the default machine's profile list specifically, until
//     this can wire into internal/system's cache instead.
//   - The default machine's on-disk profiles-cache persistence. handlers.go's
//     profilesCache is in-memory only for every machine including the
//     default one — acceptable since this binary isn't wired into a
//     running add-on process yet (go/README.md).
//   - The MQTT live-data transport (an alternative to the WebSocket path
//     live.go implements, toggled by a Settings-page option,
//     default-machine-only). Not in scope and not reachable from any
//     endpoint this package exposes.
//   - GaggiMate's index.bin/.slog binary shot-history parsing
//     (GaggiMateAdapter's GetLatestShotId/GetShot). These back the
//     background shot-history sync, not any REST endpoint this package
//     exposes — the shots-sync domain itself (#729/#731 catch-up sync
//     included, see handlers_registry.go's header comment) doesn't run as
//     a background process in this binary yet either.
//   - The GaggiMate live client (a third, persistent-connection pattern,
//     used only by the system poller's multi-machine live-poll loop) — see
//     live.go's header comment: every REST endpoint that would read its
//     cached data is gated by requireSettingsProxySupport, and GaggiMate
//     reports capabilities().settingsProxy == false, so it's unreachable
//     from this package's REST surface regardless.
//   - Machine restore (Registry.RestoreMachines, #901) — the backup domain
//     (go/internal/backup) calls it. Deliberately NOT included: evicting
//     the live session for every host that existed before the restore (a
//     stale WS session simply reconnects/fails naturally against a host
//     nothing identifies anymore, rather than being torn down immediately —
//     a cosmetic timing difference, not a data-correctness one) and
//     reconciling a restored machine's stale host/switchEntity back to the
//     current legacy add-on options.json (no options.json facade exists
//     yet; see go/internal/orders/options.go's isOrdersEnabled() for the
//     same gap noted from the orders domain's side). See RestoreMachines'
//     own doc comment for the full detail.
//
// # Protobuf verification status
//
// proto/messages.go's hand-written wire codec is cross-validated against
// real captured runtime output (proto/node_vectors_test.go) — genuine
// ground truth, since it comes from the code talking to real machines in
// production today. It has NOT been verified against a live machine
// directly: no network access to real hardware was available while this
// package was built (go/RESEARCH.md's documented blocker).
// cmd/gaggiuino-ws-probe is the tool this package ships specifically so
// that step is a `go run` away once real hardware is reachable — see its
// own doc comment.
package machines
