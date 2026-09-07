package machines

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// GaggiuinoAdapter ports lib/machines/gaggiuino/adapter.js: REST calls
// (net/http, mirroring the Node original's axios calls) for status/shot-
// history/profile-list/settings/firmware, plus ws.go's WebSocket client
// for the machine capabilities that have no REST equivalent (profile
// update/delete, opmode/tare/service-test/save-settings/save-active-
// profile), plus live.go's persistent live-cache reads.
type GaggiuinoAdapter struct {
	live *gaggiuinoLiveClient
}

func NewGaggiuinoAdapter(live *gaggiuinoLiveClient) *GaggiuinoAdapter {
	return &GaggiuinoAdapter{live: live}
}

var _ Adapter = (*GaggiuinoAdapter)(nil)

func (a *GaggiuinoAdapter) GetStatus(ctx context.Context, m *Machine) (Status, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return Status{}, err
	}
	raw, err := httpGetBytes(ctx, baseURL+"/api/system/status", 3*time.Second)
	if err != nil {
		return Status{}, err
	}

	var obj map[string]any
	var arr []map[string]any
	if err := json.Unmarshal(raw, &arr); err == nil && len(arr) > 0 {
		obj = arr[0]
	} else if err := json.Unmarshal(raw, &obj); err != nil {
		return Status{}, fmt.Errorf("decoding machine status: %w", err)
	}

	weight := looseFloat(obj["weight"])
	steamOn := looseTruthy(obj["steamSwitchState"])
	return Status{
		Reachable:         true,
		Temperature:       looseFloat(obj["temperature"]),
		TargetTemperature: looseFloat(obj["targetTemperature"]),
		Pressure:          looseFloat(obj["pressure"]),
		Weight:            &weight,
		Brewing:           looseTruthy(obj["brewSwitchState"]),
		SteamOn:           &steamOn,
		ProfileID:         looseIntPtr(obj["profileId"]),
		ProfileName:       looseStringPtr(obj["profileName"]),
		Raw:               json.RawMessage(raw),
	}, nil
}

func (a *GaggiuinoAdapter) ListProfiles(ctx context.Context, m *Machine) ([]ProfileSummary, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	raw, err := httpGetBytes(ctx, baseURL+"/api/profiles/all", 5*time.Second)
	if err != nil {
		return nil, err
	}
	var profiles []ProfileSummary
	if err := json.Unmarshal(raw, &profiles); err != nil {
		return []ProfileSummary{}, nil // matches `Array.isArray(r.data) ? r.data : []`
	}
	return profiles, nil
}

// GetProfile ports getProfile(machine, id): try newer firmware's REST
// GET /api/profile/{id} first (cheaper — one HTTP request vs a WS
// handshake), fall back to the WebSocket path on any failure, the known-
// working baseline for every firmware version.
func (a *GaggiuinoAdapter) GetProfile(ctx context.Context, m *Machine, id string) (json.RawMessage, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	u64, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("invalid Gaggiuino profile id %q: expected non-negative integer", id)
	}
	if raw, err := httpGetBytes(ctx, fmt.Sprintf("%s/api/profile/%s", baseURL, id), 5*time.Second); err == nil {
		return json.RawMessage(raw), nil
	}
	profile, err := wsGetProfileByID(ctx, baseURL, uint32(u64))
	if err != nil {
		return nil, err
	}
	return json.Marshal(profile)
}

// CreateProfile ports createProfile(machine, profile): same try-REST-
// first/fall-back-to-WS pattern as GetProfile — newer firmware's
// POST /api/profile is create-only (an id in the body is ignored, #580).
func (a *GaggiuinoAdapter) CreateProfile(ctx context.Context, m *Machine, profile ProfileInput) (ProfileSummary, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return ProfileSummary{}, err
	}
	body, err := json.Marshal(profile)
	if err == nil {
		if raw, err := httpPostBytes(ctx, baseURL+"/api/profile", body, 5*time.Second); err == nil {
			var created ProfileSummary
			if err := json.Unmarshal(raw, &created); err == nil {
				return created, nil
			}
		}
	}
	saved, err := wsCreateProfile(ctx, baseURL, profile)
	if err != nil {
		return ProfileSummary{}, err
	}
	return ProfileSummary{ID: strconv.Itoa(int(saved.ID)), Name: saved.Name}, nil
}

// UpdateProfile ports updateProfile(machine, profile) — WebSocket-only
// (#580 live-verified there is no REST update equivalent).
func (a *GaggiuinoAdapter) UpdateProfile(ctx context.Context, m *Machine, profile ProfileInput) (ProfileSummary, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return ProfileSummary{}, err
	}
	saved, err := wsUpdateProfile(ctx, baseURL, profile)
	if err != nil {
		return ProfileSummary{}, err
	}
	return ProfileSummary{ID: strconv.Itoa(int(saved.ID)), Name: saved.Name}, nil
}

// DeleteProfile ports deleteProfile(machine, id) — WebSocket-only.
func (a *GaggiuinoAdapter) DeleteProfile(ctx context.Context, m *Machine, id string) ([]ProfileSummary, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	u64, _ := strconv.ParseUint(id, 10, 32)
	remaining, err := wsDeleteProfile(ctx, baseURL, uint32(u64))
	if err != nil {
		return nil, err
	}
	out := make([]ProfileSummary, len(remaining))
	for i, p := range remaining {
		out[i] = ProfileSummary{ID: strconv.Itoa(int(p.ID)), Name: p.Name}
	}
	return out, nil
}

func (a *GaggiuinoAdapter) SelectProfile(ctx context.Context, m *Machine, id string) error {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return err
	}
	_, err = httpPostBytes(ctx, fmt.Sprintf("%s/api/profile-select/%s", baseURL, id), nil, 5*time.Second)
	return err
}

func (a *GaggiuinoAdapter) Capabilities() Capabilities {
	t := true
	return Capabilities{
		ProfileEdit: true, BrewStart: false, Preheat: &t, Volumetric: &t, History: true,
		NativeMaintenanceLog: true, SettingsProxy: true,
	}
}

// ── #597 settings/control proxy ─────────────────────────────────────────

// GetSettings ports getSettings(machine, category): category "" (the
// caller's `category == nil` case) reads the all-categories endpoint.
func (a *GaggiuinoAdapter) GetSettings(ctx context.Context, m *Machine, category string) (json.RawMessage, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	path := "/api/settings"
	if category != "" {
		path = "/api/settings/" + category
	}
	raw, err := httpGetBytes(ctx, baseURL+path, 5*time.Second)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// UpdateSettings ports updateSettings(machine, category, payload): the
// exact request body bytes handlers.go read off the client request are
// forwarded unmodified — see http.go's httpPostBytes doc comment for why
// (the bool-as-string settings quirk, doc.go).
func (a *GaggiuinoAdapter) UpdateSettings(ctx context.Context, m *Machine, category string, payload json.RawMessage) (json.RawMessage, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	raw, err := httpPostBytes(ctx, baseURL+"/api/settings/"+category, payload, 5*time.Second)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

func (a *GaggiuinoAdapter) SaveSettings(ctx context.Context, m *Machine) error {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return err
	}
	return wsSaveSettings(ctx, baseURL)
}

func (a *GaggiuinoAdapter) SetOperationMode(ctx context.Context, m *Machine, mode proto.OperationMode) error {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return err
	}
	return wsSetOperationMode(ctx, baseURL, mode)
}

func (a *GaggiuinoAdapter) Tare(ctx context.Context, m *Machine) error {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return err
	}
	return wsTare(ctx, baseURL)
}

func (a *GaggiuinoAdapter) ServiceTest(ctx context.Context, m *Machine, peripheral proto.ServiceTestPeripheral) error {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return err
	}
	_, err = wsServiceTest(ctx, baseURL, peripheral)
	return err
}

func (a *GaggiuinoAdapter) SaveActiveProfile(ctx context.Context, m *Machine) error {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return err
	}
	return wsSaveActiveProfile(ctx, baseURL)
}

func (a *GaggiuinoAdapter) GetFirmwareProgress(ctx context.Context, m *Machine) (json.RawMessage, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	raw, err := httpGetBytes(ctx, baseURL+"/api/firmware/progress", 5*time.Second)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

func (a *GaggiuinoAdapter) TriggerFirmwareUpdate(ctx context.Context, m *Machine) (json.RawMessage, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	raw, err := httpPostBytes(ctx, baseURL+"/api/firmware/update-all", nil, 5*time.Second)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

// GetLiveSensorSnapshot/GetLiveSystemState port the adapter's synchronous
// cache reads (see live.go — no I/O happens directly here, same as the
// Node original's own header comment on these two methods). Like every
// other adapter method, the base URL goes through BaseURLFor — NOT the
// unguarded normalizeBaseURL — so these two live-cache reads run through
// the same SSRF check (assertMachineHost) as every outbound call this
// adapter makes; a machine record with a blocked host must be rejected
// here too, not just on its REST/WS control-plane methods (#901 code
// review — these two previously bypassed the guard entirely).
func (a *GaggiuinoAdapter) GetLiveSensorSnapshot(ctx context.Context, m *Machine) (*proto.SensorStateSnapshotDto, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	return a.live.GetLiveSensorSnapshot(baseURL), nil
}

func (a *GaggiuinoAdapter) GetLiveSystemState(ctx context.Context, m *Machine) (*proto.SystemStateDto, error) {
	baseURL, err := BaseURLFor(ctx, m)
	if err != nil {
		return nil, err
	}
	return a.live.GetLiveSystemState(baseURL), nil
}
