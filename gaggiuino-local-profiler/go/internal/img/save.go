package img

import (
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
// On a decode/re-encode failure of an otherwise magic-valid blob the
// original bytes are stored as-is, a warning is logged, and no thumbnail is
// written — no regression versus the pre-#961 behaviour, which always
// stored the raw upload.
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
		if werr := os.WriteFile(Path(dir, id, srcExt, prefix), data, 0o644); werr != nil {
			return "", false
		}
		log.Printf("img: %s%d: storing raw, could not optimize: %v", prefix, id, err)
		return srcExt, true
	}

	if err := os.WriteFile(Path(dir, id, res.MainExt, prefix), res.Main, 0o644); err != nil {
		return "", false
	}
	if res.Thumb != nil {
		if err := os.WriteFile(ThumbPath(dir, id, res.ThumbExt, prefix), res.Thumb, 0o644); err != nil {
			log.Printf("img: %s%d: main written, thumbnail failed: %v", prefix, id, err)
		}
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
func WriteOptimized(path string, data []byte, srcExt string) (finalExt string, err error) {
	if !knownExt(srcExt) || len(data) == 0 || len(data) > MaxBytes {
		return "", os.WriteFile(path, data, 0o644)
	}
	res, oerr := Optimize(data, srcExt, ModePreserve)
	if oerr != nil {
		if werr := os.WriteFile(path, data, 0o644); werr != nil {
			return "", werr
		}
		log.Printf("img: restore %s: storing raw, could not optimize: %v", path, oerr)
		return srcExt, nil
	}
	if werr := os.WriteFile(path, res.Main, 0o644); werr != nil {
		return "", werr
	}
	if res.Thumb != nil {
		_ = os.WriteFile(thumbPathFor(path, res.ThumbExt), res.Thumb, 0o644)
	}
	return srcExt, nil
}
