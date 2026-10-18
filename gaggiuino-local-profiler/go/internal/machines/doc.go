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
//   - validation.go — profile-input types (ProfileInput/PhaseInput et al.)
//     and ToWireProfile(), which converts a profile to its wire
//     representation.
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
//   - gaggimate_ws.go / gaggimate_live.go / gaggimate_profiles.go /
//     gaggimate_history.go / gaggimate_adapter.go — the GaggiMate Adapter
//     implementation: a short-lived JSON WebSocket helper, a persistent
//     live-status session, profile pass-throughs and the index.bin/.slog
//     shot-history parser.
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
// This package keeps a settings payload as opaque JSON end-to-end, never a
// typed Go struct with real bool fields: GetSettings/UpdateSettings move
// json.RawMessage/raw []byte only (see http.go's httpGetBytes/httpPostBytes),
// and handlers_control.go's updateSettings forwards the client's request
// bytes unchanged — except for the "system" category, which is decoded into
// a map so the redacted mqttPassword can be restored (#1431) and then
// re-encoded. String-encoded bools survive that round trip as strings. See
// gaggiuino_adapter_test.go's TestGaggiuinoAdapter_SettingsQuirkPassthrough
// and handlers_test.go's TestHandlers_SettingsQuirkPassthrough_EndToEnd.
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
// # What lives elsewhere, or is not done
//
//   - GET /api/machine/status, GET /api/preheat, POST /api/preheat/ready-by
//     and GET /api/live/data belong to internal/system's poller. GET
//     /api/machine/live is served here from live.go's WS session cache,
//     which internal/system's poller reads through the Adapter interface.
//   - The MQTT live-data transport is internal/mqtt; the background
//     shot-history sync (which calls GetLatestShotId/GetShot) is
//     internal/system.
//   - listMachineProfiles asks the machine live for every machine; only a
//     machine the poller already knows is unreachable is served straight
//     from the local ProfilesRepository cache (#1572).
//   - Registry.RestoreMachines (#901, called by internal/backup) does not
//     tear down live sessions for hosts that existed before the restore;
//     they idle out or reconnect on their own.
//
// # Protobuf verification status
//
// proto/messages.go's hand-written wire codec is cross-validated against
// wire vectors captured from the former Node implementation
// (proto/node_vectors_test.go). The tests do not talk to a live machine;
// cmd/gaggiuino-ws-probe dumps decoded frames from a real one for manual
// checks.
package machines
