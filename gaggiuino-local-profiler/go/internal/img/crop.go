package img

import (
	"bytes"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"math"
	"os"
	"strconv"
	"strings"
)

// Crop is a rectangle expressed as fractions of the original image's width
// and height, so it survives any later downscale. X/Y are the top-left
// corner, W/H the size, all in 0..1.
type Crop struct {
	X, Y, W, H float64
}

// cropEpsilon absorbs the rounding error of a client that computed the
// fractions from pixel rects before sending them.
const cropEpsilon = 1e-3

// ParseCrop parses "x,y,w,h" — exactly four finite floats. Range checking is
// Valid's job, so a caller can tell a malformed parameter from an
// out-of-range one.
func ParseCrop(s string) (Crop, error) {
	parts := strings.Split(s, ",")
	if len(parts) != 4 {
		return Crop{}, fmt.Errorf("img: crop %q: want 4 comma-separated values, got %d", s, len(parts))
	}
	var v [4]float64
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return Crop{}, fmt.Errorf("img: crop %q: %w", s, err)
		}
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return Crop{}, fmt.Errorf("img: crop %q: value %d is not finite", s, i+1)
		}
		v[i] = f
	}
	return Crop{X: v[0], Y: v[1], W: v[2], H: v[3]}, nil
}

// Valid reports whether the rectangle lies inside the unit square. The small
// tolerance on the far edge accepts a client's pixel-rounded edge that lands
// a hair past 1.
func (c Crop) Valid() bool {
	if c.X < 0 || c.Y < 0 {
		return false
	}
	if c.W <= 0 || c.W > 1 || c.H <= 0 || c.H > 1 {
		return false
	}
	return c.X+c.W <= 1+cropEpsilon && c.Y+c.H <= 1+cropEpsilon
}

// WriteOriginal stores data as the uncropped original for (prefix, id). Only
// a JPEG within MaxBytes and the pixel cap is accepted, and its EXIF/XMP/IPTC
// segments are stripped before it is written atomically — a JPEG whose
// segment stream cannot be parsed is rejected. No thumbnail is ever written
// for an original.
func WriteOriginal(dir, prefix string, id int64, data []byte) error {
	if len(data) == 0 || len(data) > MaxBytes {
		return fmt.Errorf("img: original %s%d: size %d out of range", prefix, id, len(data))
	}
	if !MatchesMagicBytes(data, "jpg") {
		return fmt.Errorf("img: original %s%d: not a JPEG", prefix, id)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("img: original %s%d: decode config: %w", prefix, id, err)
	}
	if !withinPixelCap(cfg.Width, cfg.Height) {
		return fmt.Errorf("img: original %s%d: %dx%d exceeds the pixel cap", prefix, id, cfg.Width, cfg.Height)
	}
	stripped, ok := stripJPEGMetadata(data)
	if !ok {
		return fmt.Errorf("img: original %s%d: could not parse JPEG metadata", prefix, id)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("img: original %s%d: %w", prefix, id, err)
	}
	if err := writeAtomic(OriginalPath(dir, id, prefix), stripped); err != nil {
		return fmt.Errorf("img: original %s%d: %w", prefix, id, err)
	}
	return nil
}

// ReadOriginal returns the stored uncropped original. A missing file reports
// os.ErrNotExist so callers can fall back to the main image.
func ReadOriginal(dir, prefix string, id int64) ([]byte, error) {
	data, err := os.ReadFile(OriginalPath(dir, id, prefix))
	if err != nil {
		return nil, fmt.Errorf("img: read original %s%d: %w", prefix, id, err)
	}
	return data, nil
}

// CropJPEG re-encodes original cropped to c as a JPEG at JPEGQuality. The
// fractions are rounded to a pixel rect clamped to the image bounds, so the
// result is always at least 1x1. The result is meant to be handed to Save as
// the new main image.
func CropJPEG(original []byte, c Crop) ([]byte, error) {
	if !c.Valid() {
		return nil, fmt.Errorf("img: crop %+v is outside the unit square", c)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(original))
	if err != nil {
		return nil, fmt.Errorf("img: crop: decode config: %w", err)
	}
	if !withinPixelCap(cfg.Width, cfg.Height) {
		return nil, fmt.Errorf("img: crop: %dx%d exceeds the pixel cap", cfg.Width, cfg.Height)
	}
	src, _, err := image.Decode(bytes.NewReader(original))
	if err != nil {
		return nil, fmt.Errorf("img: crop: decode: %w", err)
	}
	if MatchesMagicBytes(original, "jpg") {
		src = applyOrientation(src, exifOrientation(original))
	}

	b := src.Bounds()
	rect := cropRect(c, b.Dx(), b.Dy())
	dst := image.NewRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
	draw.Draw(dst, dst.Bounds(), src, rect.Min, draw.Src)

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: JPEGQuality}); err != nil {
		return nil, fmt.Errorf("img: crop: encode: %w", err)
	}
	return buf.Bytes(), nil
}

// cropRect rounds c to pixel coordinates of a w×h image and clamps them to
// its bounds, widening a degenerate rect to at least one pixel each way.
func cropRect(c Crop, w, h int) image.Rectangle {
	clamp := func(v, hi int) int {
		if v < 0 {
			return 0
		}
		if v > hi {
			return hi
		}
		return v
	}
	x0 := clamp(int(math.Round(c.X*float64(w))), w)
	y0 := clamp(int(math.Round(c.Y*float64(h))), h)
	x1 := clamp(int(math.Round((c.X+c.W)*float64(w))), w)
	y1 := clamp(int(math.Round((c.Y+c.H)*float64(h))), h)
	if x1 <= x0 {
		if x0 == w {
			x0 = w - 1
		}
		x1 = x0 + 1
	}
	if y1 <= y0 {
		if y0 == h {
			y0 = h - 1
		}
		y1 = y0 + 1
	}
	return image.Rect(x0, y0, x1, y1)
}
