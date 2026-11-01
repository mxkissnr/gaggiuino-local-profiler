package backup

import (
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// fakeJPEG returns a minimal blob that passes img's JPEG magic-byte check and
// is small enough for img.WriteOptimized to store unchanged.
func fakeJPEG() []byte {
	return []byte{0xFF, 0xD8, 0xFF, 0xD9, 0, 0, 0, 0, 0, 0, 0, 0}
}

// jsonShotImageBundle builds a legacy self-contained JSON bundle (the shape
// GET /api/backup returns) with one shot whose `image` is "shot-7.jpg". With
// withImage the bundle also carries that file's bytes base64-encoded under
// `images`; without it the shot's photo is missing from the bundle.
func jsonShotImageBundle(t *testing.T, withImage bool) map[string]any {
	t.Helper()
	images := map[string]any{}
	if withImage {
		images["shot-7.jpg"] = base64.StdEncoding.EncodeToString(fakeJPEG())
	}
	return map[string]any{
		"glp_backup": true,
		"shots": []any{map[string]any{
			"id":          int64(7),
			"timestamp":   int64(1700000000),
			"duration":    int64(30000),
			"profileName": "Test Profile",
			"machineId":   int64(1),
			"image":       "jpg",
		}},
		"images": images,
	}
}

// TestRestore_JSONBundleKeepsShotImage (#1852): pass 1 streams the shots
// array before a legacy JSON bundle's inline images are decoded, so the
// shot photo used to be dropped. After the restore the photo file must exist
// and the summary must count it — on the dry run as well.
func TestRestore_JSONBundleKeepsShotImage(t *testing.T) {
	dir := useImageDir(t)
	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)

	dryRun := jsonShotImageBundle(t, true)
	dryRun["dryRun"] = true
	rec := doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, dryRun))
	if rec.Code != http.StatusOK {
		t.Fatalf("dry-run status = %d; body=%s", rec.Code, rec.Body.String())
	}
	preview, _ := decodeBody(t, rec.Body.Bytes())["preview"].(map[string]any)
	if got, _ := preview["images"].(float64); got != 1 {
		t.Errorf("dry-run preview.images = %v, want 1", preview["images"])
	}
	if _, err := os.Stat(filepath.Join(dir, "shot-7.jpg")); !os.IsNotExist(err) {
		t.Errorf("dry run wrote the image file (stat err=%v)", err)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, jsonShotImageBundle(t, true)))
	if rec.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec.Body.Bytes())
	if got, _ := resp["images"].(float64); got != 1 {
		t.Errorf("restore images = %v, want 1", resp["images"])
	}
	if got, _ := resp["imagesFailed"].(float64); got != 0 {
		t.Errorf("restore imagesFailed = %v, want 0", resp["imagesFailed"])
	}
	shot, err := deps.ShotsRepo.FindByID(7)
	if err != nil || shot == nil {
		t.Fatalf("restored shot 7 not found: err=%v shot=%v", err, shot)
	}
	if ext, _ := shot["image"].(string); ext != "jpg" {
		t.Errorf("restored shot image = %v, want jpg", shot["image"])
	}
	if _, err := os.Stat(filepath.Join(dir, "shot-7.jpg")); err != nil {
		t.Errorf("restored shot photo missing: %v", err)
	}
}

// TestRestore_JSONBundleMissingShotImage: the same bundle without the image
// entry still restores the shot and counts no photo — the behaviour before
// the fix, unchanged.
func TestRestore_JSONBundleMissingShotImage(t *testing.T) {
	dir := useImageDir(t)
	h, deps, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, jsonShotImageBundle(t, false)))
	if rec.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec.Body.Bytes())
	if got, _ := resp["images"].(float64); got != 0 {
		t.Errorf("restore images = %v, want 0", resp["images"])
	}
	if _, err := os.Stat(filepath.Join(dir, "shot-7.jpg")); !os.IsNotExist(err) {
		t.Errorf("a photo was written for a bundle without image bytes (stat err=%v)", err)
	}
	if _, err := deps.ShotsRepo.FindByID(7); err != nil {
		t.Fatalf("restored shot 7 not found: %v", err)
	}
	if got, _ := resp["shots"].(float64); got != 1 {
		t.Errorf("restore shots = %v, want 1", resp["shots"])
	}
}
