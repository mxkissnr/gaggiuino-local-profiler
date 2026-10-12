package backup

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestBackup_BundlesReferencedImagesOnly (#1525): the zip carries every image
// a library entry or existing shot (trashed included) refers to, and skips
// app-named files no entry refers to. The three referenced photos are bean 1,
// live shot 42 and trashed shot 43; "99.jpg", "grinder-7.png" and "shot-99.jpg"
// are app-named orphans that must be left out.
func TestBackup_BundlesReferencedImagesOnly(t *testing.T) {
	imgDir := useImageDir(t)
	write := func(name string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(imgDir, name), []byte{0x01, 0x02, 0x03, 0x04}, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"1.jpg", "shot-42.png", "shot-43.jpg", "99.jpg", "grinder-7.png", "shot-99.jpg"} {
		write(name)
	}

	h, deps, _ := newTestHandlers(t)
	if err := deps.LibRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(1), "name": "B", "image": "jpg"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := deps.ShotsRepo.Upsert(shots.Shot{
		"id": int64(42), "timestamp": int64(1), "duration": int64(1),
		"profileName": "p", "machineId": int64(1), "image": "png",
	}); err != nil {
		t.Fatal(err)
	}
	if err := deps.ShotsRepo.Upsert(shots.Shot{
		"id": int64(43), "timestamp": int64(2), "duration": int64(1),
		"profileName": "p", "machineId": int64(1), "image": "jpg",
	}); err != nil {
		t.Fatal(err)
	}
	if err := deps.ShotsRepo.SetTrashEntry(43, 1234567); err != nil {
		t.Fatal(err)
	}

	rec := doJSON(t, newMux(h), http.MethodPost, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	names, err := zipReaderFromBytes(rec.Body.Bytes())
	if err != nil {
		t.Fatalf("reading zip: %v", err)
	}
	got := make(map[string]bool, len(names))
	for _, n := range names {
		got[n] = true
	}
	for _, want := range []string{"images/1.jpg", "images/shot-42.png", "images/shot-43.jpg"} {
		if !got[want] {
			t.Errorf("referenced image %q missing from backup; entries=%v", want, names)
		}
	}
	for _, unwanted := range []string{"images/99.jpg", "images/grinder-7.png", "images/shot-99.jpg"} {
		if got[unwanted] {
			t.Errorf("orphaned image %q bundled into backup; entries=%v", unwanted, names)
		}
	}
}

// TestBundledImageEntries (#1602): the single image walk every export path now
// shares returns the referenced image and reports the unreferenced app-named
// file as skipped — its ".thumb." sibling and a subdirectory are neither
// bundled nor counted.
func TestBundledImageEntries(t *testing.T) {
	dir := useImageDir(t)
	for _, name := range []string{"1.jpg", "99.jpg", "99.thumb.jpg"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte{0x01, 0x02, 0x03, 0x04}, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	entries, skipped, err := bundledImageEntries(map[string]struct{}{"1.jpg": {}})
	if err != nil {
		t.Fatalf("bundledImageEntries: %v", err)
	}
	if skipped != 1 {
		t.Errorf("skipped = %d; want 1", skipped)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 1 || names[0] != "1.jpg" {
		t.Errorf("bundled entries = %v; want [1.jpg]", names)
	}

	// A nil set means the reference lookup failed: every app-named file must
	// still be bundled, so a transient DB error never drops a photo.
	all, _, err := bundledImageEntries(nil)
	if err != nil {
		t.Fatalf("bundledImageEntries(nil): %v", err)
	}
	if len(all) != 2 {
		t.Errorf("nil referenced bundled %d entries; want 2 (1.jpg, 99.jpg)", len(all))
	}
}

// TestRemoveUnreferencedImages (#1525): app-named orphans are removed with
// their thumbnails, a referenced image and its thumbnail stay, and a foreign
// file name (or a directory) is never touched.
func TestRemoveUnreferencedImages(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, n int) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), bytes.Repeat([]byte{0x7f}, n), 0o644); err != nil {
			t.Fatal(err)
		}
		// Age past orphanGracePeriod so the sweep treats these as established
		// orphans, not fresh uploads (see the grace-period test below).
		old := time.Now().Add(-11 * time.Minute)
		if err := os.Chtimes(filepath.Join(dir, name), old, old); err != nil {
			t.Fatal(err)
		}
	}
	// 1.jpg / 1.thumb.jpg are referenced; the rest are orphans or foreign.
	write("1.jpg", 10)
	write("1.thumb.jpg", 3)
	write("2.jpg", 20)
	write("2.thumb.jpg", 4)
	write("grinder-3.png", 30)
	write("grinder-3.thumb.png", 5)
	write("notes.txt", 7)
	write("1.txt", 9)
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}

	removed, freed := removeUnreferencedImages(dir, map[string]struct{}{"1.jpg": {}}, t.Logf)
	if removed != 4 || freed != 20+4+30+5 {
		t.Errorf("removed=%d freed=%d; want 4 and %d", removed, freed, 20+4+30+5)
	}
	for _, keep := range []string{"1.jpg", "1.thumb.jpg", "notes.txt", "1.txt", "sub"} {
		if _, err := os.Stat(filepath.Join(dir, keep)); err != nil {
			t.Errorf("%q should have been kept: %v", keep, err)
		}
	}
	for _, gone := range []string{"2.jpg", "2.thumb.jpg", "grinder-3.png", "grinder-3.thumb.png"} {
		if _, err := os.Stat(filepath.Join(dir, gone)); !os.IsNotExist(err) {
			t.Errorf("%q should have been removed (err=%v)", gone, err)
		}
	}
}

// TestCleanupOrphanedImages_BuildsSetFromDB (#1525): with a real DB, a photo a
// bean still refers to survives while an app-named orphan is deleted.
func TestCleanupOrphanedImages_BuildsSetFromDB(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().Add(-11 * time.Minute)
	for _, name := range []string{"1.jpg", "1.thumb.jpg", "2.jpg"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte{0x01}, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}
	_, deps, _ := newTestHandlers(t)
	if err := deps.LibRepo.SaveLibrary(library.Library{
		Beans: []library.Entity{{"id": int64(1), "name": "B", "image": "jpg"}},
	}); err != nil {
		t.Fatal(err)
	}

	CleanupOrphanedImages(dir, deps.LibRepo, deps.ShotsRepo, t.Logf)

	for _, keep := range []string{"1.jpg", "1.thumb.jpg"} {
		if _, err := os.Stat(filepath.Join(dir, keep)); err != nil {
			t.Errorf("%q should have been kept: %v", keep, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "2.jpg")); !os.IsNotExist(err) {
		t.Errorf("orphaned 2.jpg should have been removed (err=%v)", err)
	}
}

// TestCleanupOrphanedImages_ReferenceLookupFailureRemovesNothing (#1525): if
// the referenced set cannot be built (here the DB is closed), the sweep must
// remove nothing at all.
func TestCleanupOrphanedImages_ReferenceLookupFailureRemovesNothing(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "2.jpg"), []byte{0x01}, 0o644); err != nil {
		t.Fatal(err)
	}
	_, deps, sqlDB := newTestHandlers(t)
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}

	CleanupOrphanedImages(dir, deps.LibRepo, deps.ShotsRepo, t.Logf)

	if _, err := os.Stat(filepath.Join(dir, "2.jpg")); err != nil {
		t.Errorf("a failed reference lookup must remove nothing, but 2.jpg is gone: %v", err)
	}
}

// TestRemoveUnreferencedImages_GracePeriod (#1603): an unreferenced app-named
// image written just now is kept, because an upload writes the file before the
// entry row that refers to it is saved; the same file aged past
// orphanGracePeriod is removed.
func TestRemoveUnreferencedImages_GracePeriod(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "2.jpg")
	if err := os.WriteFile(path, []byte{0x01}, 0o644); err != nil {
		t.Fatal(err)
	}
	if removed, _ := removeUnreferencedImages(dir, map[string]struct{}{}, t.Logf); removed != 0 {
		t.Fatalf("removed = %d, want 0 (a fresh orphan is inside the grace period)", removed)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("fresh orphan must be kept: %v", err)
	}

	old := time.Now().Add(-11 * time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if removed, _ := removeUnreferencedImages(dir, map[string]struct{}{}, t.Logf); removed != 1 {
		t.Fatalf("removed = %d, want 1 (an expired orphan must be removed)", removed)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expired orphan must be removed (err=%v)", err)
	}
}
