package machines

import (
	"context"
	"testing"
)

func testGaggiMateMachine(host string) *Machine {
	return &Machine{ID: 2, Name: "GaggiMate", Type: "gaggimate", Host: host, Enabled: true}
}

func TestGaggiMateAdapter_GetStatus(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeGaggiMateMachine()
	defer fake.Close()
	a := newTestGaggiMateAdapter(t)

	status, err := a.GetStatus(context.Background(), testGaggiMateMachine(fake.URL))
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if !status.Reachable || status.Temperature != 92.5 || !status.Brewing {
		t.Fatalf("unexpected status: %+v", status)
	}
	if status.Weight != nil {
		t.Errorf("Weight = %v, want nil (evt:status carries no weight field)", status.Weight)
	}
	if status.ProfileName == nil || *status.ProfileName != "Espresso" {
		t.Errorf("ProfileName = %v, want \"Espresso\"", status.ProfileName)
	}
}

func TestGaggiMateAdapter_ProfileListLoadSelect(t *testing.T) {
	allowLoopbackMachineHost(t)
	fake := newFakeGaggiMateMachine()
	fake.profiles = []map[string]any{{"id": "1", "label": "Espresso", "name": "Espresso"}}
	defer fake.Close()
	a := newTestGaggiMateAdapter(t)
	m := testGaggiMateMachine(fake.URL)
	ctx := context.Background()

	list, err := a.ListProfiles(ctx, m)
	if err != nil {
		t.Fatalf("ListProfiles: %v", err)
	}
	if len(list) != 1 || list[0].Name != "Espresso" {
		t.Fatalf("unexpected profile list: %+v", list)
	}

	raw, err := a.GetProfile(ctx, m, "1")
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if !jsonContains(string(raw), `"name":"Espresso"`) {
		t.Fatalf("unexpected profile detail: %s", raw)
	}

	if err := a.SelectProfile(ctx, m, "1"); err != nil {
		t.Fatalf("SelectProfile: %v", err)
	}
}

// GaggiMate's capabilities gate the settings/control proxy off entirely but
// allow full profile editing (create/update/delete forward to the machine's
// own req:profiles:save/delete over WS, see gaggimate_adapter.go's doc
// comment) — verifies the capability flags handlers.go checks before ever
// calling the corresponding adapter methods.
func TestGaggiMateAdapter_Capabilities(t *testing.T) {
	caps := newTestGaggiMateAdapter(t).Capabilities()
	if !caps.ProfileEdit {
		t.Error("GaggiMate Capabilities().ProfileEdit = false, want true (profile CRUD forwards to the machine)")
	}
	if caps.SettingsProxy {
		t.Error("GaggiMate Capabilities().SettingsProxy = true, want false")
	}
	if caps.BrewStart {
		t.Error("GaggiMate Capabilities().BrewStart = true, want false")
	}
}

func TestGaggiMateAdapter_SettingsProxyUnsupported(t *testing.T) {
	a := newTestGaggiMateAdapter(t)
	m := testGaggiMateMachine("gaggimate.local")
	ctx := context.Background()

	if _, err := a.GetSettings(ctx, m, "boiler"); err == nil {
		t.Error("expected GetSettings to error for GaggiMate")
	}
	if err := a.Tare(ctx, m); err == nil {
		t.Error("expected Tare to error for GaggiMate")
	}
	if snap, err := a.GetLiveSensorSnapshot(ctx, m); snap != nil || err != nil {
		t.Errorf("expected GetLiveSensorSnapshot to be (nil, nil) for GaggiMate, got (%v, %v)", snap, err)
	}
}
