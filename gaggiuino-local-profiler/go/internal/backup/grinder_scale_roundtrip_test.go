package backup

import (
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

// restoreGrinders exports a library holding grinders and restores it into a
// fresh install, returning the restored grinder list keyed by name.
func restoreGrinders(t *testing.T, grinders []library.Entity) map[string]map[string]any {
	t.Helper()
	useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)
	if err := deps1.LibRepo.SaveLibrary(library.Library{Grinders: grinders}); err != nil {
		t.Fatalf("seeding library: %v", err)
	}

	rec := doJSON(t, newMux(h1), http.MethodPost, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	zipBytes := append([]byte(nil), rec.Body.Bytes()...)

	useImageDirAt(t, t.TempDir())
	h2, deps2, _ := newTestHandlersInDir(t)
	rr := doZip(t, newMux(h2), "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	restored, err := deps2.LibRepo.GetLibrary()
	if err != nil {
		t.Fatalf("reading restored library: %v", err)
	}
	out := make(map[string]map[string]any, len(restored.Grinders))
	for _, g := range restored.Grinders {
		name, _ := g["name"].(string)
		out[name] = g
	}
	return out
}

// TestLibraryRoundTrip_GrinderScaleUnchanged: both scale kinds survive export
// and restore.
func TestLibraryRoundTrip_GrinderScaleUnchanged(t *testing.T) {
	out := restoreGrinders(t, []library.Entity{
		{"id": int64(1), "name": "Kingrinder K6", "scale": map[string]any{
			"type": "stepped", "min": 0.0, "max": 60.0, "step": 1.0,
		}},
		{"id": int64(2), "name": "Lagom Casa", "scale": map[string]any{
			"type": "stepless", "min": 0.0, "max": 9.0, "step": 0.1,
		}},
		{"id": int64(3), "name": "Old Grinder"},
	})

	k6, ok := out["Kingrinder K6"]["scale"].(map[string]any)
	if !ok {
		t.Fatalf("stepped scale did not survive: %+v", out["Kingrinder K6"])
	}
	if k6["type"] != "stepped" || k6["min"] != 0.0 || k6["max"] != 60.0 || k6["step"] != 1.0 {
		t.Errorf("restored stepped scale = %#v", k6)
	}

	casa, ok := out["Lagom Casa"]["scale"].(map[string]any)
	if !ok {
		t.Fatalf("stepless scale did not survive: %+v", out["Lagom Casa"])
	}
	if casa["type"] != "stepless" || casa["max"] != 9.0 || casa["step"] != 0.1 {
		t.Errorf("restored stepless scale = %#v", casa)
	}

	if v, ok := out["Old Grinder"]["scale"]; ok {
		t.Errorf("a grinder without a scale gained one: %#v", v)
	}
}

// TestLibraryRoundTrip_GrinderGarbageScaleDropped: a crafted scale is dropped
// by the restore sanitizer, the grinder itself kept.
func TestLibraryRoundTrip_GrinderGarbageScaleDropped(t *testing.T) {
	out := restoreGrinders(t, []library.Entity{
		{"id": int64(1), "name": "Crafted", "scale": map[string]any{"type": "clicky"}},
	})

	crafted, ok := out["Crafted"]
	if !ok {
		t.Fatalf("grinder with a garbage scale was dropped entirely: %+v", out)
	}
	if v, ok := crafted["scale"]; ok {
		t.Errorf("garbage scale survived the restore: %#v", v)
	}
}
