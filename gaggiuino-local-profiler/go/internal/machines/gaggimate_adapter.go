package machines

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// GaggiMateAdapter ports lib/machines/gaggimate/adapter.js. Experimental,
// same as Node: no real device was available to verify against in this
// environment either (see doc.go) — built strictly from the protocol
// description ws-client.js/profiles.js document. Live status and profile
// read/select are supported; profile create/update/delete are exposed
// through the Adapter interface (gaggimate_profiles.go's pass-throughs
// exist) but are unreachable from any REST route in this phase's scope —
// Capabilities().ProfileEdit is false, and every route that writes a
// profile checks that first (requireProfileEditSupport's Go port, see
// handlers.go) — matching capabilities()'s comment in the Node original
// that this is a deliberate v1 UI-level gate, not a protocol limitation.
type GaggiMateAdapter struct {
	// live is the persistent evt:status cache (#952). GetStatus reads it
	// instead of opening a fresh WebSocket per call — the live-poll loop
	// calls GetStatus once a second, and short-lived-connection-per-tick
	// was PR #947's "GaggiMate WS hammer". Falls back to a one-shot
	// gaggimateWaitForStatus when the cache has no fresh frame yet.
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
	return gaggimateListProfiles(ctx, baseURL)
}

func (a *GaggiMateAdapter) GetProfile(ctx context.Context, m *Machine, id int) (json.RawMessage, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	return gaggimateLoadProfile(ctx, baseURL, id)
}

// CreateProfile/UpdateProfile take the same Adapter-interface ProfileInput
// shape the Gaggiuino adapter uses, which doesn't correspond to
// GaggiMate's own arbitrary profile JSON (profiles.js's saveProfile passes
// a profile straight through, untyped) — moot in practice since
// Capabilities().ProfileEdit gates both off before any route reaches here
// (see this file's header comment), so these simply report the same
// "not supported" condition the capability gate already communicates.
func (a *GaggiMateAdapter) CreateProfile(ctx context.Context, m *Machine, profile ProfileInput) (ProfileSummary, error) {
	return ProfileSummary{}, fmt.Errorf("gaggimate machines do not support remote profile editing yet")
}

func (a *GaggiMateAdapter) UpdateProfile(ctx context.Context, m *Machine, profile ProfileInput) (ProfileSummary, error) {
	return ProfileSummary{}, fmt.Errorf("gaggimate machines do not support remote profile editing yet")
}

func (a *GaggiMateAdapter) DeleteProfile(ctx context.Context, m *Machine, id int) ([]ProfileSummary, error) {
	return nil, fmt.Errorf("gaggimate machines do not support remote profile editing yet")
}

func (a *GaggiMateAdapter) SelectProfile(ctx context.Context, m *Machine, id int) error {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return err
	}
	return gaggimateSelectProfile(ctx, baseURL, id)
}

func (a *GaggiMateAdapter) Capabilities() Capabilities {
	return Capabilities{
		ProfileEdit:   false, // protocol supports it (req:profiles:save/delete); UI-gated off, same as Node
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
