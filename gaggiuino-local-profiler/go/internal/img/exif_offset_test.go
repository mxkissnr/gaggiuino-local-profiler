package img

import (
	"encoding/binary"
	"testing"
)

// craftedExifJPEG builds a minimal JPEG whose single APP1 segment carries a
// big-endian TIFF header with the IFD0 offset field set to ifdOff. On a 32-bit
// build an offset >= 2^31 used to go negative, pass the signed bounds check and
// panic the slice in orientationFromExif.
func craftedExifJPEG(ifdOff uint32) []byte {
	payload := []byte("Exif\x00\x00")
	payload = append(payload, 'M', 'M')
	payload = append(payload, 0x00, 0x2A) // TIFF magic
	payload = append(payload,
		byte(ifdOff>>24), byte(ifdOff>>16), byte(ifdOff>>8), byte(ifdOff))

	app1 := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(app1[2:], uint16(len(payload)+2))
	app1 = append(app1, payload...)

	out := []byte{0xFF, 0xD8} // SOI
	out = append(out, app1...)
	out = append(out, 0xFF, 0xD9) // EOI
	return out
}

// TestExifOrientation_HugeIFDOffsetDoesNotPanic guards the 32-bit ARM crash:
// an APP1 EXIF IFD offset that does not fit a signed int must be rejected, not
// used as a slice index.
func TestExifOrientation_HugeIFDOffsetDoesNotPanic(t *testing.T) {
	for _, off := range []uint32{0xFFFFFFF0, 0x7FFFFFFF} {
		if got := exifOrientation(craftedExifJPEG(off)); got != 1 {
			t.Errorf("exifOrientation(ifdOff=%#x) = %d, want 1", off, got)
		}
	}
}

// FuzzOrientationFromExif seeds the parser with the two offsets that crashed a
// 32-bit build and fuzzes the whole marker-walking entry point, so a malformed
// segment can never reach an unchecked slice.
func FuzzOrientationFromExif(f *testing.F) {
	f.Add(craftedExifJPEG(0xFFFFFFF0))
	f.Add(craftedExifJPEG(0x7FFFFFFF))
	f.Fuzz(func(t *testing.T, data []byte) {
		_ = exifOrientation(data)
	})
}
