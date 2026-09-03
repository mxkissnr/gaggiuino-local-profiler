package backup

import (
	"archive/zip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

// This file holds #959's streaming restore-side plumbing: the request body
// goes to a temp file (never a slice), the bundle JSON is parsed with a
// streaming decoder that pulls the `shots` array one element at a time, and
// restore images are read lazily from the zip on disk (one image body in
// memory at most), never a filename -> bytes map of the whole archive.

// restoreTempDir is where the streamed request body is spooled. os.TempDir
// by default; a var so a test can redirect it.
var restoreTempDir = os.TempDir

// streamRestoreBodyToTemp copies the request body to a temp file, bounded
// by the compressed-body limit (a zip-bomb / abuse guard, see
// restoreZipBodyLimit's doc). Returns the temp path and a cleanup func;
// the caller re-opens the file for random access (zip) or a fresh stream
// (legacy JSON).
func streamRestoreBodyToTemp(body io.Reader, isZip bool) (string, func(), error) {
	limit := int64(restoreJSONBodyLimit)
	pattern := "glp-restore-*.json"
	if isZip {
		limit = restoreZipBodyLimit
		pattern = "glp-restore-*.zip"
	}
	tmp, err := os.CreateTemp(restoreTempDir(), pattern)
	if err != nil {
		return "", func() {}, err
	}
	path := tmp.Name()
	cleanup := func() { _ = os.Remove(path) }

	n, err := io.Copy(tmp, io.LimitReader(body, limit+1))
	if err != nil {
		tmp.Close()
		cleanup()
		return "", func() {}, err
	}
	if closeErr := tmp.Close(); closeErr != nil {
		cleanup()
		return "", func() {}, closeErr
	}
	if n > limit {
		cleanup()
		return "", func() {}, errBodyTooLarge
	}
	return path, cleanup, nil
}

// cappedReader errors (rather than reporting EOF) once more than `limit`
// bytes have been read through it — the zip-bomb guard for a single
// decompressed zip entry streamed through the JSON decoder or an image
// validator.
type cappedReader struct {
	r     io.Reader
	left  int64
	limit int64
}

func newCappedReader(r io.Reader, limit int64) *cappedReader {
	return &cappedReader{r: r, left: limit, limit: limit}
}

func (c *cappedReader) Read(p []byte) (int, error) {
	if c.left < 0 {
		return 0, fmt.Errorf("zip entry exceeds %d bytes uncompressed (possible zip bomb)", c.limit)
	}
	// Never hand the underlying reader room for more than one byte past the
	// limit, so a reader that would deliver the whole (bomb) entry in one
	// Read can't stuff it into the consumer's buffer before the error is
	// seen.
	if int64(len(p)) > c.left+1 {
		p = p[:c.left+1]
	}
	n, err := c.r.Read(p)
	c.left -= int64(n)
	if c.left < 0 {
		return n, fmt.Errorf("zip entry exceeds %d bytes uncompressed (possible zip bomb)", c.limit)
	}
	return n, err
}

// restoreImages is the restore path's image source. For a zip upload it
// indexes the archive's images/* entries (no bytes held); get() opens one
// entry and reads up to imageMaxBytes+1 on demand. For a legacy
// self-contained JSON upload it is the already-base64-decoded map (bounded
// by the JSON body limit). total accumulates every byte read through get()
// and errors past restoreUnzipTotalLimit — the cumulative zip-bomb guard.
type restoreImages struct {
	zip    map[string]*zip.File
	inline map[string][]byte
	total  *int64
}

func (ri restoreImages) present(name string) bool {
	if ri.inline != nil {
		_, ok := ri.inline[name]
		return ok
	}
	_, ok := ri.zip["images/"+name]
	return ok
}

// get returns the image bytes for name, capped at imageMaxBytes+1 so an
// oversized entry is still distinguishable from a valid one by the
// caller's `len(buf) > imageMaxBytes` check. Reads count toward the
// cumulative total guard.
func (ri restoreImages) get(name string) ([]byte, bool) {
	if ri.inline != nil {
		b, ok := ri.inline[name]
		return b, ok
	}
	f, ok := ri.zip["images/"+name]
	if !ok {
		return nil, false
	}
	rc, err := f.Open()
	if err != nil {
		return nil, false
	}
	defer rc.Close()
	var src io.Reader = io.LimitReader(rc, imageMaxBytes+1)
	if ri.total != nil {
		src = newCappedReader(src, remainingTotal(ri.total))
	}
	b, err := io.ReadAll(src)
	if err != nil {
		return nil, false
	}
	if ri.total != nil {
		*ri.total += int64(len(b))
	}
	return b, true
}

// getForWrite re-reads an already-validated image entry to stream it to
// disk after the restore tx commits — not counted toward the cumulative
// guard (the entry passed validation, its size is already bounded).
func (ri restoreImages) getForWrite(name string) ([]byte, bool) {
	if ri.inline != nil {
		b, ok := ri.inline[name]
		return b, ok
	}
	f, ok := ri.zip["images/"+name]
	if !ok {
		return nil, false
	}
	rc, err := f.Open()
	if err != nil {
		return nil, false
	}
	defer rc.Close()
	b, err := io.ReadAll(io.LimitReader(rc, imageMaxBytes+1))
	if err != nil {
		return nil, false
	}
	return b, true
}

func remainingTotal(total *int64) int64 {
	r := restoreUnzipTotalLimit - *total
	if r < 0 {
		r = 0
	}
	return r
}

// decodeInlineImages base64-decodes a legacy self-contained JSON bundle's
// `images` object (filename -> base64 string). A value that isn't valid
// base64 is silently dropped, matching the Node original.
func decodeInlineImages(v any) map[string][]byte {
	out := map[string][]byte{}
	raw, ok := v.(map[string]any)
	if !ok {
		return out
	}
	for name, val := range raw {
		s, _ := val.(string)
		if decoded, err := base64.StdEncoding.DecodeString(s); err == nil {
			out[name] = decoded
		}
	}
	return out
}

// parseBundleStream streams a backup bundle JSON object: every top-level
// key except `shots` is decoded into b (all small relative to a shots
// array with datapoints), and each element of the `shots` array is handed
// to onShot as raw bytes and then dropped. Returns b, the shot count, and
// whether `shots` was present AND an array (an absent or non-array `shots`
// makes the caller answer "Invalid backup file", matching Node's
// `Array.isArray(b.shots)` gate).
func parseBundleStream(r io.Reader, onShot func(raw json.RawMessage) error) (b map[string]any, shotCount int, sawShotsArray bool, err error) {
	dec := json.NewDecoder(r)
	b = map[string]any{}

	tok, err := dec.Token()
	if err != nil {
		return nil, 0, false, fmt.Errorf("invalid backup file (backup.json is not valid JSON)")
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, 0, false, fmt.Errorf("invalid backup file (backup.json is not a JSON object)")
	}

	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, 0, false, fmt.Errorf("invalid backup file (backup.json is not valid JSON)")
		}
		key, _ := keyTok.(string)

		if key == "shots" {
			openTok, err := dec.Token()
			if err != nil {
				return nil, 0, false, fmt.Errorf("invalid backup file (backup.json is not valid JSON)")
			}
			if d, ok := openTok.(json.Delim); !ok || d != '[' {
				// `shots` present but not an array — consume the value and
				// leave sawShotsArray false.
				var discard any
				_ = dec.Decode(&discard)
				continue
			}
			sawShotsArray = true
			for dec.More() {
				var raw json.RawMessage
				if err := dec.Decode(&raw); err != nil {
					return nil, 0, false, fmt.Errorf("invalid backup file (a shots entry is not valid JSON)")
				}
				shotCount++
				if onShot != nil {
					if err := onShot(raw); err != nil {
						return nil, 0, false, err
					}
				}
			}
			if _, err := dec.Token(); err != nil { // closing ']'
				return nil, 0, false, fmt.Errorf("invalid backup file (backup.json is not valid JSON)")
			}
			continue
		}

		var v any
		if err := dec.Decode(&v); err != nil {
			return nil, 0, false, fmt.Errorf("invalid backup file (backup.json is not valid JSON)")
		}
		b[key] = v
	}

	if _, err := dec.Token(); err != nil { // closing '}'
		return nil, 0, false, fmt.Errorf("invalid backup file (backup.json is not valid JSON)")
	}

	// The shots array is consumed by onShot and never stored in b, but
	// sectionsPresent (and every other `b["shots"]` presence check) still
	// needs to know it was there — without this the dry-run preview reports
	// shots/library as absent for every zip bundle and the UI skips them
	// (#967). A bare marker: nothing reads b["shots"] as data.
	if sawShotsArray {
		if _, ok := b["shots"]; !ok {
			b["shots"] = []any{}
		}
	}
	return b, shotCount, sawShotsArray, nil
}

// openRestoreZip opens the streamed temp zip for random access and splits
// its entries into the backup.json entry and an images/* index (names
// only). A missing backup.json is the caller's 400.
func openRestoreZip(path string) (zr *zip.ReadCloser, jsonEntry *zip.File, images map[string]*zip.File, err error) {
	zr, err = zip.OpenReader(path)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("invalid zip file: %w", err)
	}
	images = map[string]*zip.File{}
	for _, f := range zr.File {
		switch {
		case f.Name == "backup.json":
			jsonEntry = f
		case strings.HasPrefix(f.Name, "images/"):
			images[f.Name] = f
		}
	}
	if jsonEntry == nil {
		zr.Close()
		return nil, nil, nil, fmt.Errorf("invalid backup file (no backup.json in zip)")
	}
	return zr, jsonEntry, images, nil
}
