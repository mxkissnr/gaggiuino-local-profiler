package machines

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// fakePanicAdapter is a minimal machines.Adapter whose GetSettings panics —
// #994 code-review regression fixture: firmwareVersion's two concurrent
// GetSettings goroutines are wrapped in httputil.SafeCall, and a first cut
// of that wrapper only logged a recovered panic, leaving versionsErr/
// systemErr nil and letting the handler proceed as if the fetch had
// succeeded. Only GetSettings/Capabilities are ever called by
// firmwareVersion; every other method panics if that ever changes.
type fakePanicAdapter struct{}

var _ Adapter = fakePanicAdapter{}

func (fakePanicAdapter) Capabilities() Capabilities { return Capabilities{SettingsProxy: true} }

func (fakePanicAdapter) GetSettings(ctx context.Context, m *Machine, category string) (json.RawMessage, error) {
	panic("fakePanicAdapter: simulated panic fetching " + category)
}

func (fakePanicAdapter) notImplemented(name string) error {
	panic("fakePanicAdapter: unexpected call to " + name)
}

func (f fakePanicAdapter) GetStatus(context.Context, *Machine) (Status, error) {
	return Status{}, f.notImplemented("GetStatus")
}
func (f fakePanicAdapter) ListProfiles(context.Context, *Machine) ([]ProfileSummary, error) {
	return nil, f.notImplemented("ListProfiles")
}
func (f fakePanicAdapter) GetProfile(context.Context, *Machine, string) (json.RawMessage, error) {
	return nil, f.notImplemented("GetProfile")
}
func (f fakePanicAdapter) CreateProfile(context.Context, *Machine, ProfileInput) (ProfileSummary, error) {
	return ProfileSummary{}, f.notImplemented("CreateProfile")
}
func (f fakePanicAdapter) UpdateProfile(context.Context, *Machine, ProfileInput) (ProfileSummary, error) {
	return ProfileSummary{}, f.notImplemented("UpdateProfile")
}
func (f fakePanicAdapter) DeleteProfile(context.Context, *Machine, string) ([]ProfileSummary, error) {
	return nil, f.notImplemented("DeleteProfile")
}
func (f fakePanicAdapter) SelectProfile(context.Context, *Machine, string) error {
	return f.notImplemented("SelectProfile")
}
func (fakePanicAdapter) UpdateSettings(context.Context, *Machine, string, json.RawMessage) (json.RawMessage, error) {
	return nil, nil
}
func (f fakePanicAdapter) SaveSettings(context.Context, *Machine) error {
	return f.notImplemented("SaveSettings")
}
func (f fakePanicAdapter) SetOperationMode(context.Context, *Machine, proto.OperationMode) error {
	return f.notImplemented("SetOperationMode")
}
func (f fakePanicAdapter) Tare(context.Context, *Machine) error {
	return f.notImplemented("Tare")
}
func (f fakePanicAdapter) ServiceTest(context.Context, *Machine, proto.ServiceTestPeripheral) error {
	return f.notImplemented("ServiceTest")
}
func (f fakePanicAdapter) SaveActiveProfile(context.Context, *Machine) error {
	return f.notImplemented("SaveActiveProfile")
}
func (f fakePanicAdapter) GetFirmwareProgress(context.Context, *Machine) (json.RawMessage, error) {
	return nil, f.notImplemented("GetFirmwareProgress")
}
func (f fakePanicAdapter) TriggerFirmwareUpdate(context.Context, *Machine) (json.RawMessage, error) {
	return nil, f.notImplemented("TriggerFirmwareUpdate")
}
func (f fakePanicAdapter) GetLiveSensorSnapshot(context.Context, *Machine) (*proto.SensorStateSnapshotDto, error) {
	return nil, f.notImplemented("GetLiveSensorSnapshot")
}
func (f fakePanicAdapter) GetLiveSystemState(context.Context, *Machine) (*proto.SystemStateDto, error) {
	return nil, f.notImplemented("GetLiveSystemState")
}

// TestFirmwareVersion_PanicDuringSettingsFetchReturns502 is #994's
// regression test: a panic inside one of the two concurrent GetSettings
// goroutines must surface as the same 502 the handler already returns for
// an ordinary GetSettings error -- not a 200 built from zero-value/nil
// data as if the fetch had quietly succeeded.
func TestFirmwareVersion_PanicDuringSettingsFetchReturns502(t *testing.T) {
	registry, _ := newTestRegistry(t)
	h := &Handlers{registry: registry, gaggiuino: fakePanicAdapter{}, profilesCache: newProfilesCache()}
	mux := newMux(h)

	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Fake"), Type: strPtr("gaggiuino"), Host: strPtr("http://192.0.2.1"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/machine/firmware/version?machineId="+strconv.FormatInt(machine.ID, 10), nil)
	rec := doRequest(mux, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("GET firmware/version status = %d, body = %s, want %d (a recovered panic must not read as success)", rec.Code, rec.Body, http.StatusBadGateway)
	}
}
