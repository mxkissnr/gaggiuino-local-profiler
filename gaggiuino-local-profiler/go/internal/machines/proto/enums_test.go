package proto

import (
	"encoding/json"
	"testing"
)

func TestPhaseTypeUnmarshalJSON(t *testing.T) {
	var p PhaseType
	if err := json.Unmarshal([]byte(`"PRESSURE"`), &p); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p != PhasePressure {
		t.Errorf("got %d, want %d", p, PhasePressure)
	}

	if err := json.Unmarshal([]byte(`1`), &p); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p != PhasePressure {
		t.Errorf("numeric input: got %d, want %d", p, PhasePressure)
	}

	if err := json.Unmarshal([]byte(`"NOT_A_PHASE"`), &p); err == nil {
		t.Error("expected an error for an unknown enum name, got nil")
	}
}

func TestOperationModeUnmarshalJSON(t *testing.T) {
	cases := []struct {
		in   string
		want OperationMode
	}{
		{`"BREW_AUTO"`, ModeBrewAuto},
		{`"HOME"`, ModeHome},
		{`4`, ModeSteam},
	}
	for _, c := range cases {
		var m OperationMode
		if err := json.Unmarshal([]byte(c.in), &m); err != nil {
			t.Fatalf("%s: unexpected error: %v", c.in, err)
		}
		if m != c.want {
			t.Errorf("%s: got %d, want %d", c.in, m, c.want)
		}
	}
}

func TestNormalizeOperationMode(t *testing.T) {
	cases := []struct {
		in   OperationMode
		want string
	}{
		{ModeBrewAuto, "BREW_AUTO"},
		{ModeFlush, "FLUSH"},
		{ModeFlushAuto, "FLUSH_AUTO"},
		{ModeSteam, "STEAM"},
		{ModeHome, "HOME"},
		{OperationMode(99), ""}, // unrecognized -> "" (Node's null)
	}
	for _, c := range cases {
		if got := NormalizeOperationMode(c.in); got != c.want {
			t.Errorf("NormalizeOperationMode(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestServiceTestPeripheralUnmarshalJSON(t *testing.T) {
	var p ServiceTestPeripheral
	if err := json.Unmarshal([]byte(`"LED"`), &p); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p != PeripheralLED {
		t.Errorf("got %d, want %d", p, PeripheralLED)
	}
}

func TestEnumMarshalJSONIsPlainNumber(t *testing.T) {
	// No custom MarshalJSON — a defined int32 type marshals as a plain
	// number by default, matching lib/gaggiuino-proto.js's own
	// fromBinary()+JSON.stringify() output (verified directly against the
	// real runtime — see enums.go's header comment).
	b, err := json.Marshal(PhasePressure)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(b) != "1" {
		t.Errorf("Marshal(PhasePressure) = %s, want 1", b)
	}
}
