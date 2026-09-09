package img

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestSave_WritesMainAndThumb(t *testing.T) {
	dir := t.TempDir()
	in := encodeJPEG(t, gradientRGBA(1700, 1300))

	ext, ok := Save(dir, "grinder-", 7, in, "image/jpeg", ModeUpload)
	if !ok || ext != "jpg" {
		t.Fatalf("Save = %q, %v; want jpg, true", ext, ok)
	}

	main := filepath.Join(dir, "grinder-7.jpg")
	thumb := filepath.Join(dir, "grinder-7.thumb.jpg")
	mi, err := os.Stat(main)
	if err != nil {
		t.Fatalf("main not written: %v", err)
	}
	if _, err := os.Stat(thumb); err != nil {
		t.Fatalf("thumb not written: %v", err)
	}
	if mi.Size() >= int64(len(in)) {
		t.Errorf("main %d bytes not smaller than input %d", mi.Size(), len(in))
	}
}

func TestSave_ConvertsWebPAndCleansOldExt(t *testing.T) {
	dir := t.TempDir()
	in, err := os.ReadFile("testdata/sample.webp")
	if err != nil {
		t.Fatal(err)
	}
	ext, ok := Save(dir, "", 3, in, "image/webp", ModeUpload)
	if !ok || ext != "jpg" {
		t.Fatalf("Save = %q, %v; want jpg, true", ext, ok)
	}
	if _, err := os.Stat(filepath.Join(dir, "3.jpg")); err != nil {
		t.Errorf("converted main missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "3.webp")); !os.IsNotExist(err) {
		t.Errorf("source-ext file should have been removed, stat err = %v", err)
	}
}

func TestSave_CorruptFallsBackToRaw(t *testing.T) {
	dir := t.TempDir()
	corrupt := append([]byte{0xFF, 0xD8, 0xFF}, bytes.Repeat([]byte{0x11}, 64)...)

	ext, ok := Save(dir, "grinder-", 7, corrupt, "image/jpeg", ModeUpload)
	if !ok || ext != "jpg" {
		t.Fatalf("Save = %q, %v; want jpg, true", ext, ok)
	}
	got, err := os.ReadFile(filepath.Join(dir, "grinder-7.jpg"))
	if err != nil {
		t.Fatalf("main not written: %v", err)
	}
	if !bytes.Equal(got, corrupt) {
		t.Error("raw fallback did not store the original bytes verbatim")
	}
	if _, err := os.Stat(filepath.Join(dir, "grinder-7.thumb.jpg")); !os.IsNotExist(err) {
		t.Errorf("no thumbnail expected on fallback, stat err = %v", err)
	}
}

func TestSave_DecompressionBombStoredRaw(t *testing.T) {
	dir := t.TempDir()
	bomb := hugePNG(30000, 30000)

	ext, ok := Save(dir, "", 4, bomb, "image/png", ModeUpload)
	if !ok || ext != "png" {
		t.Fatalf("Save = %q, %v; want png, true (raw fallback)", ext, ok)
	}
	got, err := os.ReadFile(filepath.Join(dir, "4.png"))
	if err != nil {
		t.Fatalf("main not written: %v", err)
	}
	if !bytes.Equal(got, bomb) {
		t.Error("raw fallback did not store the original bytes")
	}
	if _, err := os.Stat(filepath.Join(dir, "4.thumb.png")); !os.IsNotExist(err) {
		t.Errorf("no thumbnail expected for an over-cap image, stat err = %v", err)
	}
}

func TestSave_RejectsBadMagic(t *testing.T) {
	dir := t.TempDir()
	jpegBytes := encodeJPEG(t, gradientRGBA(20, 20))

	if ext, ok := Save(dir, "grinder-", 7, jpegBytes, "image/png", ModeUpload); ok || ext != "" {
		t.Fatalf("Save = %q, %v; want \"\", false (content-type/magic mismatch)", ext, ok)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("rejected upload still wrote %d file(s)", len(entries))
	}
}

func TestWriteOptimized_PreservesExtAddsThumb(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "5.jpg")
	in := jpegWithOrientation(t, gradientRGBA(1700, 1300), 1)

	ext, err := WriteOptimized(path, in, "jpg")
	if err != nil || ext != "jpg" {
		t.Fatalf("WriteOptimized = %q, %v; want jpg, nil", ext, err)
	}
	main, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("main missing: %v", err)
	}
	if bytes.Contains(main, []byte("Exif")) {
		t.Error("restored image still carries EXIF")
	}
	if w, h := decodeSize(t, main); longEdge(w, h) != MaxEdge {
		t.Errorf("restored image not downscaled: %dx%d", w, h)
	}
	if _, err := os.Stat(filepath.Join(dir, "5.thumb.jpg")); err != nil {
		t.Errorf("thumb missing: %v", err)
	}
}
