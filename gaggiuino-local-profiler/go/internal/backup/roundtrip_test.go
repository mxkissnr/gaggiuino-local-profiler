package backup

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

// fakePNG returns a byte slice that passes matchesImageMagicBytes for
// "png" (8-byte signature + >=12 bytes total).
func fakePNG() []byte {
	b := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	return append(b, bytes.Repeat([]byte{0x00}, 40)...)
}

// useImageDir points the package-level imageDir at a throwaway directory
// for the duration of a test.
func useImageDir(t *testing.T) string {
	t.Helper()
	prev := imageDir
	dir := t.TempDir()
	imageDir = dir
	t.Cleanup(func() { imageDir = prev })
	return dir
}

// TestStreamRoundTrip_FullFidelity seeds a populated install, streams a
// backup zip out, streams it back into a fresh install, and deep-compares
// every restored section.
func TestStreamRoundTrip_FullFidelity(t *testing.T) {
	imgDir := useImageDir(t)
	if err := os.WriteFile(filepath.Join(imgDir, "1.png"), fakePNG(), 0o644); err != nil {
		t.Fatal(err)
	}

	h1, deps1, _ := newTestHandlers(t)
	mux1 := newMux(h1)

	seedShot(t, deps1, 42)
	seedShot(t, deps1, 43)
	if err := deps1.ShotsRepo.SetTrashEntry(43, 1234567); err != nil {
		t.Fatal(err)
	}
	seedOrder(t, deps1)
	if _, err := deps1.MaintenanceRepo.AddMaintenanceLogEntry("descaling", "rt note", "gaggiuino.local", 5, 1); err != nil {
		t.Fatal(err)
	}
	if err := deps1.LibRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(1), "name": "RT Bean", "stock_g": float64(250), "image": "png"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := deps1.ShotsRepo.SaveBlocklist([]string{"77"}); err != nil {
		t.Fatal(err)
	}

	rec := doJSON(t, mux1, http.MethodPost, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	zipBytes := append([]byte(nil), rec.Body.Bytes()...)

	// Fresh install.
	h2, deps2, _ := newTestHandlersInDir(t)
	mux2 := newMux(h2)

	rr := doZip(t, mux2, "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	// Shots + annotation.
	s42, err := deps2.ShotsRepo.FindByID(42)
	if err != nil || s42 == nil {
		t.Fatalf("shot 42 missing: %v", err)
	}
	if ann, _ := s42["annotation"].(map[string]any); ann["coffee"] != "Test Bean" {
		t.Errorf("shot 42 annotation not restored: %+v", s42["annotation"])
	}
	// Trash.
	tm, _ := deps2.ShotsRepo.TrashMap()
	if tm["43"] != 1234567 {
		t.Errorf("trash not restored: %+v", tm)
	}
	// Blocklist.
	if bl, _ := deps2.ShotsRepo.GetBlocklist(); len(bl) != 1 || bl[0] != "77" {
		t.Errorf("blocklist = %v", bl)
	}
	// Library + image ext preserved + image file written.
	lib, _ := deps2.LibRepo.GetLibrary()
	if len(lib.Beans) != 1 || lib.Beans[0]["name"] != "RT Bean" || lib.Beans[0]["image"] != "png" {
		t.Errorf("library beans = %+v", lib.Beans)
	}
	if _, err := os.Stat(filepath.Join(imgDir, "1.png")); err != nil {
		t.Errorf("bean image not written on restore: %v", err)
	}
	// Orders.
	if o, _ := deps2.OrdersRepo.FindAll(); len(o) != 1 {
		t.Errorf("orders = %+v", o)
	}
	// Maintenance log.
	if lg, _ := deps2.MaintenanceRepo.GetMaintenanceLog(0); len(lg) != 1 || lg[0].Notes != "rt note" {
		t.Errorf("maintenance log = %+v", lg)
	}
}

// TestStreamedBackupJSON_StructuralShape asserts the streamed backup.json
// carries every top-level section key with the right JSON type — the
// format the pre-change marshalled bundle had (key-order-independent).
func TestStreamedBackupJSON_StructuralShape(t *testing.T) {
	useImageDir(t)
	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)
	seedShot(t, deps, 1)
	seedOrder(t, deps)
	if err := deps.ShotsRepo.SaveBlocklist([]string{"5"}); err != nil {
		t.Fatal(err)
	}

	rec := doJSON(t, mux, http.MethodGet, "/api/backup", nil)
	var b map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("streamed backup.json invalid: %v", err)
	}
	if b["glp_backup"] != true {
		t.Errorf("glp_backup = %v", b["glp_backup"])
	}
	if _, ok := b["version"].(string); !ok {
		t.Errorf("version missing/!string")
	}
	if _, ok := b["created"].(string); !ok {
		t.Errorf("created missing/!string")
	}
	for _, k := range []string{"shots", "blocklist"} {
		if _, ok := b[k].([]any); !ok {
			t.Errorf("%q is not a JSON array: %T", k, b[k])
		}
	}
	for _, k := range []string{"annotations", "trash", "coffee_library", "kv", "images"} {
		if _, ok := b[k].(map[string]any); !ok {
			t.Errorf("%q is not a JSON object: %T", k, b[k])
		}
	}
	if arr, _ := b["shots"].([]any); len(arr) != 1 {
		t.Errorf("shots len = %d", len(arr))
	}
}

// TestRestore_LegacyBackupZip_StillImportable imports a zip produced by
// the pre-#959 code (checked-in fixture) and confirms the new streaming
// importer restores it correctly.
func TestRestore_LegacyBackupZip_StillImportable(t *testing.T) {
	useImageDir(t)
	zipBytes, err := os.ReadFile(filepath.Join("testdata", "legacy-backup.zip"))
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}

	h, deps, _ := newTestHandlersInDir(t)
	mux := newMux(h)

	rr := doZip(t, mux, "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}
	result := decodeBody(t, rr.Body.Bytes())
	if result["ok"] != true {
		t.Fatalf("restore result = %+v", result)
	}

	for _, id := range []int64{42, 43} {
		s, err := deps.ShotsRepo.FindByID(id)
		if err != nil || s == nil {
			t.Fatalf("legacy shot %d not restored: %v", id, err)
		}
	}
	lib, _ := deps.LibRepo.GetLibrary()
	if len(lib.Beans) != 1 || lib.Beans[0]["name"] != "Legacy Bean" {
		t.Errorf("legacy library beans = %+v", lib.Beans)
	}
	if bl, _ := deps.ShotsRepo.GetBlocklist(); len(bl) != 1 || bl[0] != "99" {
		t.Errorf("legacy blocklist = %v", bl)
	}
	if lg, _ := deps.MaintenanceRepo.GetMaintenanceLog(0); len(lg) != 1 || lg[0].Notes != "legacy note" {
		t.Errorf("legacy maintenance log = %+v", lg)
	}
}
