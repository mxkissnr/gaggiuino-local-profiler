package backup

import (
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
)

// TestSanitizeMaintenanceRow covers which `data` values a restored task row
// keeps: `disabled` survives only as a real boolean, and every other
// boolean/object/array stays dropped.
func TestSanitizeMaintenanceRow(t *testing.T) {
	cases := []struct {
		name    string
		data    map[string]any
		want    map[string]any
		missing []string
	}{
		{
			name: "disabled true is kept",
			data: map[string]any{"lastDate": "2026-01-01T00:00:00.000Z", "disabled": true},
			want: map[string]any{"lastDate": "2026-01-01T00:00:00.000Z", "disabled": true},
		},
		{
			name:    "no disabled key stays absent",
			data:    map[string]any{"lastDate": "2026-01-01T00:00:00.000Z", "threshold_shots": float64(200)},
			want:    map[string]any{"lastDate": "2026-01-01T00:00:00.000Z", "threshold_shots": float64(200)},
			missing: []string{"disabled"},
		},
		{
			name:    "disabled as string is not stored",
			data:    map[string]any{"lastDate": nil, "disabled": "true"},
			want:    map[string]any{"lastDate": nil},
			missing: []string{"disabled"},
		},
		{
			name:    "disabled as number is not stored",
			data:    map[string]any{"lastDate": nil, "disabled": float64(1)},
			want:    map[string]any{"lastDate": nil},
			missing: []string{"disabled"},
		},
		{
			name:    "other unknown values are dropped",
			data:    map[string]any{"lastDate": nil, "foo": true, "obj": map[string]any{"a": 1}, "arr": []any{1, 2}},
			want:    map[string]any{"lastDate": nil},
			missing: []string{"foo", "obj", "arr"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := sanitizeMaintenanceRow(map[string]any{
				"machineId": float64(1), "key": "descaling", "data": tc.data,
			})
			if !ok {
				t.Fatalf("sanitizeMaintenanceRow rejected a valid row")
			}
			data, ok := got["data"].(map[string]any)
			if !ok {
				t.Fatalf("data = %v (%T), want map[string]any", got["data"], got["data"])
			}
			if len(data) != len(tc.want) {
				t.Fatalf("data = %+v, want %+v", data, tc.want)
			}
			for k, want := range tc.want {
				if data[k] != want {
					t.Errorf("data[%q] = %v (%T), want %v (%T)", k, data[k], data[k], want, want)
				}
			}
			for _, k := range tc.missing {
				if v, present := data[k]; present {
					t.Errorf("data[%q] = %v (%T), want key absent", k, v, v)
				}
			}
		})
	}
}

// TestStreamRoundTrip_MaintenanceDisabled: a task disabled before the export
// comes back disabled after the restore, through the real backup/restore
// endpoints.
func TestStreamRoundTrip_MaintenanceDisabled(t *testing.T) {
	useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)

	if err := deps1.MaintenanceRepo.SaveTask(1, "descaling", maintenance.Task{
		"lastDate": "2026-01-01T00:00:00.000Z", "disabled": true,
	}); err != nil {
		t.Fatalf("seeding disabled task: %v", err)
	}

	rec := doJSON(t, newMux(h1), http.MethodPost, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	zipBytes := append([]byte(nil), rec.Body.Bytes()...)

	h2, deps2, _ := newTestHandlersInDir(t)
	rr := doZip(t, newMux(h2), "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	maint, err := deps2.MaintenanceRepo.GetMaintenance(1)
	if err != nil {
		t.Fatalf("GetMaintenance: %v", err)
	}
	task := maint["descaling"]
	if task == nil {
		t.Fatalf("restored maintenance is missing descaling: %+v", maint)
	}
	if got, ok := task["disabled"].(bool); !ok || !got {
		t.Errorf("restored disabled = %v (%T), want true", task["disabled"], task["disabled"])
	}

	stats, err := maintenance.ComputeMaintenanceStats(deps2.ShotsRepo, deps2.LibRepo, maint, 1)
	if err != nil {
		t.Fatalf("ComputeMaintenanceStats: %v", err)
	}
	if got, ok := stats["descaling"]["disabled"].(bool); !ok || !got {
		t.Errorf("restored stat disabled = %v (%T), want true", stats["descaling"]["disabled"], stats["descaling"]["disabled"])
	}
}
