package machines

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// This file ports lib/machines/adapter-base.js's documented interface (the
// method contract every machine-type adapter implements) as a real Go
// interface, plus lib/machines/index.js's getAdapter() dispatch.

// Status ports adapter-base.js's getStatus(machine) return shape.
// TargetTemperature/Weight/SteamOn/ProfileID/ProfileName are pointers
// because the GaggiMate adapter reports several as null (evt:status has no
// weight field at all, no profile id, etc. — see gaggimate_adapter.go).
type Status struct {
	Reachable         bool            `json:"reachable"`
	Temperature       float64         `json:"temperature"`
	TargetTemperature float64         `json:"targetTemperature"`
	Pressure          float64         `json:"pressure"`
	Weight            *float64        `json:"weight"`
	Brewing           bool            `json:"brewing"`
	SteamOn           *bool           `json:"steamOn"`
	ProfileID         *int            `json:"profileId"`
	ProfileName       *string         `json:"profileName"`
	PumpFlow          *float64        `json:"pumpFlow,omitempty"`
	Raw               json.RawMessage `json:"raw"`
}

// ProfileSummary ports the {id, name} shape SavedProfileDto and the
// machine's own REST profile-list endpoints both use.
// ID is a string to accommodate both Gaggiuino (integer IDs like "5") and
// GaggiMate (string IDs like "lever", "adapt"). The custom UnmarshalJSON
// below accepts both JSON number and JSON string values.
type ProfileSummary struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Utility bool   `json:"utility"` // GaggiMate-only (e.g. backflush) — always false for Gaggiuino
}

func (p *ProfileSummary) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID      json.RawMessage `json:"id"`
		Name    string          `json:"name"`
		Utility bool            `json:"utility"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	p.Name = raw.Name
	p.Utility = raw.Utility
	p.ID = jsonRawToProfileID(json.RawMessage(strings.TrimSpace(string(raw.ID))))
	return nil
}

// jsonRawToProfileID converts a raw JSON value (number or string) to a plain
// string profile ID. Gaggiuino sends integer IDs like 5; GaggiMate sends
// string IDs like "lever".
func jsonRawToProfileID(raw json.RawMessage) string {
	s := string(raw)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		return s[1 : len(s)-1]
	}
	return s
}

// Capabilities ports adapter-base.js's capabilities() return shape.
// Preheat/Volumetric are pointers since GaggiMate reports them as an
// explicit `null` ("not modeled yet" / "determined per-shot", not simply
// false) — see gaggimate_adapter.go's capabilities().
type Capabilities struct {
	ProfileEdit          bool  `json:"profileEdit"`
	BrewStart            bool  `json:"brewStart"`
	Preheat              *bool `json:"preheat"`
	Volumetric           *bool `json:"volumetric"`
	History              bool  `json:"history"`
	NativeMaintenanceLog bool  `json:"nativeMaintenanceLog,omitempty"`
	SettingsProxy        bool  `json:"settingsProxy,omitempty"`
}

// Adapter is the Go port of adapter-base.js's documented per-machine-type
// contract, extended with the #597 settings/control-proxy methods
// (getSettings/updateSettings/saveSettings/setOperationMode/tare/
// serviceTest/saveActiveProfile/getFirmwareProgress/triggerFirmwareUpdate/
// getLiveSensorSnapshot/getLiveSystemState) lib/machines/gaggiuino/adapter.js
// and lib/machines/gaggimate/adapter.js both also export, gated by
// Capabilities().SettingsProxy the same way routes/machine-control.js's
// requireSettingsProxySupport() gates them in Node — GaggiMate's
// implementation of every settings-proxy method below simply returns an
// error, since capability-gated handlers never call them, matching that
// adapter's own missing exports in Node (it never defines them at all).
type Adapter interface {
	GetStatus(ctx context.Context, m *Machine) (Status, error)
	ListProfiles(ctx context.Context, m *Machine) ([]ProfileSummary, error)
	GetProfile(ctx context.Context, m *Machine, id string) (json.RawMessage, error)
	CreateProfile(ctx context.Context, m *Machine, profile ProfileInput) (ProfileSummary, error)
	UpdateProfile(ctx context.Context, m *Machine, profile ProfileInput) (ProfileSummary, error)
	DeleteProfile(ctx context.Context, m *Machine, id string) ([]ProfileSummary, error)
	SelectProfile(ctx context.Context, m *Machine, id string) error
	Capabilities() Capabilities

	GetSettings(ctx context.Context, m *Machine, category string) (json.RawMessage, error)
	UpdateSettings(ctx context.Context, m *Machine, category string, payload json.RawMessage) (json.RawMessage, error)
	SaveSettings(ctx context.Context, m *Machine) error
	SetOperationMode(ctx context.Context, m *Machine, mode proto.OperationMode) error
	Tare(ctx context.Context, m *Machine) error
	ServiceTest(ctx context.Context, m *Machine, peripheral proto.ServiceTestPeripheral) error
	SaveActiveProfile(ctx context.Context, m *Machine) error
	GetFirmwareProgress(ctx context.Context, m *Machine) (json.RawMessage, error)
	TriggerFirmwareUpdate(ctx context.Context, m *Machine) (json.RawMessage, error)
	GetLiveSensorSnapshot(ctx context.Context, m *Machine) (*proto.SensorStateSnapshotDto, error)
	GetLiveSystemState(ctx context.Context, m *Machine) (*proto.SystemStateDto, error)
}

// GetAdapter ports lib/machines/index.js's getAdapter(machine).
func (h *Handlers) GetAdapter(m *Machine) (Adapter, error) {
	if m == nil || m.Type == "" {
		return nil, fmt.Errorf("getAdapter requires a machine record with a type")
	}
	switch m.Type {
	case "gaggiuino":
		return h.gaggiuino, nil
	case "gaggimate":
		return h.gaggimate, nil
	default:
		return nil, fmt.Errorf("unknown machine type: %s", m.Type)
	}
}

// errSettingsProxyUnsupported is what every GaggiMate settings-proxy method
// stub returns — never surfaced to a client directly since handlers.go
// checks Capabilities().SettingsProxy first (mirroring
// requireSettingsProxySupport's 501), but a defined error keeps the
// GaggiMate adapter's stubs from silently succeeding if that gate is ever
// bypassed by a future bug.
var errSettingsProxyUnsupported = fmt.Errorf("gaggimate machines do not support the settings/control proxy")
