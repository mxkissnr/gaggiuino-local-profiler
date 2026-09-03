package img

import (
	"bytes"
	"image"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// imagePrefixes are the filename prefixes every entity type stores under in
// the shared image dir. Non-empty prefixes are tried before the bare bean
// prefix so "grinder-5.jpg" is not misread as bean id "grinder-5".
var imagePrefixes = []string{"grinder-", "basket-", "puckscreen-", "shot-", ""}

// parseImageName splits "<prefix><id>.<ext>" into its id and extension.
// Reports ok=false for a thumbnail, an unknown extension, or a name that
// does not match any known prefix + numeric id.
func parseImageName(name string) (id int64, ext, prefix string, ok bool) {
	if strings.Contains(name, ".thumb.") {
		return 0, "", "", false
	}
	ext = strings.TrimPrefix(filepath.Ext(name), ".")
	if !knownExt(ext) {
		return 0, "", "", false
	}
	base := strings.TrimSuffix(name, filepath.Ext(name))
	for _, p := range imagePrefixes {
		if !strings.HasPrefix(base, p) {
			continue
		}
		digits := strings.TrimPrefix(base, p)
		if digits == "" {
			continue
		}
		n, err := strconv.ParseInt(digits, 10, 64)
		if err != nil || n <= 0 {
			continue
		}
		return n, ext, p, true
	}
	return 0, "", "", false
}

// MigrateExisting runs the one-time #961 sweep over dir: every JPEG/PNG
// larger than MaxEdge is downscaled + stripped in place (atomic .tmp +
// rename), and every JPEG/PNG missing a thumbnail gets one. GIF and WebP
// are left untouched (see decision 6 in the plan). The sweep is best-effort
// — a file that fails to decode keeps its original bytes — and idempotent:
// isDone short-circuits it, and even without that flag step "already within
// bounds and thumb present" makes a re-run cheap.
//
// Intended to be launched in a background goroutine from buildApp; it never
// returns an error, only a one-line summary through logf.
func MigrateExisting(dir string, isDone func() (bool, error), markDone func() error, logf func(string, ...any)) {
	if done, _ := isDone(); done {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			_ = markDone()
		}
		return
	}

	var optimized, skipped, failed int
	for _, entry := range entries {
		if entry.IsDir() {
			skipped++
			continue
		}
		_, ext, _, ok := parseImageName(entry.Name())
		if !ok || ext == "gif" || ext == "webp" {
			skipped++
			continue
		}
		full := filepath.Join(dir, entry.Name())
		thumb := thumbPathFor(full, ext)
		_, thumbErr := os.Stat(thumb)
		haveThumb := thumbErr == nil

		data, rerr := os.ReadFile(full)
		if rerr != nil || len(data) == 0 || len(data) > MaxBytes {
			failed++
			continue
		}
		cfg, _, cerr := image.DecodeConfig(bytes.NewReader(data))
		if cerr != nil {
			failed++
			continue
		}
		// A pre-existing decompression bomb (the old Node upload path stored
		// raw after only a magic-byte check) must never be decoded — that
		// would OOM the process on every boot, and markDone() is only
		// reached at the end. Leave it exactly as-is.
		if !withinPixelCap(cfg.Width, cfg.Height) {
			failed++
			continue
		}
		needDownscale := cfg.Width > MaxEdge || cfg.Height > MaxEdge
		if !needDownscale && haveThumb {
			skipped++
			continue
		}

		if needDownscale {
			res, oerr := Optimize(data, ext, ModePreserve)
			if oerr != nil {
				failed++
				continue
			}
			if err := writeAtomic(full, res.Main); err != nil {
				failed++
				continue
			}
			if res.Thumb != nil {
				_ = os.WriteFile(thumb, res.Thumb, 0o644)
			}
			optimized++
			continue
		}

		// Already within bounds — only the thumbnail is missing. Leave the
		// main file (and its metadata) untouched.
		src, _, derr := image.Decode(bytes.NewReader(data))
		if derr != nil {
			failed++
			continue
		}
		if ext == "jpg" {
			src = applyOrientation(src, exifOrientation(data))
		}
		tb, eerr := encodeImage(scaleDown(src, ThumbEdge), ext)
		if eerr != nil {
			failed++
			continue
		}
		if err := os.WriteFile(thumb, tb, 0o644); err != nil {
			failed++
			continue
		}
		optimized++
	}

	_ = markDone()
	logf("image migration: %d optimized, %d skipped, %d failed", optimized, skipped, failed)
}

// writeAtomic writes data to a sibling ".tmp" file and renames it over path.
func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
