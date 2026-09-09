package proto

import (
	"encoding/json"
	"fmt"
)

// Every enum below ports one lib/gaggiuino-proto.js `const XxxDto = {0:
// 'NAME', NAME: 0, ...}` map verbatim — same names, same numeric values.
// Each type's UnmarshalJSON accepts either its wire-enum name (a JSON
// string) or its numeric value (a JSON number), matching
// gaggiuino-ws-client.js's own `typeof x === 'string' ? EnumDto[x] : x`
// convention for every enum field a caller can set (toWireProfile's
// type/curve, setOperationMode's mode, serviceTest's peripheral). A plain
// number is otherwise how encoding/json already marshals a defined int32
// type with no custom MarshalJSON — deliberately not overridden, since
// lib/gaggiuino-proto.js's own fromBinary()+JSON.stringify() output (the
// shape go/internal/machines's handlers must match for decoded
// machine-pushed data) is a plain number too, never the enum name string
// (verified directly: ProfileDto.fromBinary(...) round-tripped through
// JSON.stringify emits `"type":1`, not `"type":"PRESSURE"`).

// PhaseType ports PhaseTypeDto.
type PhaseType int32

const (
	PhaseFlow     PhaseType = 0
	PhasePressure PhaseType = 1
	PhaseManual   PhaseType = 2
)

var phaseTypeNames = map[string]PhaseType{"FLOW": PhaseFlow, "PRESSURE": PhasePressure, "MANUAL": PhaseManual}

func (p *PhaseType) UnmarshalJSON(b []byte) error {
	v, err := unmarshalEnumJSON(b, phaseTypeNames, "PhaseType")
	if err != nil {
		return err
	}
	*p = PhaseType(v)
	return nil
}

// TransitionCurve ports TransitionCurveDto.
type TransitionCurve int32

const (
	CurveEaseInOut TransitionCurve = 0
	CurveEaseIn    TransitionCurve = 1
	CurveEaseOut   TransitionCurve = 2
	CurveLinear    TransitionCurve = 3
	CurveInstant   TransitionCurve = 4
)

var transitionCurveNames = map[string]TransitionCurve{
	"EASE_IN_OUT": CurveEaseInOut, "EASE_IN": CurveEaseIn, "EASE_OUT": CurveEaseOut,
	"LINEAR": CurveLinear, "INSTANT": CurveInstant,
}

func (c *TransitionCurve) UnmarshalJSON(b []byte) error {
	v, err := unmarshalEnumJSON(b, transitionCurveNames, "TransitionCurve")
	if err != nil {
		return err
	}
	*c = TransitionCurve(v)
	return nil
}

// WebSocketResponseResult ports WebSocketResponseResultDto — decode-only
// (a d_resp field, never sent by this app), so no UnmarshalJSON is needed,
// but one is provided anyway for symmetry/testability.
type WebSocketResponseResult int32

const (
	ResultSuccess WebSocketResponseResult = 0
	ResultError   WebSocketResponseResult = 1
)

var webSocketResponseResultNames = map[string]WebSocketResponseResult{"SUCCESS": ResultSuccess, "ERROR": ResultError}

func (r *WebSocketResponseResult) UnmarshalJSON(b []byte) error {
	v, err := unmarshalEnumJSON(b, webSocketResponseResultNames, "WebSocketResponseResult")
	if err != nil {
		return err
	}
	*r = WebSocketResponseResult(v)
	return nil
}

// OperationMode ports OperationModeDto. BREW_MANUAL (1) is a valid wire
// value here (this package models the full wire enum) — rejecting it as
// unusable through the settings/control proxy is a go/internal/machines
// validation-layer concern (mirrors operationModeSchema.js's `.refine()`),
// not something this low-level type enforces.
type OperationMode int32

const (
	ModeBrewAuto   OperationMode = 0
	ModeBrewManual OperationMode = 1
	ModeFlush      OperationMode = 2
	ModeDescale    OperationMode = 3
	ModeSteam      OperationMode = 4
	ModeFlushAuto  OperationMode = 5
	ModeHotWater   OperationMode = 6
	ModeHome       OperationMode = 7
)

var operationModeNames = map[string]OperationMode{
	"BREW_AUTO": ModeBrewAuto, "BREW_MANUAL": ModeBrewManual, "FLUSH": ModeFlush,
	"DESCALE": ModeDescale, "STEAM": ModeSteam, "FLUSH_AUTO": ModeFlushAuto,
	"HOT_WATER": ModeHotWater, "HOME": ModeHome,
}

func (m *OperationMode) UnmarshalJSON(b []byte) error {
	v, err := unmarshalEnumJSON(b, operationModeNames, "OperationMode")
	if err != nil {
		return err
	}
	*m = OperationMode(v)
	return nil
}

// operationModeCanonicalNames is operationModeNames reversed — the
// value->name lookup NormalizeOperationMode needs.
var operationModeCanonicalNames = func() map[OperationMode]string {
	out := make(map[OperationMode]string, len(operationModeNames))
	for name, v := range operationModeNames {
		out[v] = name
	}
	return out
}()

// NormalizeOperationMode ports lib/gaggiuino-proto.js's
// normalizeOperationMode(raw): SystemStateDto.operationMode arrives as a
// numeric wire value from a WS d_sys_state push but as the enum's string
// name (e.g. "BREW_AUTO") from an MQTT <prefix>/system payload. Both
// transports decode into this typed OperationMode before reaching a caller
// here (the WS decoder maps the varint directly; the MQTT port's JSON
// decode goes through UnmarshalJSON above, which accepts either form), so
// this only has to turn the reconciled value into its canonical wire-enum
// name. Returns "" for an unrecognized value — the Go equivalent of Node
// returning null, including the no-live-transport case where a caller has
// no SystemStateDto to pass at all.
func NormalizeOperationMode(m OperationMode) string {
	return operationModeCanonicalNames[m]
}

// ServiceTestPeripheral ports ServiceTestPeripheralDto.
type ServiceTestPeripheral int32

const (
	PeripheralPump   ServiceTestPeripheral = 0
	PeripheralValve  ServiceTestPeripheral = 1
	PeripheralValveB ServiceTestPeripheral = 2
	PeripheralLED    ServiceTestPeripheral = 3
)

var serviceTestPeripheralNames = map[string]ServiceTestPeripheral{
	"PUMP": PeripheralPump, "VALVE": PeripheralValve, "VALVE_B": PeripheralValveB, "LED": PeripheralLED,
}

func (p *ServiceTestPeripheral) UnmarshalJSON(b []byte) error {
	v, err := unmarshalEnumJSON(b, serviceTestPeripheralNames, "ServiceTestPeripheral")
	if err != nil {
		return err
	}
	*p = ServiceTestPeripheral(v)
	return nil
}

// NotificationType ports NotificationTypeDto — decode-only (a d_notif
// field), see WebSocketResponseResult's comment above.
type NotificationType int32

const (
	NotificationInfo    NotificationType = 0
	NotificationSuccess NotificationType = 1
	NotificationWarn    NotificationType = 2
	NotificationError   NotificationType = 3
)

var notificationTypeNames = map[string]NotificationType{
	"INFO": NotificationInfo, "SUCCESS": NotificationSuccess, "WARN": NotificationWarn, "ERROR": NotificationError,
}

func (t *NotificationType) UnmarshalJSON(b []byte) error {
	v, err := unmarshalEnumJSON(b, notificationTypeNames, "NotificationType")
	if err != nil {
		return err
	}
	*t = NotificationType(v)
	return nil
}

// unmarshalEnumJSON is the shared body of every enum's UnmarshalJSON above:
// try a JSON string first (looked up in names), fall back to a JSON number
// (used as the raw wire value directly, no range check — matching
// gaggiuino-ws-client.js's own untyped passthrough for a numeric enum
// input).
func unmarshalEnumJSON[E ~int32](b []byte, names map[string]E, typeName string) (E, error) {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		v, ok := names[s]
		if !ok {
			return 0, fmt.Errorf("proto: unknown %s name %q", typeName, s)
		}
		return v, nil
	}
	var n int32
	if err := json.Unmarshal(b, &n); err != nil {
		return 0, fmt.Errorf("proto: %s must be a name string or a number: %w", typeName, err)
	}
	return E(n), nil
}
