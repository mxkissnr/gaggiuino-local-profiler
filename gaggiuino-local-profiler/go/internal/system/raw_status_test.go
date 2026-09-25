package system

import (
	"encoding/json"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

func rawStatusFromBody(t *testing.T, body string, hasWaterSensor bool) RawStatus {
	t.Helper()
	return rawStatusFrom(machines.Status{Raw: json.RawMessage(body)}, hasWaterSensor)
}

// TestRawStatusFrom_CurrentFirmwareArray covers #1149: current Gaggiuino
// firmware reports /api/system/status as a one-element array of string values,
// which used to leave WaterLevel nil and UpTime 0.
func TestRawStatusFrom_CurrentFirmwareArray(t *testing.T) {
	body := `[{"upTime":"58","profileId":"4","targetTemperature":"93.000000","temperature":"87.475311","pressure":"3.100873","waterLevel":"80","weight":"0.000000","brewSwitchState":false,"boilerTemperature":87.47531,"pumpFlow":0}]`

	got := rawStatusFromBody(t, body, false)
	if got.WaterLevel == nil || *got.WaterLevel != 80 {
		t.Fatalf("WaterLevel = %v, want 80", got.WaterLevel)
	}
	if got.UpTime != 58 {
		t.Fatalf("UpTime = %d, want 58", got.UpTime)
	}
}

// TestRawStatusFrom_ObjectNumbers guards the older object-shaped payload.
func TestRawStatusFrom_ObjectNumbers(t *testing.T) {
	got := rawStatusFromBody(t, `{"upTime":58,"waterLevel":80}`, false)
	if got.WaterLevel == nil || *got.WaterLevel != 80 {
		t.Fatalf("WaterLevel = %v, want 80", got.WaterLevel)
	}
	if got.UpTime != 58 {
		t.Fatalf("UpTime = %d, want 58", got.UpTime)
	}
}

// TestRawStatusFrom_GaggiMateWL covers the GaggiMate `wl` gate: only read when
// the machine is flagged as having a water sensor, with waterLevel as fallback.
func TestRawStatusFrom_GaggiMateWL(t *testing.T) {
	cases := []struct {
		name           string
		body           string
		hasWaterSensor bool
		want           *int
	}{
		{"wl preferred with sensor", `{"wl":55,"waterLevel":80}`, true, intPtr(55)},
		{"waterLevel used without sensor", `{"wl":55,"waterLevel":80}`, false, intPtr(80)},
		{"missing waterLevel", `{"wl":55}`, false, nil},
		{"null waterLevel", `{"wl":null,"waterLevel":null}`, false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := rawStatusFromBody(t, tc.body, tc.hasWaterSensor).WaterLevel
			switch {
			case tc.want == nil && got != nil:
				t.Fatalf("WaterLevel = %d, want nil", *got)
			case tc.want != nil && (got == nil || *got != *tc.want):
				t.Fatalf("WaterLevel = %v, want %d", got, *tc.want)
			}
		})
	}
}

// TestExtractVersion_ArrayAndObject covers #1149 for the firmware version
// sniff: the array-shaped body must yield the version too.
func TestExtractVersion_ArrayAndObject(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"array", `[{"softwareVersion":"1.2.3"}]`, "1.2.3"},
		{"object", `{"softwareVersion":"1.2.3"}`, "1.2.3"},
		{"empty array", `[]`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractVersion(json.RawMessage(tc.body)); got != tc.want {
				t.Fatalf("extractVersion(%s) = %q, want %q", tc.body, got, tc.want)
			}
		})
	}
}

func intPtr(v int) *int { return &v }
