package img

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateExisting(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	bigJPEG := encodeJPEG(t, gradientRGBA(1700, 1300))
	smallJPEG := encodeJPEG(t, gradientRGBA(200, 200))
	gifBytes := animatedGIF(t)
	corruptJPEG := append([]byte{0xFF, 0xD8, 0xFF}, bytes.Repeat([]byte{0x22}, 64)...)
	webpBytes, err := os.ReadFile("testdata/sample.webp")
	if err != nil {
		t.Fatal(err)
	}

	bombPNG := hugePNG(30000, 30000)

	write("123.jpg", bigJPEG)
	write("grinder-5.jpg", smallJPEG)
	write("basket-1.gif", gifBytes)
	write("shot-9.jpg", corruptJPEG)
	write("77.webp", webpBytes)
	write("500.png", bombPNG)

	var markCalls int
	MigrateExisting(dir,
		func() (bool, error) { return false, nil },
		func() error { markCalls++; return nil },
		func(string, ...any) {},
	)

	if markCalls != 1 {
		t.Fatalf("markDone called %d times, want 1", markCalls)
	}

	// Oversized JPEG downscaled + thumbnailed.
	got, _ := os.ReadFile(filepath.Join(dir, "123.jpg"))
	if w, h := decodeSize(t, got); w > MaxEdge || h > MaxEdge {
		t.Errorf("123.jpg not downscaled: %dx%d", w, h)
	}
	if _, err := os.Stat(filepath.Join(dir, "123.thumb.jpg")); err != nil {
		t.Errorf("123.thumb.jpg missing: %v", err)
	}

	// Small JPEG: bytes untouched, thumbnail added.
	if got, _ := os.ReadFile(filepath.Join(dir, "grinder-5.jpg")); !bytes.Equal(got, smallJPEG) {
		t.Error("grinder-5.jpg bytes changed")
	}
	if _, err := os.Stat(filepath.Join(dir, "grinder-5.thumb.jpg")); err != nil {
		t.Errorf("grinder-5.thumb.jpg missing: %v", err)
	}

	// GIF untouched, no thumbnail.
	if got, _ := os.ReadFile(filepath.Join(dir, "basket-1.gif")); !bytes.Equal(got, gifBytes) {
		t.Error("basket-1.gif bytes changed")
	}
	if _, err := os.Stat(filepath.Join(dir, "basket-1.thumb.gif")); !os.IsNotExist(err) {
		t.Errorf("unexpected gif thumbnail: %v", err)
	}

	// Corrupt JPEG kept as-is.
	if got, _ := os.ReadFile(filepath.Join(dir, "shot-9.jpg")); !bytes.Equal(got, corruptJPEG) {
		t.Error("shot-9.jpg bytes changed")
	}

	// WebP passthrough, no thumbnail.
	if got, _ := os.ReadFile(filepath.Join(dir, "77.webp")); !bytes.Equal(got, webpBytes) {
		t.Error("77.webp bytes changed")
	}
	if _, err := os.Stat(filepath.Join(dir, "77.thumb.webp")); !os.IsNotExist(err) {
		t.Errorf("unexpected webp thumbnail: %v", err)
	}

	// Decompression bomb left completely untouched, never decoded.
	if got, _ := os.ReadFile(filepath.Join(dir, "500.png")); !bytes.Equal(got, bombPNG) {
		t.Error("500.png bytes changed")
	}
	if _, err := os.Stat(filepath.Join(dir, "500.thumb.png")); !os.IsNotExist(err) {
		t.Errorf("unexpected thumbnail for over-cap image: %v", err)
	}
}

func TestMigrateExisting_Idempotent(t *testing.T) {
	dir := t.TempDir()
	// Already within bounds: exercises the "generate the missing thumbnail
	// without touching the main file" branch plus its byte-stable re-run.
	if err := os.WriteFile(filepath.Join(dir, "123.jpg"), encodeJPEG(t, gradientRGBA(800, 600)), 0o644); err != nil {
		t.Fatal(err)
	}

	var isDoneCalls int
	done := false
	run := func() {
		MigrateExisting(dir,
			func() (bool, error) { isDoneCalls++; return done, nil },
			func() error { done = true; return nil },
			func(string, ...any) {},
		)
	}

	run()
	after1, _ := os.ReadFile(filepath.Join(dir, "123.jpg"))

	run() // isDone -> true now, must short-circuit
	after2, _ := os.ReadFile(filepath.Join(dir, "123.jpg"))
	if !bytes.Equal(after1, after2) {
		t.Error("second run mutated the image despite the done flag")
	}

	// Even forcing the flag back off must be a byte-stable no-op (already
	// within bounds + thumb present).
	done = false
	run()
	after3, _ := os.ReadFile(filepath.Join(dir, "123.jpg"))
	if !bytes.Equal(after1, after3) {
		t.Error("forced re-run mutated an already-optimized image")
	}
	if isDoneCalls != 3 {
		t.Fatalf("isDone called %d times, want 3", isDoneCalls)
	}
}
