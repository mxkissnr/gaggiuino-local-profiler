package backup

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/achievements"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/uiprefs"
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
	dir := t.TempDir()
	useImageDirAt(t, dir)
	return dir
}

// useImageDirAt points imageDir at dir for the duration of the test,
// restoring the previous value on cleanup. Unlike useImageDir it creates no
// directory, so a test can install a second, distinct image directory — the
// restore target — after exporting from the first.
func useImageDirAt(t *testing.T, dir string) {
	t.Helper()
	prev := imageDir
	imageDir = dir
	t.Cleanup(func() { imageDir = prev })
}

// imagesIdentical reports whether name exists under both dirA and dirB with
// byte-identical contents. A file missing on either side is not a match, so a
// restore that dropped an image is detected instead of being masked by the
// source copy still sitting in the export directory.
func imagesIdentical(t *testing.T, dirA, dirB, name string) bool {
	t.Helper()
	a, err := os.ReadFile(filepath.Join(dirA, name))
	if err != nil {
		return false
	}
	b, err := os.ReadFile(filepath.Join(dirB, name))
	if err != nil {
		return false
	}
	return bytes.Equal(a, b)
}

// TestStreamRoundTrip_FullFidelity seeds a populated install, streams a
// backup zip out, streams it back into a fresh install, and deep-compares
// every restored section.
func TestStreamRoundTrip_FullFidelity(t *testing.T) {
	srcDir := useImageDir(t)
	if err := os.WriteFile(filepath.Join(srcDir, "1.png"), fakePNG(), 0o644); err != nil {
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
	if _, err := deps1.MaintenanceRepo.AddMaintenanceLogEntry("descaling", "rt note", "gaggiuino.local", 5, 1, time.Now()); err != nil {
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

	// Fresh install with a SEPARATE image directory: a restore that silently
	// drops the image can no longer be masked by the source copy in srcDir.
	dstDir := t.TempDir()
	useImageDirAt(t, dstDir)
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
	if !imagesIdentical(t, srcDir, dstDir, "1.png") {
		t.Errorf("restored bean image 1.png is missing from the target dir or differs from the source")
	}
	// The comparison must be able to fail: a directory without the image is not
	// a match, so a restore that wrote nothing could never pass the check above.
	if imagesIdentical(t, srcDir, t.TempDir(), "1.png") {
		t.Error("image comparison matched a target directory that has no restored image")
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

// oversizedJPEGWithEXIF returns a w×h gradient JPEG with a bare APP1 "Exif"
// segment spliced in after the SOI — enough for the restore pipeline to
// both downscale and drop metadata.
func oversizedJPEGWithEXIF(t *testing.T, w, h int) []byte {
	t.Helper()
	im := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			im.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), uint8((x + y) % 256), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, im, &jpeg.Options{Quality: 92}); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	payload := append([]byte("Exif\x00\x00"), bytes.Repeat([]byte{0}, 32)...)
	app1 := []byte{0xFF, 0xE1, byte((len(payload) + 2) >> 8), byte(len(payload) + 2)}
	app1 = append(app1, payload...)
	out := append([]byte{}, raw[:2]...)
	out = append(out, app1...)
	return append(out, raw[2:]...)
}

// TestRestore_OptimizesImagesThroughPipeline (#961): an oversized,
// EXIF-carrying bean image in a restored bundle is downscaled + stripped +
// thumbnailed by writePendingImages, while the stored extension (and the
// bean row referencing it) stays put.
func TestRestore_OptimizesImagesThroughPipeline(t *testing.T) {
	srcDir := useImageDir(t)
	big := oversizedJPEGWithEXIF(t, 1700, 1700)
	if err := os.WriteFile(filepath.Join(srcDir, "1.jpg"), big, 0o644); err != nil {
		t.Fatal(err)
	}

	h1, deps1, _ := newTestHandlers(t)
	if err := deps1.LibRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(1), "name": "Pipe Bean", "stock_g": float64(200), "image": "jpg"}},
	}); err != nil {
		t.Fatal(err)
	}
	recExp := doJSON(t, newMux(h1), http.MethodPost, "/api/backup", nil)
	if recExp.Code != http.StatusOK {
		t.Fatalf("export status = %d", recExp.Code)
	}
	zipBytes := append([]byte(nil), recExp.Body.Bytes()...)

	// Restore into a separate, empty image directory so every file the pipeline
	// writes is one the restore actually produced.
	dstDir := t.TempDir()
	useImageDirAt(t, dstDir)
	h2, deps2, _ := newTestHandlersInDir(t)
	rr := doZip(t, newMux(h2), "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	restored, err := os.ReadFile(filepath.Join(dstDir, "1.jpg"))
	if err != nil {
		t.Fatalf("restored image missing from the target dir: %v", err)
	}
	if len(restored) >= len(big) {
		t.Errorf("restored image not shrunk: %d >= %d", len(restored), len(big))
	}
	if bytes.Contains(restored, []byte("Exif")) {
		t.Error("restored image still carries an Exif marker")
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(restored))
	if err != nil {
		t.Fatalf("decode restored: %v", err)
	}
	if cfg.Width > 1600 || cfg.Height > 1600 {
		t.Errorf("restored image not downscaled: %dx%d", cfg.Width, cfg.Height)
	}
	if _, err := os.Stat(filepath.Join(dstDir, "1.thumb.jpg")); err != nil {
		t.Errorf("thumbnail not generated on restore: %v", err)
	}
	lib, _ := deps2.LibRepo.GetLibrary()
	if len(lib.Beans) != 1 || lib.Beans[0]["image"] != "jpg" {
		t.Errorf("restored bean image ext changed: %+v", lib.Beans)
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

// tinyJPEG encodes a small, real JPEG so the restore pipeline can decode it
// (an image that only carries magic bytes still survives as a raw write, but a
// genuine JPEG exercises the full Optimize path the app uses for photos).
func tinyJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	im := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			im.Set(x, y, color.RGBA{uint8(x * 5), uint8(y * 5), 128, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, im, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestRestore_ServesLibraryImagesThroughHTTP (#1185) reproduces the reported
// "bean/grinder/puck-screen photos blank after backup restore" bug end to end:
// a source instance carries real bean/grinder/puck-screen/shot photos with
// 13-digit millisecond ids (the shape CreateBean produces), the backup zip is
// restored into a fresh instance, and each image is then fetched over HTTP
// through a REAL library.Handlers mux pointed at the same image directory. The
// old TestRestore_OptimizesImagesThroughPipeline only checked that 1.jpg
// landed on disk; it never exercised the serving route, never mixed library
// images with a shot image, and never used a CreateBean-shaped id.
func TestRestore_ServesLibraryImagesThroughHTTP(t *testing.T) {
	srcDir := useImageDir(t)
	const (
		beanID    int64 = 1783373357122
		grinderID int64 = 1783373357200
		puckID    int64 = 1783373357300
		shotID    int64 = 42
	)

	jpg := tinyJPEG(t, 48, 36)
	png := fakePNG()
	write := func(name string, b []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(srcDir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(fmt.Sprintf("%d.jpg", beanID), jpg)
	write(fmt.Sprintf("grinder-%d.png", grinderID), png)
	write(fmt.Sprintf("puckscreen-%d.jpg", puckID), jpg)
	write(fmt.Sprintf("shot-%d.jpg", shotID), jpg)

	h1, deps1, _ := newTestHandlers(t)
	if err := deps1.LibRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{
			"id": beanID, "name": "Photo Bean", "stock_g": float64(250), "image": "jpg",
			"bags": []any{library.Entity{"id": beanID + 1, "openedAt": beanID, "stock_g": float64(250)}},
		}},
		Grinders:    []library.Entity{{"id": grinderID, "name": "Photo Grinder", "image": "png"}},
		PuckScreens: []library.Entity{{"id": puckID, "name": "Photo Puck", "image": "jpg"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := deps1.ShotsRepo.Upsert(shots.Shot{
		"id": shotID, "timestamp": int64(1700000000), "duration": int64(30000),
		"profileName": "Photo Shot", "machineId": int64(1), "image": "jpg",
	}); err != nil {
		t.Fatal(err)
	}

	recExp := doJSON(t, newMux(h1), http.MethodPost, "/api/backup", nil)
	if recExp.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", recExp.Code, recExp.Body.String())
	}
	zipBytes := append([]byte(nil), recExp.Body.Bytes()...)

	// Restore into a separate image directory, and point the library package's
	// own dir at it, so the HTTP 200s below prove the restore wrote the files
	// rather than the handlers merely re-serving the seeded originals.
	dstDir := t.TempDir()
	useImageDirAt(t, dstDir)
	prevLibDir := library.DefaultImageDir
	library.DefaultImageDir = dstDir
	t.Cleanup(func() { library.DefaultImageDir = prevLibDir })

	h2, deps2, _ := newTestHandlersInDir(t)
	rr := doZip(t, newMux(h2), "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	// The real (non-dry-run) response must report how many images it queued, so
	// the E2E/screenshot harness can tell a silent drop from a real restore.
	result := decodeBody(t, rr.Body.Bytes())
	queued, _ := result["images"].(float64)
	if queued < 4 {
		t.Fatalf("restore reported images = %v; want >= 4 (bean+grinder+puck+shot)", result["images"])
	}

	// The restored DB rows must still claim a photo.
	lib, err := deps2.LibRepo.GetLibrary()
	if err != nil {
		t.Fatal(err)
	}
	if len(lib.Beans) != 1 || lib.Beans[0]["image"] != "jpg" {
		t.Errorf("restored bean image cleared: %+v", lib.Beans)
	}
	if len(lib.Grinders) != 1 || lib.Grinders[0]["image"] != "png" {
		t.Errorf("restored grinder image cleared: %+v", lib.Grinders)
	}
	if len(lib.PuckScreens) != 1 || lib.PuckScreens[0]["image"] != "jpg" {
		t.Errorf("restored puck-screen image cleared: %+v", lib.PuckScreens)
	}
	if ext, err := deps2.ShotsRepo.ImageExtFor(shotID); err != nil || ext != "jpg" {
		t.Errorf("restored shot image = %q (err=%v); want jpg", ext, err)
	}

	// And each photo must actually be served (200) through the real handler.
	libMux := http.NewServeMux()
	library.NewHandlers(deps2.LibRepo, deps2.ShotsRepo).RegisterRoutes(libMux)
	for _, tc := range []struct {
		name string
		path string
	}{
		{"bean", fmt.Sprintf("/api/library/bean/%d/image", beanID)},
		{"grinder", fmt.Sprintf("/api/library/grinder/%d/image", grinderID)},
		{"puckscreen", fmt.Sprintf("/api/library/puckscreen/%d/image", puckID)},
	} {
		rec := doJSON(t, libMux, http.MethodGet, tc.path, nil)
		if rec.Code != http.StatusOK {
			t.Errorf("%s image: GET %s = %d; want 200 (body=%s)", tc.name, tc.path, rec.Code, rec.Body.String())
		}
	}
}

// TestStreamRoundTrip_WaterSensorDefaultsAchievements (#1197 part B): a backup
// carries the machine water-sensor flag, the shot defaults and the
// achievements table; restoring into a fresh install brings all three back
// with their original values.
func TestStreamRoundTrip_WaterSensorDefaultsAchievements(t *testing.T) {
	useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)
	mux1 := newMux(h1)
	seedShot(t, deps1, 42)

	name, typ, host := "Water", "gaggiuino", "water.local"
	sensor := true
	machine, err := deps1.Registry.CreateMachine(machines.MachineInput{
		Name: &name, Type: &typ, Host: &host, HasWaterSensor: &sensor,
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	if err := deps1.ShotsRepo.SaveShotDefaults(map[string]any{
		"drinkType": "espresso", "coffee": "Round Trip", "grinder": "Niche", "dose": float64(18),
	}); err != nil {
		t.Fatalf("SaveShotDefaults: %v", err)
	}
	unlockedAt := int64(1_700_000_000)
	if err := deps1.AchievementsRepo.ReplaceAll([]achievements.Row{
		{ID: "first_shot", UnlockedAt: &unlockedAt, Progress: nil},
	}); err != nil {
		t.Fatalf("seeding achievement: %v", err)
	}

	rec := doJSON(t, mux1, http.MethodPost, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	zipBytes := append([]byte(nil), rec.Body.Bytes()...)

	h2, deps2, _ := newTestHandlersInDir(t)
	rr := doZip(t, newMux(h2), "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	list, err := deps2.Registry.ListMachines()
	if err != nil {
		t.Fatalf("ListMachines: %v", err)
	}
	foundWater := false
	for _, m := range list {
		if m.ID == machine.ID {
			foundWater = m.HasWaterSensor
		}
	}
	if !foundWater {
		t.Errorf("water-sensor flag not restored: %+v", list)
	}

	defaults, err := deps2.ShotsRepo.GetShotDefaults()
	if err != nil {
		t.Fatalf("GetShotDefaults: %v", err)
	}
	if defaults["coffee"] != "Round Trip" || defaults["grinder"] != "Niche" {
		t.Errorf("shot defaults not restored: %+v", defaults)
	}

	ach, err := deps2.AchievementsRepo.GetAll()
	if err != nil {
		t.Fatalf("achievements GetAll: %v", err)
	}
	if row, ok := ach["first_shot"]; !ok || row.UnlockedAt == nil || *row.UnlockedAt != unlockedAt {
		t.Errorf("achievement not restored: %+v", ach)
	}
}

// TestRestore_LegacyBackup_LeavesDefaultsAndAchievementsUntouched (#1197 part
// B): an old bundle has neither the `shot_defaults` kv key nor an
// `achievements` array, so the backward-compatible reader must leave the
// target's own values alone.
func TestRestore_LegacyBackup_LeavesDefaultsAndAchievementsUntouched(t *testing.T) {
	useImageDir(t)
	zipBytes, err := os.ReadFile(filepath.Join("testdata", "legacy-backup.zip"))
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}

	h, deps, _ := newTestHandlersInDir(t)
	if err := deps.ShotsRepo.SaveShotDefaults(map[string]any{"coffee": "Local Only", "grinder": "Local Grinder"}); err != nil {
		t.Fatalf("seeding defaults: %v", err)
	}
	unlockedAt := int64(1_600_000_000)
	if err := deps.AchievementsRepo.ReplaceAll([]achievements.Row{
		{ID: "local_badge", UnlockedAt: &unlockedAt, Progress: nil},
	}); err != nil {
		t.Fatalf("seeding achievement: %v", err)
	}

	rr := doZip(t, newMux(h), "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	defaults, err := deps.ShotsRepo.GetShotDefaults()
	if err != nil {
		t.Fatalf("GetShotDefaults: %v", err)
	}
	if defaults["coffee"] != "Local Only" {
		t.Errorf("legacy restore clobbered shot defaults: %+v", defaults)
	}
	ach, err := deps.AchievementsRepo.GetAll()
	if err != nil {
		t.Fatalf("achievements GetAll: %v", err)
	}
	if row, ok := ach["local_badge"]; !ok || row.UnlockedAt == nil || *row.UnlockedAt != unlockedAt {
		t.Errorf("legacy restore clobbered achievements: %+v", ach)
	}
}

// TestRestore_AchievementsSkipsBadEntries (#1197 part B): unusable entries in
// a restored `achievements` array are skipped individually, the valid ones
// still land, and a NULL field stays NULL.
func TestRestore_AchievementsSkipsBadEntries(t *testing.T) {
	useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)
	seedShot(t, deps1, 1)
	rec := doJSON(t, newMux(h1), http.MethodGet, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d", rec.Code)
	}
	var bundle map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &bundle); err != nil {
		t.Fatalf("parsing export: %v", err)
	}
	bundle["achievements"] = []any{
		map[string]any{"id": "good_one", "unlockedAt": 1700000000, "progress": nil},
		map[string]any{"id": "good_nil_fields"},
		map[string]any{"id": "", "unlockedAt": 1700000000},
		map[string]any{"id": "bad_negative", "progress": -1},
		map[string]any{"id": "bad_float", "unlockedAt": 1.5},
		map[string]any{"id": "bad_type", "progress": "x"},
	}
	body := mustMarshal(t, bundle)

	h2, deps2, _ := newTestHandlersInDir(t)
	rr := doJSON(t, newMux(h2), http.MethodPost, "/api/restore", body)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	ach, err := deps2.AchievementsRepo.GetAll()
	if err != nil {
		t.Fatalf("achievements GetAll: %v", err)
	}
	if row, ok := ach["good_one"]; !ok || row.UnlockedAt == nil || *row.UnlockedAt != 1700000000 {
		t.Errorf("good achievement lost: %+v", ach)
	}
	if row, ok := ach["good_nil_fields"]; !ok || row.UnlockedAt != nil || row.Progress != nil {
		t.Errorf("nil-field achievement not restored as NULL: %+v", ach)
	}
	for _, bad := range []string{"", "bad_negative", "bad_float", "bad_type"} {
		if _, ok := ach[bad]; ok {
			t.Errorf("bad achievement %q was restored: %+v", bad, ach)
		}
	}
}

// TestStreamRoundTrip_UIPrefs (#1375): a stored ui_prefs object survives a
// backup and restore into a fresh install.
func TestStreamRoundTrip_UIPrefs(t *testing.T) {
	useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)
	seedShot(t, deps1, 1)
	if err := uiprefs.NewRepository(deps1.DB).Save(map[string]any{"view": "shelf", "sort": "name"}); err != nil {
		t.Fatalf("seeding ui_prefs: %v", err)
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
	prefs, err := uiprefs.NewRepository(deps2.DB).Get()
	if err != nil {
		t.Fatalf("Get ui_prefs: %v", err)
	}
	if prefs["view"] != "shelf" || prefs["sort"] != "name" {
		t.Errorf("ui_prefs not restored: %+v", prefs)
	}
}

// TestRestore_LegacyBackup_LeavesUIPrefsUntouched (#1375): an old bundle has
// no ui_prefs key, so the target's own prefs stay put.
func TestRestore_LegacyBackup_LeavesUIPrefsUntouched(t *testing.T) {
	useImageDir(t)
	zipBytes, err := os.ReadFile(filepath.Join("testdata", "legacy-backup.zip"))
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}
	h, deps, _ := newTestHandlersInDir(t)
	if err := uiprefs.NewRepository(deps.DB).Save(map[string]any{"view": "local-only"}); err != nil {
		t.Fatalf("seeding ui_prefs: %v", err)
	}
	rr := doZip(t, newMux(h), "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}
	prefs, err := uiprefs.NewRepository(deps.DB).Get()
	if err != nil {
		t.Fatalf("Get ui_prefs: %v", err)
	}
	if prefs["view"] != "local-only" {
		t.Errorf("legacy restore clobbered ui_prefs: %+v", prefs)
	}
}

// latin1HeaderValue renders s the way a browser would place it in a header
// value: each rune up to U+00FF becomes its single ISO-8859-1 byte, and a
// rune above that (e.g. €) is replaced — exactly the corruption the legacy
// X-GLP-Passphrase header suffers, since a header value can only carry
// ISO-8859-1 bytes.
func latin1HeaderValue(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r > 0xFF {
			b.WriteByte('?')
			continue
		}
		b.WriteByte(byte(r))
	}
	return b.String()
}

// TestRestore_ZipPassphraseUTF8Header (#1602): a backup protected by a
// passphrase with umlauts and € round-trips through a zip restore only when
// the passphrase arrives base64-encoded as its UTF-8 bytes
// (X-GLP-Passphrase-B64). The same backup with the legacy ISO-8859-1
// X-GLP-Passphrase header cannot decrypt the secrets — the old bug the base64
// header fixes.
func TestRestore_ZipPassphraseUTF8Header(t *testing.T) {
	useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)
	seedShot(t, deps1, 42)

	const passphrase = "Kaffeebohnenäöü€"
	recExp := doJSON(t, newMux(h1), http.MethodPost, "/api/backup", mustMarshal(t, map[string]any{"passphrase": passphrase}))
	if recExp.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", recExp.Code, recExp.Body.String())
	}
	zipBytes := append([]byte(nil), recExp.Body.Bytes()...)

	// Standard base64 of the passphrase's UTF-8 bytes — what postRestore now
	// sends in X-GLP-Passphrase-B64.
	b64 := base64.StdEncoding.EncodeToString([]byte(passphrase))

	h2, _, _ := newTestHandlersInDir(t)
	rr := doZip(t, newMux(h2), "/api/restore", zipBytes, map[string]string{"X-GLP-Passphrase-B64": b64})
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}
	result := decodeBody(t, rr.Body.Bytes())
	if result["secretsPresent"] != true || result["secretsRestored"] != true {
		t.Errorf("base64 header: secrets = %+v; want present and restored", result)
	}

	// The legacy header carries the passphrase's Latin-1 bytes, so the derived
	// key differs from the export key and decryption fails — the secrets are
	// present but not restored (the pre-#1602 behaviour).
	h3, _, _ := newTestHandlersInDir(t)
	rr = doZip(t, newMux(h3), "/api/restore", zipBytes, map[string]string{"X-GLP-Passphrase": latin1HeaderValue(passphrase)})
	if rr.Code != http.StatusOK {
		t.Fatalf("legacy-header restore status = %d; body=%s", rr.Code, rr.Body.String())
	}
	result = decodeBody(t, rr.Body.Bytes())
	if result["secretsPresent"] != true || result["secretsRestored"] != false {
		t.Errorf("legacy header: secrets = %+v; want present but NOT restored", result)
	}
}

// TestRestore_InvalidBase64PassphraseHeader400 (#1602): a malformed
// X-GLP-Passphrase-B64 value is a client error, not silently ignored (which
// would look like a wrong passphrase).
func TestRestore_InvalidBase64PassphraseHeader400(t *testing.T) {
	useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)
	seedShot(t, deps1, 1)
	recExp := doJSON(t, newMux(h1), http.MethodPost, "/api/backup", nil)
	if recExp.Code != http.StatusOK {
		t.Fatalf("export status = %d", recExp.Code)
	}
	zipBytes := append([]byte(nil), recExp.Body.Bytes()...)

	h2, _, _ := newTestHandlersInDir(t)
	rr := doZip(t, newMux(h2), "/api/restore", zipBytes, map[string]string{"X-GLP-Passphrase-B64": "!!!not-base64!!!"})
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d; want 400; body=%s", rr.Code, rr.Body.String())
	}
}

// TestRestore_ReportsImagesThatCouldNotBeWritten (#1602): when the restore
// queue holds two images but only one can be written to disk, the response
// reports images = 1 (written) and imagesFailed = 1 instead of counting both
// as restored. A directory standing in for one target path makes the write
// fail the way a full disk or a permission error would.
func TestRestore_ReportsImagesThatCouldNotBeWritten(t *testing.T) {
	srcDir := useImageDir(t)
	jpg := tinyJPEG(t, 48, 36)
	for _, name := range []string{"1.jpg", "2.jpg"} {
		if err := os.WriteFile(filepath.Join(srcDir, name), jpg, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	h1, deps1, _ := newTestHandlers(t)
	if err := deps1.LibRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{
			{"id": int64(1), "name": "Writable Bean", "stock_g": float64(100), "image": "jpg"},
			{"id": int64(2), "name": "Unwritable Bean", "stock_g": float64(100), "image": "jpg"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	recExp := doJSON(t, newMux(h1), http.MethodPost, "/api/backup", nil)
	if recExp.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", recExp.Code, recExp.Body.String())
	}
	zipBytes := append([]byte(nil), recExp.Body.Bytes()...)

	// Restore into a fresh target directory whose second image path is a
	// directory, so os.WriteFile fails for it (as it would on a full disk or a
	// permission error) while the first writes fine. The source bytes still live
	// in the backup zip, so pass-1 validation is unaffected.
	dstDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dstDir, "2.jpg"), 0o755); err != nil {
		t.Fatal(err)
	}
	useImageDirAt(t, dstDir)

	h2, _, _ := newTestHandlersInDir(t)
	rr := doZip(t, newMux(h2), "/api/restore", zipBytes, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}
	result := decodeBody(t, rr.Body.Bytes())
	if got, _ := result["images"].(float64); got != 1 {
		t.Errorf("images = %v; want 1 (only the writable image)", result["images"])
	}
	if got, _ := result["imagesFailed"].(float64); got != 1 {
		t.Errorf("imagesFailed = %v; want 1 (the unwritable image)", result["imagesFailed"])
	}
	if _, err := os.Stat(filepath.Join(dstDir, "1.jpg")); err != nil {
		t.Errorf("image that could be written is missing from the target dir: %v", err)
	}
}
