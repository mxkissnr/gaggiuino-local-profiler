package img

import (
	"bytes"
	"encoding/binary"
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
	// Marker segments parse cleanly but the forged SOF declares dimensions over
	// the decode cap, so Optimize bails before decoding; with no APP1/APP13
	// present the stored bytes are exactly the input.
	corrupt := forgedSOFJPEG(t, 0xFFFF, 0xFFFF, false)

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

// TestSave_JPEGFallbackStripsMetadata guards the #1617 privacy fix: when a
// JPEG cannot be optimised (here the forged SOF exceeds the decode pixel cap)
// the fallback must not store the original APP1 EXIF/GPS block.
func TestSave_JPEGFallbackStripsMetadata(t *testing.T) {
	dir := t.TempDir()
	withExif := forgedSOFJPEG(t, 0xFFFF, 0xFFFF, true)
	if !bytes.Contains(withExif, []byte("Exif")) {
		t.Fatal("fixture is missing its EXIF segment")
	}

	if ext, ok := Save(dir, "", 7, withExif, "image/jpeg", ModeUpload); !ok || ext != "jpg" {
		t.Fatalf("Save = %q, %v; want jpg, true", ext, ok)
	}
	got, err := os.ReadFile(filepath.Join(dir, "7.jpg"))
	if err != nil {
		t.Fatalf("main not written: %v", err)
	}
	if bytes.Contains(got, []byte("Exif")) {
		t.Error("fallback stored the APP1 EXIF segment")
	}
}

// TestSave_MalformedJPEGRejected: a JPEG whose marker stream does not parse
// cannot be stripped safely, so Save rejects the upload instead of storing
// attacker-controlled metadata verbatim.
func TestSave_MalformedJPEGRejected(t *testing.T) {
	dir := t.TempDir()
	malformed := append([]byte{0xFF, 0xD8, 0xFF}, bytes.Repeat([]byte{0x11}, 64)...)

	if ext, ok := Save(dir, "grinder-", 7, malformed, "image/jpeg", ModeUpload); ok || ext != "" {
		t.Fatalf("Save = %q, %v; want \"\", false (unparseable JPEG)", ext, ok)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("rejected upload still wrote %d file(s)", len(entries))
	}
}

// TestSave_FallbackClearsStaleThumb guards the #1617 stale-thumbnail fix: a
// second upload of the same extension that produces no thumbnail must remove
// the previous one, so ServePath serves the new full image.
func TestSave_FallbackClearsStaleThumb(t *testing.T) {
	dir := t.TempDir()
	if _, ok := Save(dir, "", 7, encodeJPEG(t, gradientRGBA(600, 400)), "image/jpeg", ModeUpload); !ok {
		t.Fatal("first save failed")
	}
	thumb := filepath.Join(dir, "7.thumb.jpg")
	if _, err := os.Stat(thumb); err != nil {
		t.Fatalf("thumbnail not created: %v", err)
	}

	if _, ok := Save(dir, "", 7, forgedSOFJPEG(t, 0xFFFF, 0xFFFF, false), "image/jpeg", ModeUpload); !ok {
		t.Fatal("fallback save failed")
	}
	if _, err := os.Stat(thumb); !os.IsNotExist(err) {
		t.Errorf("stale thumbnail survived the fallback, stat err = %v", err)
	}
}

// forgedSOFJPEG builds a JPEG whose marker segments are well-formed but whose
// SOF0 declares w×h — enough to exceed the decode pixel cap without allocating
// a full image. When withExif is set an APP1 EXIF/GPS segment is spliced right
// after SOI.
func forgedSOFJPEG(t testing.TB, w, h uint16, withExif bool) []byte {
	t.Helper()
	out := []byte{0xFF, 0xD8} // SOI
	if withExif {
		out = append(out, exifApp1()...)
	}
	// SOF0 marker, length 11, 8-bit precision, height, width, one component.
	out = append(out,
		0xFF, 0xC0, 0x00, 0x0B,
		0x08,
		byte(h>>8), byte(h),
		byte(w>>8), byte(w),
		0x01, 0x01, 0x11, 0x00,
	)
	out = append(out, 0xFF, 0xD9) // EOI
	return out
}

// exifApp1 returns a complete APP1 marker segment carrying an EXIF block (TIFF,
// big-endian) with an Orientation tag and a GPS IFD pointer — a location-
// carrying segment the fallback path must drop. It is not a full JPEG; the
// caller splices it in.
func exifApp1() []byte {
	var tiff bytes.Buffer
	tiff.WriteString("MM")
	binary.Write(&tiff, binary.BigEndian, uint16(0x002A))
	binary.Write(&tiff, binary.BigEndian, uint32(8))
	binary.Write(&tiff, binary.BigEndian, uint16(2))
	binary.Write(&tiff, binary.BigEndian, uint16(0x0112))
	binary.Write(&tiff, binary.BigEndian, uint16(3))
	binary.Write(&tiff, binary.BigEndian, uint32(1))
	binary.Write(&tiff, binary.BigEndian, uint16(6))
	binary.Write(&tiff, binary.BigEndian, uint16(0))
	binary.Write(&tiff, binary.BigEndian, uint16(0x8825))
	binary.Write(&tiff, binary.BigEndian, uint16(4))
	binary.Write(&tiff, binary.BigEndian, uint32(1))
	binary.Write(&tiff, binary.BigEndian, uint32(38))
	binary.Write(&tiff, binary.BigEndian, uint32(0))

	payload := append([]byte("Exif\x00\x00"), tiff.Bytes()...)
	app1 := []byte{0xFF, 0xE1, 0x00, 0x00}
	binary.BigEndian.PutUint16(app1[2:], uint16(len(payload)+2))
	return append(app1, payload...)
}
