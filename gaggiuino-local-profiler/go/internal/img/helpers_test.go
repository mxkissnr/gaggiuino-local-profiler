package img

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

// hugePNG returns a tiny byte slice that is a structurally valid PNG whose
// IHDR declares w×h pixels — image.DecodeConfig reads those dimensions, but
// a full image.Decode would try to allocate w*h*4 bytes of RGBA. Used to
// prove the pipeline rejects a decompression bomb on the header alone: if
// the pixel cap were missing, the test process itself would OOM.
func hugePNG(w, h uint32) []byte {
	var buf bytes.Buffer
	buf.WriteString("\x89PNG\r\n\x1a\n")
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 2 // colour type: truecolor
	// ihdr[10..12]: compression / filter / interlace = 0
	binary.Write(&buf, binary.BigEndian, uint32(13))
	chunk := append([]byte("IHDR"), ihdr...)
	buf.Write(chunk)
	binary.Write(&buf, binary.BigEndian, crc32.ChecksumIEEE(chunk))
	return buf.Bytes()
}

// gradientRGBA builds a w×h smooth-gradient opaque image — it compresses
// well, so the encoded fixtures stay small even at photo dimensions.
func gradientRGBA(w, h int) *image.RGBA {
	im := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			im.Set(x, y, color.RGBA{
				R: uint8((x * 255) / max(w, 1)),
				G: uint8((y * 255) / max(h, 1)),
				B: uint8(((x + y) * 255) / max(w+h, 1)),
				A: 255,
			})
		}
	}
	return im
}

func encodeJPEG(t testing.TB, im image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, im, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("jpeg.Encode: %v", err)
	}
	return buf.Bytes()
}

func encodePNG(t testing.TB, im image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, im); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
}

// animatedGIF returns a minimal 2-frame animated GIF.
func animatedGIF(t testing.TB) []byte {
	t.Helper()
	pal := color.Palette{color.Black, color.White}
	f0 := image.NewPaletted(image.Rect(0, 0, 8, 8), pal)
	f1 := image.NewPaletted(image.Rect(0, 0, 8, 8), pal)
	for i := range f1.Pix {
		f1.Pix[i] = 1
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, &gif.GIF{
		Image: []*image.Paletted{f0, f1},
		Delay: []int{10, 10},
	}); err != nil {
		t.Fatalf("gif.EncodeAll: %v", err)
	}
	return buf.Bytes()
}

// jpegWithOrientation encodes im as JPEG and splices an EXIF APP1 segment
// (TIFF, big-endian) carrying an Orientation tag plus a small GPS IFD right
// after the SOI marker — enough to exercise both orientation handling and
// metadata stripping without committing a binary fixture.
func jpegWithOrientation(t testing.TB, im image.Image, orientation uint16) []byte {
	t.Helper()
	raw := encodeJPEG(t, im)

	var tiff bytes.Buffer
	tiff.WriteString("MM")
	binary.Write(&tiff, binary.BigEndian, uint16(0x002A))
	binary.Write(&tiff, binary.BigEndian, uint32(8)) // IFD0 at offset 8

	binary.Write(&tiff, binary.BigEndian, uint16(2)) // 2 entries
	// Orientation (0x0112), SHORT, count 1, value in the high 2 bytes.
	binary.Write(&tiff, binary.BigEndian, uint16(0x0112))
	binary.Write(&tiff, binary.BigEndian, uint16(3))
	binary.Write(&tiff, binary.BigEndian, uint32(1))
	binary.Write(&tiff, binary.BigEndian, orientation)
	binary.Write(&tiff, binary.BigEndian, uint16(0))
	// GPS IFD pointer (0x8825), LONG, count 1, offset 38.
	binary.Write(&tiff, binary.BigEndian, uint16(0x8825))
	binary.Write(&tiff, binary.BigEndian, uint16(4))
	binary.Write(&tiff, binary.BigEndian, uint32(1))
	binary.Write(&tiff, binary.BigEndian, uint32(38))
	binary.Write(&tiff, binary.BigEndian, uint32(0)) // no next IFD
	// GPS IFD at offset 38: one entry, GPSLatitudeRef (0x0001) ASCII "N".
	binary.Write(&tiff, binary.BigEndian, uint16(1))
	binary.Write(&tiff, binary.BigEndian, uint16(0x0001))
	binary.Write(&tiff, binary.BigEndian, uint16(2))
	binary.Write(&tiff, binary.BigEndian, uint32(2))
	tiff.WriteString("N\x00\x00\x00")
	binary.Write(&tiff, binary.BigEndian, uint32(0))

	payload := append([]byte("Exif\x00\x00"), tiff.Bytes()...)
	app1 := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(app1[2:], uint16(len(payload)+2))
	app1 = append(app1, payload...)

	out := make([]byte, 0, len(raw)+len(app1))
	out = append(out, raw[:2]...)
	out = append(out, app1...)
	out = append(out, raw[2:]...)
	return out
}

func decodeSize(t testing.TB, data []byte) (int, int) {
	t.Helper()
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("DecodeConfig: %v", err)
	}
	return cfg.Width, cfg.Height
}

func longEdge(w, h int) int {
	if w > h {
		return w
	}
	return h
}
