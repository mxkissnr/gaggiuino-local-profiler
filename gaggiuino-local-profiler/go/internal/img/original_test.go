package img

import (
	"bytes"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// TestParseCropValid covers the "x,y,w,h" parser and the range check,
// including the pixel-rounding tolerance on the far edge.
func TestParseCropValid(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		parse bool
		valid bool
	}{
		{"full frame", "0,0,1,1", true, true},
		{"half", "0.5,0,0.5,1", true, true},
		{"whitespace", " 0 , 0.1 , 0.5 , 0.5 ", true, true},
		{"edge within tolerance", "0.4005,0,0.6,1", true, true},
		{"edge past tolerance", "0.402,0,0.6,1", true, false},
		{"x+w past tolerance", "0.5,0,0.6,1", true, false},
		{"negative x", "-0.1,0,0.5,0.5", true, false},
		{"negative y", "0,-0.1,0.5,0.5", true, false},
		{"zero width", "0,0,0,0.5", true, false},
		{"zero height", "0,0,0.5,0", true, false},
		{"negative width", "0,0,-0.5,0.5", true, false},
		{"width above one", "0,0,1.5,0.5", true, false},
		{"NaN", "NaN,0,0.5,0.5", false, false},
		{"Inf", "0,Inf,0.5,0.5", false, false},
		{"negative Inf", "0,0,-Inf,0.5", false, false},
		{"three values", "0,0,1", false, false},
		{"five values", "0,0,1,1,1", false, false},
		{"not a number", "a,0,1,1", false, false},
		{"empty", "", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, err := ParseCrop(tc.in)
			if tc.parse {
				if err != nil {
					t.Fatalf("ParseCrop(%q) error: %v", tc.in, err)
				}
				if got := c.Valid(); got != tc.valid {
					t.Errorf("ParseCrop(%q).Valid() = %v; want %v (%+v)", tc.in, got, tc.valid, c)
				}
				return
			}
			if err == nil {
				t.Fatalf("ParseCrop(%q) = %+v; want an error", tc.in, c)
			}
		})
	}
}

// TestParseCropRoundTrip pins that each component lands in its field.
func TestParseCropRoundTrip(t *testing.T) {
	c, err := ParseCrop("0.1,0.2,0.3,0.4")
	if err != nil {
		t.Fatal(err)
	}
	want := Crop{X: 0.1, Y: 0.2, W: 0.3, H: 0.4}
	if math.Abs(c.X-want.X) > 1e-9 || math.Abs(c.Y-want.Y) > 1e-9 ||
		math.Abs(c.W-want.W) > 1e-9 || math.Abs(c.H-want.H) > 1e-9 {
		t.Errorf("ParseCrop = %+v; want %+v", c, want)
	}
}

// TestWriteOriginal_Rejects covers every accepted-input guard: only a
// magic-valid JPEG within MaxBytes reaches the disk.
func TestWriteOriginal_Rejects(t *testing.T) {
	dir := t.TempDir()
	pngBytes := encodePNG(t, gradientRGBA(20, 20))
	oversize := append([]byte{0xFF, 0xD8, 0xFF}, bytes.Repeat([]byte{0x00}, MaxBytes)...)
	notJPEG := append([]byte{0x00, 0x01, 0x02}, bytes.Repeat([]byte{0x00}, 64)...)

	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"png bytes", pngBytes},
		{"oversize", oversize},
		{"foreign magic", notJPEG},
		{"empty", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := WriteOriginal(dir, "shot-", 7, tc.data); err == nil {
				t.Fatalf("WriteOriginal accepted %s", tc.name)
			}
			if _, err := os.Stat(OriginalPath(dir, 7, "shot-")); !os.IsNotExist(err) {
				t.Errorf("a rejected original must not be written (err=%v)", err)
			}
		})
	}
}

// TestWriteOriginal_StripsMetadataAndRoundTrips pins that an EXIF APP1
// segment never reaches the stored original, and that ReadOriginal returns
// exactly what was written.
func TestWriteOriginal_StripsMetadataAndRoundTrips(t *testing.T) {
	dir := t.TempDir()
	data := jpegWithOrientation(t, gradientRGBA(120, 80), 6)
	if !bytes.Contains(data, []byte("Exif\x00\x00")) {
		t.Fatal("fixture is missing its EXIF segment")
	}

	if err := WriteOriginal(dir, "grinder-", 3, data); err != nil {
		t.Fatalf("WriteOriginal: %v", err)
	}

	stored, err := os.ReadFile(OriginalPath(dir, 3, "grinder-"))
	if err != nil {
		t.Fatalf("reading stored original: %v", err)
	}
	if bytes.Contains(stored, []byte("Exif\x00\x00")) {
		t.Error("stored original still carries its EXIF segment")
	}
	if w, h := decodeSize(t, stored); w != 120 || h != 80 {
		t.Errorf("stored original is %dx%d; want 120x80", w, h)
	}
	if _, err := os.Stat(ThumbPath(dir, 3, "jpg", "grinder-")); !os.IsNotExist(err) {
		t.Error("WriteOriginal must never write a thumbnail")
	}

	got, err := ReadOriginal(dir, "grinder-", 3)
	if err != nil {
		t.Fatalf("ReadOriginal: %v", err)
	}
	if !bytes.Equal(got, stored) {
		t.Error("ReadOriginal did not round-trip the stored bytes")
	}

	if _, err := ReadOriginal(dir, "grinder-", 4); !os.IsNotExist(err) {
		t.Errorf("ReadOriginal of a missing file error = %v; want os.ErrNotExist", err)
	}
}

// TestCropJPEG_HalfWidth is the plan's worked example: the right half of a
// 100x50 image is a 50x50 square.
func TestCropJPEG_HalfWidth(t *testing.T) {
	original := encodeJPEG(t, gradientRGBA(100, 50))
	out, err := CropJPEG(original, Crop{X: 0.5, Y: 0, W: 0.5, H: 1})
	if err != nil {
		t.Fatalf("CropJPEG: %v", err)
	}
	if w, h := decodeSize(t, out); w != 50 || h != 50 {
		t.Errorf("cropped size = %dx%d; want 50x50", w, h)
	}
}

// TestCropJPEG_ClampsDegenerateRect pins the min-1x1 floor at the far edge.
func TestCropJPEG_ClampsDegenerateRect(t *testing.T) {
	original := encodeJPEG(t, gradientRGBA(40, 30))
	out, err := CropJPEG(original, Crop{X: 1, Y: 1, W: 0.0001, H: 0.0001})
	if err != nil {
		t.Fatalf("CropJPEG: %v", err)
	}
	if w, h := decodeSize(t, out); w != 1 || h != 1 {
		t.Errorf("cropped size = %dx%d; want 1x1", w, h)
	}
}

// TestCropJPEG_RejectsInvalid: an out-of-range rectangle never reaches the
// decoder.
func TestCropJPEG_RejectsInvalid(t *testing.T) {
	original := encodeJPEG(t, gradientRGBA(40, 30))
	if _, err := CropJPEG(original, Crop{X: 0, Y: 0, W: 0, H: 1}); err == nil {
		t.Error("CropJPEG accepted a zero-width rect")
	}
}

// TestDelete_RemovesOriginal pins that the full-delete path takes the
// uncropped original with it, while DeleteMain leaves it behind for a later
// re-crop.
func TestDelete_RemovesOriginal(t *testing.T) {
	dir := t.TempDir()
	writeAll := func() {
		t.Helper()
		for _, p := range []string{
			Path(dir, 7, "jpg", "shot-"),
			ThumbPath(dir, 7, "jpg", "shot-"),
			OriginalPath(dir, 7, "shot-"),
		} {
			if err := os.WriteFile(p, []byte{0x01}, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}

	writeAll()
	Delete(dir, 7, "jpg", "shot-")
	for _, p := range []string{
		Path(dir, 7, "jpg", "shot-"),
		ThumbPath(dir, 7, "jpg", "shot-"),
		OriginalPath(dir, 7, "shot-"),
	} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s should have been removed (err=%v)", p, err)
		}
	}

	writeAll()
	DeleteMain(dir, 7, "jpg", "shot-")
	for _, p := range []string{
		Path(dir, 7, "jpg", "shot-"),
		ThumbPath(dir, 7, "jpg", "shot-"),
	} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s should have been removed (err=%v)", p, err)
		}
	}
	if _, err := os.Stat(OriginalPath(dir, 7, "shot-")); err != nil {
		t.Errorf("DeleteMain must keep the original: %v", err)
	}
}

// TestKnownImageName_Originals pins the name classification the orphan sweep
// and the backup filter rely on: an original is an app file, an original with
// any other extension is not, and no original is ever mistaken for a main
// image.
func TestKnownImageName_Originals(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"shot-7.orig.jpg", true},
		{"7.orig.jpg", true},
		{"grinder-7.orig.jpg", true},
		{"shot-7.orig.png", false},
		{"shot-7.orig.webp", false},
		{"shot-7.orig", false},
		{"shot-.orig.jpg", false},
		{"shot-7.orig.jpg.tmp", false},
		{"notes.orig.jpg", false},
		{"shot-7.jpg", true},
		{"shot-7.thumb.jpg", false},
	}
	for _, tc := range cases {
		if got := KnownImageName(tc.name); got != tc.ok {
			t.Errorf("KnownImageName(%q) = %v; want %v", tc.name, got, tc.ok)
		}
	}

	if _, _, _, ok := parseImageName("shot-7.orig.jpg"); ok {
		t.Error("parseImageName accepted an original")
	}
	if id, prefix, ok := parseOriginalName("grinder-12.orig.jpg"); !ok || id != 12 || prefix != "grinder-" {
		t.Errorf("parseOriginalName(grinder-12.orig.jpg) = %d, %q, %v", id, prefix, ok)
	}
	if got := FullImageName("shot-7.orig.jpg"); got != "shot-7.orig.jpg" {
		t.Errorf("FullImageName changed an original name to %q", got)
	}
}

// TestMigrateExisting_LeavesOriginalsAlone pins that the #961 downscale sweep
// never touches an original: it must keep its bytes and get no thumbnail,
// even when it is larger than MaxEdge.
func TestMigrateExisting_LeavesOriginalsAlone(t *testing.T) {
	dir := t.TempDir()
	bigJPEG := encodeJPEG(t, gradientRGBA(1700, 1300))
	name := "shot-9.orig.jpg"
	if err := os.WriteFile(filepath.Join(dir, name), bigJPEG, 0o644); err != nil {
		t.Fatal(err)
	}

	MigrateExisting(dir,
		func() (bool, error) { return false, nil },
		func() error { return nil },
		func(string, ...any) {},
	)

	got, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, bigJPEG) {
		t.Error("MigrateExisting rewrote an original")
	}
	if _, err := os.Stat(filepath.Join(dir, "shot-9.orig.thumb.jpg")); !os.IsNotExist(err) {
		t.Error("MigrateExisting created a thumbnail for an original")
	}
}
