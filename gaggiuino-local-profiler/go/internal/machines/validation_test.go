package machines

import (
	"encoding/json"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

func TestMachineInputValidate(t *testing.T) {
	valid := MachineInput{Name: strPtr("A"), Type: strPtr("gaggiuino"), Host: strPtr("a.local")}
	if err := valid.validate(true); err != nil {
		t.Fatalf("expected valid input to pass, got: %v", err)
	}

	missingCore := MachineInput{Name: strPtr("A")}
	if err := missingCore.validate(true); err == nil {
		t.Fatal("expected an error for missing type/host on create")
	}
	// The same input is fine for a partial PUT.
	if err := missingCore.validate(false); err != nil {
		t.Fatalf("expected a partial update to allow omitted fields, got: %v", err)
	}

	badType := MachineInput{Type: strPtr("espresso-machine")}
	if err := badType.validate(false); err == nil {
		t.Fatal("expected an error for an invalid type")
	}
}

func TestValidateThemeExactlyOneVariant(t *testing.T) {
	if err := validateTheme(Theme{Preset: "amber-americano"}); err != nil {
		t.Fatalf("valid preset rejected: %v", err)
	}
	if err := validateTheme(Theme{A: "#123456", B: "#abcdef"}); err != nil {
		t.Fatalf("valid a/b colors rejected: %v", err)
	}
	if err := validateTheme(Theme{Preset: "amber-americano", A: "#123456", B: "#abcdef"}); err == nil {
		t.Fatal("expected an error for both preset and a/b set")
	}
	if err := validateTheme(Theme{}); err == nil {
		t.Fatal("expected an error for neither preset nor a/b set")
	}
	if err := validateTheme(Theme{Preset: "not-a-real-preset"}); err == nil {
		t.Fatal("expected an error for an unknown preset key")
	}
	if err := validateTheme(Theme{A: "not-hex", B: "#abcdef"}); err == nil {
		t.Fatal("expected an error for an invalid hex color")
	}
}

func TestProfileInputValidate(t *testing.T) {
	valid := ProfileInput{Name: "Espresso", Phases: []PhaseInput{{Type: proto.PhasePressure}}}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid profile to pass, got: %v", err)
	}

	noName := ProfileInput{Phases: []PhaseInput{{}}}
	if err := noName.Validate(); err == nil {
		t.Fatal("expected an error for an empty name")
	}

	noPhases := ProfileInput{Name: "X"}
	if err := noPhases.Validate(); err == nil {
		t.Fatal("expected an error for zero phases")
	}
}

// ToWireProfile ports toWireProfile()'s unconditional target/stopConditions
// object creation (defaults filled in, never omitted) but conditional
// globalStopConditions/recipe — see validation.go's header comment.
func TestToWireProfile_TargetAndStopConditionsAlwaysPresent(t *testing.T) {
	in := ProfileInput{
		Name: "Minimal",
		Phases: []PhaseInput{
			{Type: proto.PhaseFlow}, // no Target, no StopConditions given at all
		},
	}
	wire := in.ToWireProfile()
	if wire.Phases[0].Target == nil {
		t.Error("Target must always be non-nil after ToWireProfile, even when the input omitted it")
	}
	if wire.Phases[0].StopConditions == nil {
		t.Error("StopConditions must always be non-nil after ToWireProfile, even when the input omitted it")
	}
	if wire.GlobalStopConditions != nil {
		t.Error("GlobalStopConditions must stay nil when the input didn't set it")
	}
	if wire.Recipe != nil {
		t.Error("Recipe must stay nil when the input didn't set it")
	}
}

func TestToWireProfile_EnumFromJSONStringOrNumber(t *testing.T) {
	var in ProfileInput
	body := `{"name":"X","phases":[{"type":"PRESSURE","target":{"curve":"LINEAR"}}]}`
	if err := json.Unmarshal([]byte(body), &in); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	wire := in.ToWireProfile()
	if wire.Phases[0].Type != proto.PhasePressure {
		t.Errorf("Type = %v, want PhasePressure (from JSON string \"PRESSURE\")", wire.Phases[0].Type)
	}
	if wire.Phases[0].Target.Curve != proto.CurveLinear {
		t.Errorf("Curve = %v, want CurveLinear (from JSON string \"LINEAR\")", wire.Phases[0].Target.Curve)
	}

	var in2 ProfileInput
	body2 := `{"name":"X","phases":[{"type":1}]}`
	if err := json.Unmarshal([]byte(body2), &in2); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if in2.Phases[0].Type != proto.PhasePressure {
		t.Errorf("Type = %v, want PhasePressure (from JSON number 1)", in2.Phases[0].Type)
	}
}

func TestValidateOperationMode(t *testing.T) {
	if err := ValidateOperationMode(proto.ModeBrewManual); err == nil {
		t.Fatal("expected BREW_MANUAL to be rejected")
	}
	if err := ValidateOperationMode(proto.ModeSteam); err != nil {
		t.Fatalf("expected STEAM to be accepted, got: %v", err)
	}
	if err := ValidateOperationMode(proto.OperationMode(99)); err == nil {
		t.Fatal("expected an out-of-range mode to be rejected")
	}
}

func TestValidateServiceTestPeripheral(t *testing.T) {
	if err := ValidateServiceTestPeripheral(proto.PeripheralLED); err != nil {
		t.Fatalf("expected LED to be accepted, got: %v", err)
	}
	if err := ValidateServiceTestPeripheral(proto.ServiceTestPeripheral(99)); err == nil {
		t.Fatal("expected an out-of-range peripheral to be rejected")
	}
}

func TestValidateSettingsPayload(t *testing.T) {
	if err := ValidateSettingsPayload(json.RawMessage(`{"a":1,"b":"true"}`)); err != nil {
		t.Fatalf("expected a plain object to be accepted, got: %v", err)
	}
	if err := ValidateSettingsPayload(json.RawMessage(`[1,2,3]`)); err == nil {
		t.Fatal("expected a JSON array to be rejected")
	}
	if err := ValidateSettingsPayload(json.RawMessage(`not json`)); err == nil {
		t.Fatal("expected invalid JSON to be rejected")
	}
}

func TestValidateBoilerSettings(t *testing.T) {
	valid := json.RawMessage(`{"steamSetPoint":145,"offsetTemp":5,"hpwr":1200,"mainDivider":2,"brewDivider":4,"brewDeltaState":"true","dreamSteamState":"false","startupHeatDelta":10}`)
	if err := ValidateBoilerSettings(valid); err != nil {
		t.Fatalf("expected a valid boiler payload to be accepted, got: %v", err)
	}
	if err := ValidateBoilerSettings(json.RawMessage(`{}`)); err != nil {
		t.Fatalf("expected an empty object (no known fields present) to be accepted, got: %v", err)
	}
	if err := ValidateBoilerSettings(json.RawMessage(`{"steamSetPoint":"not a number"}`)); err == nil {
		t.Fatal("expected a string in a numeric field to be rejected")
	}
	if err := ValidateBoilerSettings(json.RawMessage(`{"steamSetPoint":-5}`)); err == nil {
		t.Fatal("expected a negative steamSetPoint to be rejected")
	}
	if err := ValidateBoilerSettings(json.RawMessage(`{"steamSetPoint":1450}`)); err == nil {
		t.Fatal("expected a wildly out-of-range steamSetPoint (typo'd extra zero) to be rejected")
	}
	if err := ValidateBoilerSettings(json.RawMessage(`{"mainDivider":0}`)); err == nil {
		t.Fatal("expected a zero divider to be rejected")
	}
	if err := ValidateBoilerSettings(json.RawMessage(`{"brewDeltaState":"yes"}`)); err == nil {
		t.Fatal(`expected a bool-as-string field with a value other than "true"/"false" to be rejected`)
	}
	if err := ValidateBoilerSettings(json.RawMessage(`{"brewDeltaState":true}`)); err == nil {
		t.Fatal("expected a real JSON boolean (not the bool-as-string quirk's string form) to be rejected")
	}
	// #901 code review (CONFIRMED finding #1): json.Unmarshal into a plain
	// (non-pointer) float64 no-ops on a JSON `null`, leaving it at 0 —
	// which silently passed every numeric field's bounds check whose lower
	// bound is <= 0, letting a present-but-null field reach
	// adapter.UpdateSettings verbatim. Every boilerNumberFields entry must
	// reject null explicitly, not just the ones with a positive-only
	// lower bound (mainDivider/brewDivider only rejected it by
	// coincidence).
	for _, field := range []string{"steamSetPoint", "offsetTemp", "hpwr", "mainDivider", "brewDivider", "startupHeatDelta"} {
		payload := json.RawMessage(`{"` + field + `":null}`)
		if err := ValidateBoilerSettings(payload); err == nil {
			t.Errorf("expected null %s to be rejected, got no error", field)
		}
	}
	if err := ValidateBoilerSettings(json.RawMessage(`not json`)); err == nil {
		t.Fatal("expected invalid JSON to be rejected")
	}
}

func TestValidateSystemSettings(t *testing.T) {
	if err := ValidateSystemSettings(json.RawMessage(`{"releaseChannel":0}`)); err != nil {
		t.Fatalf("expected releaseChannel 0 (stable) to be accepted, got: %v", err)
	}
	if err := ValidateSystemSettings(json.RawMessage(`{"releaseChannel":2}`)); err != nil {
		t.Fatalf("expected releaseChannel 2 (debug) to be accepted, got: %v", err)
	}
	if err := ValidateSystemSettings(json.RawMessage(`{"wifiEnabled":true}`)); err != nil {
		t.Fatalf("expected a payload without releaseChannel to be accepted (not required), got: %v", err)
	}
	if err := ValidateSystemSettings(json.RawMessage(`{"releaseChannel":3}`)); err == nil {
		t.Fatal("expected an out-of-range releaseChannel to be rejected")
	}
	if err := ValidateSystemSettings(json.RawMessage(`{"releaseChannel":"stable"}`)); err == nil {
		t.Fatal("expected a non-numeric releaseChannel string to be rejected")
	}
	if err := ValidateSystemSettings(json.RawMessage(`not json`)); err == nil {
		t.Fatal("expected invalid JSON to be rejected")
	}
}
