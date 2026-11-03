package backup

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

// jsonShotImageBundle builds a legacy self-contained JSON bundle (the shape
// GET /api/backup returns) with one shot whose `image` is "shot-7.jpg". With
// withImage the bundle also carries that file's bytes base64-encoded under
// `images`; without it the shot's photo is missing from the bundle.
func jsonShotImageBundle(t *testing.T, withImage bool) map[string]any {
	t.Helper()
	return jsonShotImageBundleWithOriginal(t, withImage, nil, false)
}

// jsonShotImageBundleWithOriginal is jsonShotImageBundle plus the #1845
// uncropped-original half: crop is written as the shot's `imageCrop` (nil =
// none) and, when withOriginal is set, the original's bytes travel as inline
// `shot-7.orig.jpg`.
func jsonShotImageBundleWithOriginal(t *testing.T, withImage bool, crop map[string]any, withOriginal bool) map[string]any {
	t.Helper()
	images := map[string]any{}
	if withImage {
		images["shot-7.jpg"] = base64.StdEncoding.EncodeToString(tinyJPEG(t, 48, 36))
	}
	if withOriginal {
		images["shot-7.orig.jpg"] = base64.StdEncoding.EncodeToString(tinyJPEG(t, 64, 48))
	}
	shot := map[string]any{
		"id":          int64(7),
		"timestamp":   int64(1700000000),
		"duration":    int64(30000),
		"profileName": "Test Profile",
		"machineId":   int64(1),
		"image":       "jpg",
	}
	if crop != nil {
		shot["imageCrop"] = crop
	}
	return map[string]any{
		"glp_backup": true,
		"shots":      []any{shot},
		"images":     images,
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

// ── #1845: uncropped originals in the legacy JSON form ──────────────────

// jsonBundleCrop is a valid imageCrop rectangle for the JSON-bundle tests.
var jsonBundleCrop = map[string]any{"x": 0.0, "y": 0.1, "w": 0.4, "h": 0.5}

// TestRestore_JSONBundleKeepsShotOriginal (#1845): the legacy self-contained
// form gets the same treatment as the zip. With the inline original present
// the shot keeps its crop and the original is written; the photo counts stay
// photo-only. Without it the crop is dropped and the photo kept.
func TestRestore_JSONBundleKeepsShotOriginal(t *testing.T) {
	t.Run("crop and original", func(t *testing.T) {
		dir := useImageDir(t)
		h, deps, _ := newTestHandlers(t)
		mux := newMux(h)

		dryRun := jsonShotImageBundleWithOriginal(t, true, jsonBundleCrop, true)
		dryRun["dryRun"] = true
		rec := doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, dryRun))
		if rec.Code != http.StatusOK {
			t.Fatalf("dry-run status = %d; body=%s", rec.Code, rec.Body.String())
		}
		preview, _ := decodeBody(t, rec.Body.Bytes())["preview"].(map[string]any)
		if got, _ := preview["images"].(float64); got != 1 {
			t.Errorf("dry-run preview.images = %v, want 1 (main only)", preview["images"])
		}

		rec = doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, jsonShotImageBundleWithOriginal(t, true, jsonBundleCrop, true)))
		if rec.Code != http.StatusOK {
			t.Fatalf("restore status = %d; body=%s", rec.Code, rec.Body.String())
		}
		resp := decodeBody(t, rec.Body.Bytes())
		if got, _ := resp["images"].(float64); got != 1 {
			t.Errorf("restore images = %v, want 1 (main only)", resp["images"])
		}
		if got, _ := resp["imagesFailed"].(float64); got != 0 {
			t.Errorf("restore imagesFailed = %v, want 0", resp["imagesFailed"])
		}

		shot, err := deps.ShotsRepo.FindByID(7)
		if err != nil || shot == nil {
			t.Fatalf("restored shot not found: err=%v", err)
		}
		assertCropMatches(t, "json shot", shot)
		assertOriginalJPEG(t, dir, "shot-7.orig.jpg")
	})

	t.Run("crop without original", func(t *testing.T) {
		dir := useImageDir(t)
		h, deps, _ := newTestHandlers(t)
		mux := newMux(h)

		rec := doJSON(t, mux, http.MethodPost, "/api/restore", mustMarshal(t, jsonShotImageBundleWithOriginal(t, true, jsonBundleCrop, false)))
		if rec.Code != http.StatusOK {
			t.Fatalf("restore status = %d; body=%s", rec.Code, rec.Body.String())
		}
		if got, _ := decodeBody(t, rec.Body.Bytes())["images"].(float64); got != 1 {
			t.Errorf("restore images = %v, want 1", got)
		}
		shot, err := deps.ShotsRepo.FindByID(7)
		if err != nil || shot == nil {
			t.Fatalf("restored shot not found: err=%v", err)
		}
		if ext, _ := shot["image"].(string); ext != "jpg" {
			t.Errorf("shot photo dropped: image = %v", shot["image"])
		}
		if _, ok := shot["imageCrop"]; ok {
			t.Errorf("shot kept imageCrop without an original: %v", shot["imageCrop"])
		}
		assertNoOriginal(t, dir, "shot-7.orig.jpg")
	})
}

// TestRestore_JSONRoundTripKeepsBeanOriginal (#1845): a bean's crop and
// original survive a GET /api/backup (legacy JSON) -> POST /api/restore.
func TestRestore_JSONRoundTripKeepsBeanOriginal(t *testing.T) {
	srcDir := useImageDir(t)
	const beanID int64 = 7
	jpg := tinyJPEG(t, 64, 48)
	writeImageFile(t, srcDir, fmt.Sprintf("%d.jpg", beanID), jpg)
	writeImageFile(t, srcDir, fmt.Sprintf("%d.orig.jpg", beanID), jpg)

	h1, deps1, _ := newTestHandlers(t)
	if err := deps1.LibRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": beanID, "name": "JSON Bean", "image": "jpg", "imageCrop": testCrop}},
	}); err != nil {
		t.Fatal(err)
	}

	rec := doJSON(t, newMux(h1), http.MethodGet, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	jsonBytes := append([]byte(nil), rec.Body.Bytes()...)

	dstDir := t.TempDir()
	useImageDirAt(t, dstDir)
	h2, deps2, _ := newTestHandlersInDir(t)
	rr := doJSON(t, newMux(h2), http.MethodPost, "/api/restore", jsonBytes)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}
	if got, _ := decodeBody(t, rr.Body.Bytes())["images"].(float64); got != 1 {
		t.Errorf("restore images = %v, want 1", got)
	}

	lib, err := deps2.LibRepo.GetLibrary()
	if err != nil {
		t.Fatal(err)
	}
	if len(lib.Beans) != 1 {
		t.Fatalf("restored beans = %+v", lib.Beans)
	}
	assertCropMatches(t, "json bean", lib.Beans[0])
	assertOriginalJPEG(t, dstDir, fmt.Sprintf("%d.orig.jpg", beanID))
}
