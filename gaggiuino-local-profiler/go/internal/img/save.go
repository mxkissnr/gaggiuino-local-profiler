package img

import (
	"encoding/binary"
	"log"
	"os"
)

// Save is the drop-in replacement for the three saveUploadedImage copies
// that lived in internal/shots, internal/library and internal/backup. It
// validates contentType + size + magic bytes, then runs the bytes through
// Optimize and writes the result (main image + thumbnail) under dir. It
// returns the FINAL extension — which may differ from the uploaded
// content-type's extension when Optimize converted the format (mode
// ModeUpload only) — so the caller persists the right value.
//
// On a decode/re-encode failure of an otherwise magic-valid JPEG the raw
// bytes are stored, but with their APP1 (EXIF/XMP) and APP13 (IPTC) segments
// stripped by hand first, so location data never survives an upload; a JPEG
// whose segment stream cannot be parsed at all is rejected ("", false). For
// every other format the original bytes are stored untouched, so metadata is
// only ever stripped when Optimize succeeded on a JPEG/PNG or when a JPEG fell
// back to the hand-stripped path. The byte-identical cases are the GIF
// passthrough, the WebP passthrough in ModePreserve, and the raw fallback of a
// non-JPEG on Optimize failure. No thumbnail is written on any fallback path,
// and any stale thumbnail for the stored extension is removed so ServePath
// falls back to the new full image.
func Save(dir, prefix string, id int64, data []byte, contentType string, mode Mode) (ext string, ok bool) {
	srcExt, known := ContentTypeKnown(contentType)
	if !known || len(data) == 0 || len(data) > MaxBytes {
		return "", false
	}
	if !MatchesMagicBytes(data, srcExt) {
		return "", false
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", false
	}

	res, err := Optimize(data, srcExt, mode)
	if err != nil {
		if srcExt == "jpg" {
			stripped, sok := stripJPEGMetadata(data)
			if !sok {
				return "", false
			}
			data = stripped
		}
		if werr := os.WriteFile(Path(dir, id, srcExt, prefix), data, 0o644); werr != nil {
			return "", false
		}
		log.Printf("img: %s%d: storing raw, could not optimize: %v", prefix, id, err)
		_ = os.Remove(ThumbPath(dir, id, srcExt, prefix))
		return srcExt, true
	}

	if err := os.WriteFile(Path(dir, id, res.MainExt, prefix), res.Main, 0o644); err != nil {
		return "", false
	}
	if res.Thumb != nil {
		if err := os.WriteFile(ThumbPath(dir, id, res.ThumbExt, prefix), res.Thumb, 0o644); err != nil {
			log.Printf("img: %s%d: main written, thumbnail failed: %v", prefix, id, err)
		}
	} else {
		// No new thumbnail for this extension (GIF, WebP passthrough): drop any
		// left from a previous upload of the same extension so the thumbnail
		// request serves the new full image instead of the old picture.
		_ = os.Remove(ThumbPath(dir, id, res.MainExt, prefix))
	}
	if res.Converted {
		_ = os.Remove(Path(dir, id, srcExt, prefix))
		_ = os.Remove(ThumbPath(dir, id, srcExt, prefix))
	}
	return res.MainExt, true
}

// WriteOptimized is the restore-path variant of Save: it takes a full
// destination path (whose extension the caller has already validated and
// recorded in the DB row inside the restore transaction) and runs the bytes
// through Optimize in ModePreserve — downscale + metadata strip for
// JPEG/PNG, byte-identical passthrough for WebP/GIF — plus a ".thumb"
// sibling. The path's extension is never changed, so the in-tx DB reference
// stays consistent.
//
// A restore must never lose the user's own image, so when Optimize fails the
// bytes are written as-is — with a JPEG's APP1/APP13 segments stripped by hand
// when the stream parses, and left raw with a logged warning when it does not.
func WriteOptimized(path string, data []byte, srcExt string) (finalExt string, err error) {
	if !knownExt(srcExt) || len(data) == 0 || len(data) > MaxBytes {
		return "", os.WriteFile(path, data, 0o644)
	}
	res, oerr := Optimize(data, srcExt, ModePreserve)
	if oerr != nil {
		if srcExt == "jpg" {
			if stripped, sok := stripJPEGMetadata(data); sok {
				data = stripped
			} else {
				log.Printf("img: restore %s: could not strip metadata, storing raw: %v", path, oerr)
			}
		}
		if werr := os.WriteFile(path, data, 0o644); werr != nil {
			return "", werr
		}
		log.Printf("img: restore %s: storing raw, could not optimize: %v", path, oerr)
		_ = os.Remove(thumbPathFor(path, srcExt))
		return srcExt, nil
	}
	if werr := os.WriteFile(path, res.Main, 0o644); werr != nil {
		return "", werr
	}
	if res.Thumb != nil {
		_ = os.WriteFile(thumbPathFor(path, res.ThumbExt), res.Thumb, 0o644)
	} else {
		_ = os.Remove(thumbPathFor(path, srcExt))
	}
	return srcExt, nil
}

// stripJPEGMetadata copies a JPEG byte-for-byte except for its APP1
// (EXIF/XMP) and APP13 (IPTC) marker segments, which are dropped. It walks the
// marker list the same way exifOrientation does: after SOI every segment is
// 0xFF <marker> <len>, and the entropy-coded scan (from SOS on) is copied
// verbatim to the end. ok is false when the stream is not a well-formed JPEG
// segment sequence — a bad marker, a truncated length, or bytes that run out
// before SOS/EOI — so a caller can tell "stripped" from "could not parse".
func stripJPEGMetadata(data []byte) (stripped []byte, ok bool) {
	if len(data) < 2 || data[0] != 0xFF || data[1] != 0xD8 {
		return nil, false
	}
	out := make([]byte, 0, len(data))
	out = append(out, data[0], data[1]) // SOI
	i := 2
	for i+2 <= len(data) {
		if data[i] != 0xFF {
			return nil, false
		}
		marker := data[i+1]
		if marker == 0xDA || marker == 0xD9 { // SOS / EOI: copy the rest as-is
			out = append(out, data[i:]...)
			return out, true
		}
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) { // TEM / RSTn: no length
			out = append(out, data[i], data[i+1])
			i += 2
			continue
		}
		if i+4 > len(data) {
			return nil, false
		}
		segLen := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		if segLen < 2 || i+2+segLen > len(data) {
			return nil, false
		}
		if marker != 0xE1 && marker != 0xED {
			out = append(out, data[i:i+2+segLen]...)
		}
		i += 2 + segLen
	}
	// Bytes ran out before SOS/EOI: not a whole JPEG.
	return nil, false
}
