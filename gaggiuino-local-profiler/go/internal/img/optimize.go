package img

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"

	// Decoders registered for image.Decode. GIF is decoded only for the
	// upload path's format probing; stored GIFs are always passed through
	// untouched (see Optimize).
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// Mode selects how Optimize treats the source extension.
type Mode int

const (
	// ModeUpload is the direct-upload / URL-fetch path: the output format
	// is re-derived from the pixels (opaque -> JPEG, real alpha -> PNG), so
	// a WebP upload is converted and the caller persists the new extension.
	ModeUpload Mode = iota
	// ModePreserve is the migration / restore path: the source extension is
	// kept (JPEG/PNG are downscaled + stripped in place; WebP/GIF pass
	// through untouched), so no DB reference ever has to be rewritten.
	ModePreserve
)

// Result is the output of Optimize.
type Result struct {
	Main      []byte
	MainExt   string
	Thumb     []byte // nil when no thumbnail was produced (GIF, WebP passthrough, decode issues)
	ThumbExt  string
	Converted bool // MainExt differs from the source extension
}

// Optimize decodes data, applies EXIF orientation (JPEG only), downscales
// to MaxEdge, strips all metadata by virtue of the decode/re-encode round
// trip, and produces a ThumbEdge thumbnail.
//
// GIF is always returned byte-identical (single-frame decode would silently
// kill animation). In ModePreserve a WebP is also returned byte-identical.
func Optimize(data []byte, srcExt string, mode Mode) (Result, error) {
	if srcExt == "gif" {
		return Result{Main: data, MainExt: "gif"}, nil
	}
	if mode == ModePreserve && srcExt == "webp" {
		return Result{Main: data, MainExt: "webp"}, nil
	}

	// Read the header first: an attacker-controlled blob whose declared
	// dimensions blow past MaxPixels would allocate gigabytes of RGBA in
	// image.Decode. Bail before the decoder ever runs; the caller stores
	// the raw bytes instead (Save) or leaves the file untouched (migrate).
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return Result{}, err
	}
	if !withinPixelCap(cfg.Width, cfg.Height) {
		return Result{}, fmt.Errorf("img: %dx%d exceeds the %d-pixel decode cap", cfg.Width, cfg.Height, MaxPixels)
	}

	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return Result{}, err
	}

	if srcExt == "jpg" {
		src = applyOrientation(src, exifOrientation(data))
	}

	alpha := hasAlpha(src)

	mainExt := srcExt
	if mode == ModeUpload {
		if alpha {
			mainExt = "png"
		} else {
			mainExt = "jpg"
		}
	}

	mainImg := scaleDown(src, MaxEdge)
	mainBytes, err := encodeImage(mainImg, mainExt)
	if err != nil {
		return Result{}, err
	}

	// The thumbnail is scaled from the already-downscaled main image, not
	// the source: less work, and the main image is already anti-aliased.
	thumbImg := scaleDown(mainImg, ThumbEdge)
	thumbBytes, err := encodeImage(thumbImg, mainExt)
	if err != nil {
		return Result{}, err
	}

	return Result{
		Main:      mainBytes,
		MainExt:   mainExt,
		Thumb:     thumbBytes,
		ThumbExt:  mainExt,
		Converted: mainExt != srcExt,
	}, nil
}

// encodeImage writes img as ext ("jpg" -> JPEG q85, "png" -> PNG). No
// metadata is emitted by either encoder, so this is where EXIF/GPS is
// dropped.
func encodeImage(im image.Image, ext string) ([]byte, error) {
	var buf bytes.Buffer
	switch ext {
	case "png":
		if err := (&png.Encoder{CompressionLevel: png.DefaultCompression}).Encode(&buf, im); err != nil {
			return nil, err
		}
	default:
		if err := jpeg.Encode(&buf, im, &jpeg.Options{Quality: JPEGQuality}); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

// hasAlpha reports whether im carries any non-opaque pixel. Every stdlib
// and x/image image type implements Opaque(); anything exotic that does not
// is treated as opaque.
func hasAlpha(im image.Image) bool {
	if o, ok := im.(interface{ Opaque() bool }); ok {
		return !o.Opaque()
	}
	return false
}

// scaleDown returns im resized so its long edge is at most maxEdge,
// preserving aspect ratio. It halves repeatedly with a cheap bilinear
// kernel until within 2x of the target, then does one final resample —
// the "browser-style" downscale: it averages enough source pixels to
// avoid the aliasing a single ApproxBiLinear pass leaves on a large
// minification, while costing a fraction of a Catmull-Rom pass, which
// matters for a synchronous upload handler on the ARM boards this runs on.
// An image already within bounds is returned unchanged (never upscaled).
func scaleDown(im image.Image, maxEdge int) image.Image {
	b := im.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= maxEdge && h <= maxEdge {
		return im
	}
	nw, nh := w, h
	if w >= h {
		nw = maxEdge
		nh = max(int(float64(h)*float64(maxEdge)/float64(w)), 1)
	} else {
		nh = maxEdge
		nw = max(int(float64(w)*float64(maxEdge)/float64(h)), 1)
	}

	cur := im
	cw, ch := w, h
	for cw/2 >= nw && ch/2 >= nh {
		cw, ch = cw/2, ch/2
		half := image.NewRGBA(image.Rect(0, 0, cw, ch))
		xdraw.ApproxBiLinear.Scale(half, half.Bounds(), cur, cur.Bounds(), xdraw.Src, nil)
		cur = half
	}
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	xdraw.ApproxBiLinear.Scale(dst, dst.Bounds(), cur, cur.Bounds(), xdraw.Src, nil)
	return dst
}

// exifOrientation hand-parses the APP1 Exif block of a JPEG for tag 0x0112
// (Orientation), returning a value in 1..8 (1 = no transform) or 1 when the
// tag is absent or the block is malformed. Deliberately dependency-free —
// the only EXIF field the pipeline needs, since decode/re-encode already
// drops everything else.
func exifOrientation(data []byte) int {
	// Walk JPEG marker segments looking for APP1 (0xFFE1) "Exif\0\0".
	i := 2 // skip SOI (0xFFD8)
	for i+4 <= len(data) {
		if data[i] != 0xFF {
			return 1
		}
		marker := data[i+1]
		if marker == 0xDA || marker == 0xD9 { // SOS / EOI — no more metadata
			return 1
		}
		segLen := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		if segLen < 2 || i+2+segLen > len(data) {
			return 1
		}
		if marker == 0xE1 {
			seg := data[i+4 : i+2+segLen]
			if o, ok := orientationFromExif(seg); ok {
				return o
			}
		}
		i += 2 + segLen
	}
	return 1
}

func orientationFromExif(seg []byte) (int, bool) {
	if len(seg) < 8 || string(seg[:6]) != "Exif\x00\x00" {
		return 0, false
	}
	tiff := seg[6:]
	if len(tiff) < 8 {
		return 0, false
	}
	var bo binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 0, false
	}
	ifdOff := int(bo.Uint32(tiff[4:8]))
	if ifdOff+2 > len(tiff) {
		return 0, false
	}
	count := int(bo.Uint16(tiff[ifdOff : ifdOff+2]))
	entry := ifdOff + 2
	for n := 0; n < count; n++ {
		if entry+12 > len(tiff) {
			return 0, false
		}
		tag := bo.Uint16(tiff[entry : entry+2])
		if tag == 0x0112 {
			v := int(bo.Uint16(tiff[entry+8 : entry+10]))
			if v >= 1 && v <= 8 {
				return v, true
			}
			return 0, false
		}
		entry += 12
	}
	return 0, false
}

// applyOrientation returns im with the EXIF orientation transform applied so
// the pixels display upright once the tag is stripped.
func applyOrientation(im image.Image, o int) image.Image {
	if o <= 1 || o > 8 {
		return im
	}
	b := im.Bounds()
	w, h := b.Dx(), b.Dy()
	swap := o >= 5
	dw, dh := w, h
	if swap {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := im.At(b.Min.X+x, b.Min.Y+y)
			var nx, ny int
			switch o {
			case 2: // flip horizontal
				nx, ny = w-1-x, y
			case 3: // rotate 180
				nx, ny = w-1-x, h-1-y
			case 4: // flip vertical
				nx, ny = x, h-1-y
			case 5: // transpose
				nx, ny = y, x
			case 6: // rotate 90 CW
				nx, ny = h-1-y, x
			case 7: // transverse
				nx, ny = h-1-y, w-1-x
			case 8: // rotate 90 CCW
				nx, ny = y, w-1-x
			}
			dst.Set(nx, ny, c)
		}
	}
	return dst
}
