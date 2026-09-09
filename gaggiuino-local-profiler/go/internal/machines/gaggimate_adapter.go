package machines

import (
	"context"
	"encoding/json"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// GaggiMateAdapter ports lib/machines/gaggimate/adapter.js. Experimental,
// same as Node: no real device was available to verify against in this
// environment either (see doc.go) — built strictly from the protocol
// description ws-client.js/profiles.js document. Live status, profile
// read/select, and full profile create/update/delete are all supported —
// GaggiMate profiles live only on the machine itself (no local copy in
// GLP's DB), so create/update/delete forward straight to req:profiles:save/
// delete over the live WS connection (gaggimate_profiles.go). Capabilities().
// ProfileEdit is true; requireProfileEditSupport (handlers.go) still gates
// every write route on it, same check as for Gaggiuino.
type GaggiMateAdapter struct {
	// live is the persistent evt:status cache (#952). GetStatus reads it
	// instead of opening a fresh WebSocket per call — the live-poll loop
	// calls GetStatus once a second, and short-lived-connection-per-tick
	// was PR #947's "GaggiMate WS hammer". Falls back to a one-shot
	// gaggimateWaitForStatus when the cache has no fresh frame yet.
	//
	// Profile requests (req:profiles:*) are also routed through live.Request
	// so they reuse the single open connection — GaggiMate's firmware only
	// accepts one concurrent WS client, and opening a second dial for profile
	// fetches would fail immediately.
	live *gaggiMateLiveClient
}

func NewGaggiMateAdapter(live *gaggiMateLiveClient) *GaggiMateAdapter {
	return &GaggiMateAdapter{live: live}
}

var _ Adapter = (*GaggiMateAdapter)(nil)

func (a *GaggiMateAdapter) GetStatus(ctx context.Context, m *Machine) (Status, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return Status{}, err
	}
	var evt map[string]any
	var ok bool
	if a.live != nil {
		evt, ok = a.live.Status(baseURL)
	}
	if !ok {
		// No fresh cached frame yet (session still warming up, or the
		// machine just went unreachable) — one short-lived wait, exactly
		// like the pre-#952 behaviour.
		evt, err = gaggimateWaitForStatus(ctx, baseURL, 5*time.Second)
		if err != nil {
			return Status{}, err
		}
	}
	raw, _ := json.Marshal(evt)

	// m==1 (BREW mode) means "brew screen selected", not "pump running".
	// Actual brewing requires process.a==1 AND process.s in ("brew","infusion").
	// Steaming: process.a==1 AND m==2. Source: ha-integration sensor.py _get_status.
	var isBrewing, isSteaming bool
	if process, ok := evt["process"].(map[string]any); ok {
		if looseFloat(process["a"]) == 1 {
			stage, _ := process["s"].(string)
			isBrewing = stage == "brew" || stage == "infusion"
			isSteaming = looseFloat(evt["m"]) == 2
		}
	}
	steamOn := isSteaming

	// Weight: cw (filtered scale weight) only when bc (BLE scale connected) is true.
	var weight *float64
	if looseTruthy(evt["bc"]) {
		weight = looseFloatOrNil(evt["cw"])
	}

	profileName := looseStringPtr(evt["p"])
	return Status{
		Reachable:         true,
		Temperature:       looseFloat(evt["ct"]),
		TargetTemperature: looseFloat(evt["tt"]),
		Pressure:          looseFloat(evt["pr"]),
		Weight:            weight,
		Brewing:           isBrewing,
		SteamOn:           &steamOn,
		ProfileID:         nil,
		ProfileName:       profileName,
		PumpFlow:          looseFloatOrNil(evt["fl"]),
		Raw:               raw,
	}, nil
}

// Shot-history sync (index.bin/.slog binary parsing) lives in
// gaggimate_history.go and is called from system/sync.go's
// syncGaggiMateShots — not through the Adapter interface, which has no
// GetShot/GetLatestShotId methods.

func (a *GaggiMateAdapter) ListProfiles(ctx context.Context, m *Machine) ([]ProfileSummary, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	if a.live != nil {
		res, err := a.live.Request(ctx, baseURL, "req:profiles:list", nil)
		if err != nil {
			return nil, err
		}
		return gaggimateParseProfileList(res)
	}
	return gaggimateListProfiles(ctx, baseURL)
}

func (a *GaggiMateAdapter) GetProfile(ctx context.Context, m *Machine, id string) (json.RawMessage, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	if a.live != nil {
		res, err := a.live.Request(ctx, baseURL, "req:profiles:load", map[string]any{"id": id})
		if err != nil {
			return nil, err
		}
		return gaggimateParseProfile(res)
	}
	return gaggimateLoadProfile(ctx, baseURL, id)
}

// CreateProfile/UpdateProfile forward profile.RawBody (the raw request JSON
// set by handlers_profiles.go for GaggiMate requests) straight through to
// req:profiles:save — GaggiMate's save is idempotent (same message for
// create and update; id presence in the body controls which). The Adapter
// interface's ProfileInput is only used for Gaggiuino; GaggiMate has its
// own JSON profile shape (phases[], type, etc.) that must not be converted.
func (a *GaggiMateAdapter) CreateProfile(ctx context.Context, m *Machine, profile ProfileInput) (ProfileSummary, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return ProfileSummary{}, err
	}
	if a.live != nil {
		var decoded any
		if err := json.Unmarshal(profile.RawBody, &decoded); err != nil {
			return ProfileSummary{}, err
		}
		res, err := a.live.Request(ctx, baseURL, "req:profiles:save", map[string]any{"profile": decoded})
		if err != nil {
			return ProfileSummary{}, err
		}
		return gaggimateParseProfileSave(res)
	}
	return gaggimateSaveProfile(ctx, baseURL, profile.RawBody)
}

func (a *GaggiMateAdapter) UpdateProfile(ctx context.Context, m *Machine, profile ProfileInput) (ProfileSummary, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return ProfileSummary{}, err
	}
	if a.live != nil {
		var decoded any
		if err := json.Unmarshal(profile.RawBody, &decoded); err != nil {
			return ProfileSummary{}, err
		}
		res, err := a.live.Request(ctx, baseURL, "req:profiles:save", map[string]any{"profile": decoded})
		if err != nil {
			return ProfileSummary{}, err
		}
		return gaggimateParseProfileSave(res)
	}
	return gaggimateSaveProfile(ctx, baseURL, profile.RawBody)
}

func (a *GaggiMateAdapter) DeleteProfile(ctx context.Context, m *Machine, id string) ([]ProfileSummary, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	if a.live != nil {
		if _, err := a.live.Request(ctx, baseURL, "req:profiles:delete", map[string]any{"id": id}); err != nil {
			return nil, err
		}
		res, err := a.live.Request(ctx, baseURL, "req:profiles:list", nil)
		if err != nil {
			return nil, err
		}
		return gaggimateParseProfileList(res)
	}
	if err := gaggimateDeleteProfile(ctx, baseURL, id); err != nil {
		return nil, err
	}
	return gaggimateListProfiles(ctx, baseURL)
}

func (a *GaggiMateAdapter) SelectProfile(ctx context.Context, m *Machine, id string) error {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return err
	}
	if a.live != nil {
		_, err := a.live.Request(ctx, baseURL, "req:profiles:select", map[string]any{"id": id})
		return err
	}
	return gaggimateSelectProfile(ctx, baseURL, id)
}

func (a *GaggiMateAdapter) Capabilities() Capabilities {
	return Capabilities{
		ProfileEdit:   true,
		BrewStart:     false, // GaggiMate has no start/stop API at all
		Preheat:       nil,   // not modeled yet — unknown until verified against hardware
		Volumetric:    nil,   // determined per-shot from slog systemInfo.volumetricCapable, not a static capability
		History:       true,
		SettingsProxy: false,
	}
}

// ── #597 settings/control proxy: unsupported for GaggiMate (no exports in
// lib/machines/gaggimate/adapter.js at all) — every method below only
// exists to satisfy the Adapter interface; Capabilities().SettingsProxy
// == false means handlers.go's requireSettingsProxySupport 501s every
// caller before any of these could ever run. ───────────────────────────

func (a *GaggiMateAdapter) GetSettings(ctx context.Context, m *Machine, category string) (json.RawMessage, error) {
	return nil, errSettingsProxyUnsupported
}
func (a *GaggiMateAdapter) UpdateSettings(ctx context.Context, m *Machine, category string, payload json.RawMessage) (json.RawMessage, error) {
	return nil, errSettingsProxyUnsupported
}
func (a *GaggiMateAdapter) SaveSettings(ctx context.Context, m *Machine) error {
	return errSettingsProxyUnsupported
}
func (a *GaggiMateAdapter) SetOperationMode(ctx context.Context, m *Machine, mode proto.OperationMode) error {
	return errSettingsProxyUnsupported
}
func (a *GaggiMateAdapter) Tare(ctx context.Context, m *Machine) error {
	return errSettingsProxyUnsupported
}
func (a *GaggiMateAdapter) ServiceTest(ctx context.Context, m *Machine, peripheral proto.ServiceTestPeripheral) error {
	return errSettingsProxyUnsupported
}
func (a *GaggiMateAdapter) SaveActiveProfile(ctx context.Context, m *Machine) error {
	return errSettingsProxyUnsupported
}
func (a *GaggiMateAdapter) GetFirmwareProgress(ctx context.Context, m *Machine) (json.RawMessage, error) {
	return nil, errSettingsProxyUnsupported
}
func (a *GaggiMateAdapter) TriggerFirmwareUpdate(ctx context.Context, m *Machine) (json.RawMessage, error) {
	return nil, errSettingsProxyUnsupported
}
func (a *GaggiMateAdapter) GetLiveSensorSnapshot(ctx context.Context, m *Machine) (*proto.SensorStateSnapshotDto, error) {
	return nil, nil
}
func (a *GaggiMateAdapter) GetLiveSystemState(ctx context.Context, m *Machine) (*proto.SystemStateDto, error) {
	return nil, nil
}
