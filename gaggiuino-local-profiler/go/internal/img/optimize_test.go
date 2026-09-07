package img

import (
	"bytes"
	"image"
	"image/color"
	"os"
	"testing"
)

func TestOptimize_DownscalesLargePhoto(t *testing.T) {
	data := encodeJPEG(t, gradientRGBA(1700, 1300))

	res, err := Optimize(data, "jpg", ModeUpload)
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}

	mw, mh := decodeSize(t, res.Main)
	if got := longEdge(mw, mh); got != MaxEdge {
		t.Errorf("main long edge = %d, want %d (got %dx%d)", got, MaxEdge, mw, mh)
	}
	if len(res.Main) >= 300*1024 {
		t.Errorf("main size = %d bytes, want < %d", len(res.Main), 300*1024)
	}
	if len(res.Thumb) == 0 {
		t.Fatal("thumb is empty")
	}
	tw, th := decodeSize(t, res.Thumb)
	if got := longEdge(tw, th); got != ThumbEdge {
		t.Errorf("thumb long edge = %d, want %d (got %dx%d)", got, ThumbEdge, tw, th)
	}
}

func TestOptimize_StripsEXIF(t *testing.T) {
	data := jpegWithOrientation(t, gradientRGBA(200, 150), 1)
	if !bytes.Contains(data, []byte("Exif")) || !bytes.Contains(data, []byte{0xFF, 0xE1}) {
		t.Fatal("fixture is missing its EXIF APP1 segment")
	}

	res, err := Optimize(data, "jpg", ModeUpload)
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	if bytes.Contains(res.Main, []byte{0xFF, 0xE1}) {
		t.Error("output still carries an APP1 (0xFFE1) marker")
	}
	for _, needle := range []string{"Exif", "GPS"} {
		if bytes.Contains(res.Main, []byte(needle)) {
			t.Errorf("output still contains %q", needle)
		}
	}
}

func TestOptimize_OrientationApplied(t *testing.T) {
	// Landscape source (60 wide, 20 tall), top rows red, bottom rows blue.
	src := image.NewRGBA(image.Rect(0, 0, 60, 20))
	for y := 0; y < 20; y++ {
		c := color.RGBA{220, 20, 20, 255}
		if y >= 10 {
			c = color.RGBA{20, 20, 220, 255}
		}
		for x := 0; x < 60; x++ {
			src.Set(x, y, c)
		}
	}
	data := jpegWithOrientation(t, src, 6) // 6 = rotate 90° CW for display

	res, err := Optimize(data, "jpg", ModeUpload)
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	w, h := decodeSize(t, res.Main)
	if w != 20 || h != 60 {
		t.Fatalf("oriented size = %dx%d, want 20x60", w, h)
	}
	out, _, err := image.Decode(bytes.NewReader(res.Main))
	if err != nil {
		t.Fatalf("decode output: %v", err)
	}
	// After a 90° CW rotation the original top edge becomes the right edge.
	r, _, b, _ := out.At(18, 30).RGBA()
	if r <= b {
		t.Errorf("expected red-dominant pixel at right edge, got r=%d b=%d", r>>8, b>>8)
	}
}

func TestOptimize_SmallImageNotUpscaled(t *testing.T) {
	data := encodeJPEG(t, gradientRGBA(100, 80))
	res, err := Optimize(data, "jpg", ModeUpload)
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	if w, h := decodeSize(t, res.Main); w != 100 || h != 80 {
		t.Errorf("main size = %dx%d, want 100x80", w, h)
	}
	if res.Converted {
		t.Error("opaque JPEG upload should not be marked Converted")
	}
}

func TestOptimize_AlphaKeptAsPNG(t *testing.T) {
	im := image.NewNRGBA(image.Rect(0, 0, 40, 40))
	for i := range im.Pix {
		im.Pix[i] = 200
	}
	im.SetNRGBA(0, 0, color.NRGBA{0, 0, 0, 0}) // one transparent pixel
	data := encodePNG(t, im)

	res, err := Optimize(data, "png", ModeUpload)
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	if res.MainExt != "png" {
		t.Fatalf("MainExt = %q, want png", res.MainExt)
	}
	out, _, err := image.Decode(bytes.NewReader(res.Main))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, _, _, a := out.At(0, 0).RGBA(); a != 0 {
		t.Errorf("transparent pixel lost, alpha = %d", a)
	}
}

func TestOptimize_WebPToJPEG(t *testing.T) {
	data, err := os.ReadFile("testdata/sample.webp")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	res, err := Optimize(data, "webp", ModeUpload)
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	if res.MainExt != "jpg" || !res.Converted {
		t.Fatalf("MainExt=%q Converted=%v, want jpg/true", res.MainExt, res.Converted)
	}
	if _, _, err := image.Decode(bytes.NewReader(res.Main)); err != nil {
		t.Errorf("main not decodable: %v", err)
	}
	if len(res.Thumb) == 0 {
		t.Error("thumb missing for webp upload")
	}
}

func TestOptimize_WebPPassthroughOnPreserve(t *testing.T) {
	data, err := os.ReadFile("testdata/sample.webp")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	res, err := Optimize(data, "webp", ModePreserve)
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	if res.MainExt != "webp" || res.Converted || !bytes.Equal(res.Main, data) {
		t.Errorf("preserve mode altered webp: ext=%q converted=%v equal=%v", res.MainExt, res.Converted, bytes.Equal(res.Main, data))
	}
	if res.Thumb != nil {
		t.Error("webp passthrough should not emit a thumb")
	}
}

func TestOptimize_GifPassthrough(t *testing.T) {
	data := animatedGIF(t)
	res, err := Optimize(data, "gif", ModeUpload)
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	if !bytes.Equal(res.Main, data) {
		t.Error("gif bytes were altered")
	}
	if res.MainExt != "gif" || res.Thumb != nil {
		t.Errorf("MainExt=%q Thumb!=nil? %v", res.MainExt, res.Thumb != nil)
	}
}

func TestOptimize_CorruptImage(t *testing.T) {
	data := append([]byte{0xFF, 0xD8, 0xFF}, bytes.Repeat([]byte{0x7A}, 64)...)
	if _, err := Optimize(data, "jpg", ModeUpload); err == nil {
		t.Fatal("expected an error decoding a corrupt JPEG")
	}
}

func TestOptimize_RejectsDecompressionBomb(t *testing.T) {
	// 30000x30000 = 900M pixels; a full decode would allocate ~3.6 GB.
	// Reaching the assertion at all proves DecodeConfig gated it.
	bomb := hugePNG(30000, 30000)
	if w, h := decodeSize(t, bomb); int64(w)*int64(h) <= MaxPixels {
		t.Fatalf("fixture %dx%d does not exceed the cap", w, h)
	}
	if _, err := Optimize(bomb, "png", ModeUpload); err == nil {
		t.Fatal("Optimize accepted an over-cap image")
	}
	if _, err := Optimize(bomb, "png", ModePreserve); err == nil {
		t.Fatal("Optimize (preserve) accepted an over-cap image")
	}
}
