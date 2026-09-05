package system

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

func ptrInt(v int) *int         { return &v }
func ptrStr(v string) *string   { return &v }
func ptrF64(v float64) *float64 { return &v }
func ptrI64(v int64) *int64     { return &v }
func ptrBool(v bool) *bool      { return &v }

func TestDeriveMachineState_RESTOnly_NoLiveSession(t *testing.T) {
	res := deriveMachineState(DeriveInput{
		Status: RawStatus{
			WaterLevel: ptrInt(80), UpTime: 1234, Brewing: false,
			Temperature: 93.5, TargetTemperature: 94, Pressure: 9.0, Weight: 0,
			ProfileID: ptrInt(1), ProfileName: ptrStr("Espresso"), SteamSwitchState: false,
		},
		Now: 1000,
	})

	if res.IsBrewing {
		t.Fatal("expected IsBrewing=false")
	}
	if res.ProfileName != "Espresso" {
		t.Errorf("ProfileName = %q, want Espresso", res.ProfileName)
	}
	ms := res.MachineStatus
	if ms.Temperature != 93.5 || ms.Pressure != 9.0 || ms.WaterLevel == nil || *ms.WaterLevel != 80 || ms.UpTime != 1234 {
		t.Errorf("unexpected base fields: %+v", ms)
	}
	if ms.UpdatedAt != 1000 {
		t.Errorf("UpdatedAt = %d, want 1000", ms.UpdatedAt)
	}
	// No live session -> every sensorSnap/sysState-sourced field must be
	// absent (nil), exactly like Node never assigning them outside the
	// `if (sensorSnap)`/`if (sysState)` blocks.
	if ms.PumpFlow != nil || ms.BoilerState != nil || ms.ThermocoupleFaulted != nil {
		t.Errorf("expected sensorSnap/sysState fields to be nil, got %+v", ms)
	}
}

func TestDeriveMachineState_ProfileNameFallsBackToUnknown(t *testing.T) {
	res := deriveMachineState(DeriveInput{Status: RawStatus{}, Now: 1})
	if res.ProfileName != "Unknown" {
		t.Errorf("ProfileName = %q, want Unknown", res.ProfileName)
	}
	if res.MachineStatus.ProfileName != nil {
		t.Errorf("MachineStatus.ProfileName should stay nil (Node's `status.profileName || null`), got %v", *res.MachineStatus.ProfileName)
	}
}

func TestDeriveMachineState_SensorSnapPreferredOverREST(t *testing.T) {
	res := deriveMachineState(DeriveInput{
		Status: RawStatus{Temperature: 10, Pressure: 1, Weight: 1, Brewing: true},
		Now:    1,
		SensorSnap: &proto.SensorStateSnapshotDto{
			Temperature: 93.2, Pressure: 8.8, Weight: 18.4, PumpFlow: 2.5,
			WeightFlow: 1.1, WaterTemperature: 95, BoilerState: true, ValveState: true,
			BrewActive: true,
		},
	})
	// #615/#902: brewing START stays REST-sourced; a live sample only ends
	// it (brewActive=false). With brewActive still true here, IsBrewing
	// tracks status.Brewing unchanged.
	if !res.IsBrewing {
		t.Fatal("expected IsBrewing=true (REST-sourced start, SensorSnap.BrewActive still true)")
	}
	ms := res.MachineStatus
	if ms.Temperature != 93.2 || ms.Pressure != 8.8 || ms.Weight != 18.4 {
		t.Errorf("expected SensorSnap values to win, got temp=%v pressure=%v weight=%v",
			ms.Temperature, ms.Pressure, ms.Weight)
	}
	if ms.PumpFlow == nil || *ms.PumpFlow != 2.5 {
		t.Errorf("MachineStatus.PumpFlow = %v, want 2.5", ms.PumpFlow)
	}
	if ms.BoilerState == nil || !*ms.BoilerState {
		t.Errorf("MachineStatus.BoilerState should be true")
	}
}

// #907: under BREW_AUTO the firmware auto-stops the brew while the physical
// switch stays up — a live SensorSnap.BrewActive=false must end the live
// brew immediately.
func TestDeriveMachineState_BrewAutoStop_LiveBrewActiveFalseEndsIt(t *testing.T) {
	res := deriveMachineState(DeriveInput{
		Status:     RawStatus{Brewing: true, Temperature: 92},
		Now:        1,
		SensorSnap: &proto.SensorStateSnapshotDto{Temperature: 92, BrewActive: false},
	})
	if res.IsBrewing {
		t.Fatal("expected IsBrewing=false: SensorSnap.BrewActive=false ends it even with brewSwitchState up")
	}
	if res.MachineStatus.BrewSwitchState {
		t.Error("MachineStatus.BrewSwitchState should follow IsBrewing (false)")
	}
}

func TestDeriveMachineState_BrewContinuesWhileBrewActiveTrue(t *testing.T) {
	res := deriveMachineState(DeriveInput{
		Status:     RawStatus{Brewing: true, Temperature: 92},
		Now:        1,
		SensorSnap: &proto.SensorStateSnapshotDto{Temperature: 92, BrewActive: true},
	})
	if !res.IsBrewing {
		t.Fatal("expected IsBrewing=true while brewSwitchState up and BrewActive still true")
	}
}

func TestDeriveMachineState_NoLiveTransport_BrewStaysRESTOnly(t *testing.T) {
	res := deriveMachineState(DeriveInput{Status: RawStatus{Brewing: true}, Now: 1})
	if !res.IsBrewing {
		t.Fatal("no SensorSnap -> pre-#907 REST-only behavior (switch alone decides)")
	}
}

// #908: steam/flush live-state derivation.
func TestDeriveMachineState_SteamState(t *testing.T) {
	// REST fallback: no live transport -> steamSwitchState decides.
	rest := deriveMachineState(DeriveInput{Status: RawStatus{SteamSwitchState: true}, Now: 1})
	if !rest.IsSteaming || !rest.MachineStatus.IsSteaming {
		t.Error("expected IsSteaming=true from REST steamSwitchState with no live transport")
	}
	if rest.MachineStatus.OpMode != nil {
		t.Errorf("OpMode should be nil with no SysState, got %q", *rest.MachineStatus.OpMode)
	}

	// Live transport preferred: SensorSnap.SteamActive wins over REST.
	live := deriveMachineState(DeriveInput{
		Status:     RawStatus{SteamSwitchState: true},
		Now:        1,
		SensorSnap: &proto.SensorStateSnapshotDto{SteamActive: false},
	})
	if live.IsSteaming || live.MachineStatus.IsSteaming {
		t.Error("expected IsSteaming=false: live SensorSnap.SteamActive=false overrides REST switch")
	}
}

func TestDeriveMachineState_FlushState(t *testing.T) {
	for _, mode := range []proto.OperationMode{proto.ModeFlush, proto.ModeFlushAuto} {
		res := deriveMachineState(DeriveInput{
			Status:   RawStatus{},
			Now:      1,
			SysState: &proto.SystemStateDto{OperationMode: mode},
		})
		if !res.IsFlushing || !res.MachineStatus.IsFlushing {
			t.Errorf("mode %d: expected IsFlushing=true", mode)
		}
		if res.MachineStatus.OpMode == nil {
			t.Errorf("mode %d: expected OpMode to be set", mode)
		}
	}

	notFlush := deriveMachineState(DeriveInput{
		Status:   RawStatus{},
		Now:      1,
		SysState: &proto.SystemStateDto{OperationMode: proto.ModeBrewAuto},
	})
	if notFlush.IsFlushing {
		t.Error("BREW_AUTO must not derive IsFlushing=true")
	}
	if notFlush.MachineStatus.OpMode == nil || *notFlush.MachineStatus.OpMode != "BREW_AUTO" {
		t.Errorf("OpMode = %v, want BREW_AUTO", notFlush.MachineStatus.OpMode)
	}
}

// #983: descale live-state derivation, same opMode-only shape as flush.
func TestDeriveMachineState_DescaleState(t *testing.T) {
	res := deriveMachineState(DeriveInput{
		Status:   RawStatus{},
		Now:      1,
		SysState: &proto.SystemStateDto{OperationMode: proto.ModeDescale},
	})
	if !res.IsDescaling || !res.MachineStatus.IsDescaling {
		t.Error("expected IsDescaling=true for ModeDescale")
	}
	if res.MachineStatus.OpMode == nil || *res.MachineStatus.OpMode != "DESCALE" {
		t.Errorf("OpMode = %v, want DESCALE", res.MachineStatus.OpMode)
	}

	notDescale := deriveMachineState(DeriveInput{
		Status:   RawStatus{},
		Now:      1,
		SysState: &proto.SystemStateDto{OperationMode: proto.ModeFlush},
	})
	if notDescale.IsDescaling {
		t.Error("FLUSH must not derive IsDescaling=true")
	}
}

func TestDeriveMachineState_SysStateAddsFaultFields(t *testing.T) {
	res := deriveMachineState(DeriveInput{
		Status: RawStatus{},
		Now:    1,
		SysState: &proto.SystemStateDto{
			ThermocoupleFaulted: true, ThermocoupleFaultReason: "open circuit",
			PressureSensorFaulted: false, PressureSensorFaultReason: "",
		},
	})
	ms := res.MachineStatus
	if ms.ThermocoupleFaulted == nil || !*ms.ThermocoupleFaulted {
		t.Fatal("expected ThermocoupleFaulted=true")
	}
	if ms.ThermocoupleFaultReason == nil || *ms.ThermocoupleFaultReason != "open circuit" {
		t.Errorf("ThermocoupleFaultReason = %v, want 'open circuit'", ms.ThermocoupleFaultReason)
	}
	if ms.PressureSensorFaulted == nil || *ms.PressureSensorFaulted {
		t.Errorf("expected PressureSensorFaulted=false (present, not nil)")
	}
}

func TestIsStillWarm(t *testing.T) {
	now := int64(1_000_000)
	cases := []struct {
		name        string
		currentTemp *float64
		switchOnAt  *int64
		switchOffAt *int64
		want        bool
	}{
		{"hot and never switched off", ptrF64(85), nil, nil, true},
		{"cold temp, never switched off", ptrF64(70), nil, nil, false},
		{"hot but switched off long ago", ptrF64(85), nil, ptrI64(now - warmOffMaxDur.Milliseconds() - 1000), false},
		{"hot, switched off recently", ptrF64(85), nil, ptrI64(now - 1000), true},
		{"no temp reading, was switched on, not cold-off", nil, ptrI64(now - 1000), nil, true},
		{"no temp reading, never switched on", nil, nil, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := isStillWarm(tc.currentTemp, tc.switchOnAt, tc.switchOffAt, now)
			if got != tc.want {
				t.Errorf("isStillWarm() = %v, want %v", got, tc.want)
			}
		})
	}
}
