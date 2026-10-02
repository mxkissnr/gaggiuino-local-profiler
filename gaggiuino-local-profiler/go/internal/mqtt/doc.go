// Package mqtt implements the #608 MQTT live-data transport: the WebSocket/
// MQTT settings, the persistent broker subscription, the WS-vs-MQTT dispatch,
// and the four endpoints (GET /api/mqtt/discovery, GET/POST /api/mqtt/settings,
// POST /api/mqtt/apply-to-machine).
//
//   - settings.go  — the Settings-page WebSocket/MQTT toggle + broker
//     connection, stored under kv.key = 'mqtt_settings'. NO schema migration
//     was needed — it's a kv row, exactly like 'import_settings'/
//     'shot_defaults'.
//   - client.go    — the persistent broker subscription (github.com/eclipse/
//     paho.mqtt.golang, EPL-2.0/EDL-1.0). toSensorSnap/toSysState translate
//     MQTT.md's `<prefix>/sensors` and `<prefix>/system` payloads into the
//     exact proto DTOs internal/machines/live.go's WS decoder produces, so
//     internal/system's deriveMachineState stays transport-agnostic. The MQTT
//     string operationMode ("BREW_AUTO") decodes through
//     proto.OperationMode.UnmarshalJSON.
//   - transport.go — the WS-vs-MQTT dispatch: only the default machine, only
//     when the toggle is MQTT with a host configured. Wired into
//     internal/system's poller via its LiveTransport interface
//     (SetLiveTransport) — parallel to the adapter's WS path.
//   - discovery.go — Supervisor /services/mqtt auto-discovery via
//     ha.Client.SupervisorGet.
//
// Not consumed (received and discarded, as the original subscription does):
// the shot/profile/active/maintenance/notification topics — wiring a second
// transport into shot-sample accumulation etc. is scope beyond substituting
// the live-state cache.
package mqtt
