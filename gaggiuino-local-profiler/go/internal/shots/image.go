package shots

import (
	"errors"
	"log"
	"net/url"
	"os"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// The image helpers this package used to carry (imagePath / deleteImage /
// saveUploadedImage / the content-type whitelist / the magic-byte sniff)
// now live in internal/img, shared with internal/library and
// internal/backup — see that package's doc.go. DefaultImageDir stays
// re-exported here because Handlers takes it as an injectable field and
// tests reference shots.DefaultImageDir. A var so it picks up img's
// GLP_IMAGE_DIR override (see internal/img/img.go).
var DefaultImageDir = img.DefaultImageDir

// shotCrop reads a shot's stored `imageCrop` rectangle. It reports false
// unless the stored object is a complete, valid crop — a malformed stored
// value degrades to "no crop", never to a panic or a bogus rectangle. A shot
// carries `imageCrop` exactly when its uncropped original is on disk.
func shotCrop(s Shot) (img.Crop, bool) {
	raw, ok := s["imageCrop"].(map[string]any)
	if !ok {
		return img.Crop{}, false
	}
	values := make([]float64, 4)
	for i, key := range []string{"x", "y", "w", "h"} {
		v, ok := toFloat(raw[key])
		if !ok {
			return img.Crop{}, false
		}
		values[i] = v
	}
	c := img.Crop{X: values[0], Y: values[1], W: values[2], H: values[3]}
	if !c.Valid() {
		return img.Crop{}, false
	}
	return c, true
}

// cropShot is the stored shape of img.Crop on a shot.
func cropShot(c img.Crop) map[string]any {
	return map[string]any{"x": c.X, "y": c.Y, "w": c.W, "h": c.H}
}

// parseCropParam parses a `crop=x,y,w,h` query value, reporting false for both
// a malformed and an out-of-range rectangle.
func parseCropParam(raw string) (img.Crop, bool) {
	c, err := img.ParseCrop(raw)
	if err != nil || !c.Valid() {
		return img.Crop{}, false
	}
	return c, true
}

// validImageQuery reports whether the query is one of the three supported
// image-request shapes: no parameters, `crop` alone, or `original=1` with
// `crop`. `original` must be exactly "1" — the value GET .../image treats as
// "serve the original".
func validImageQuery(q url.Values) bool {
	for name, values := range q {
		switch name {
		case "crop":
			if len(values) != 1 {
				return false
			}
		case "original":
			if len(values) != 1 || values[0] != "1" {
				return false
			}
		default:
			return false
		}
	}
	return true
}

// MoveShotImageFiles (#1162) is the best-effort other half of moving a
// misfiled shot: it renames the shot's photo files in dir from the old id to
// the new one — the full image (shot-<oldID>.<ext>), its thumbnail
// (shot-<oldID>.thumb.<ext>) and its uncropped original
// (shot-<oldID>.orig.jpg, always JPEG whatever ext is). It is deliberately
// total: a shot without one of those files is normal and skipped, an existing
// target is never overwritten, and any other rename failure is logged rather
// than returned, so a stale photo file can never fail the sync that moved its
// row.
func MoveShotImageFiles(dir string, oldID, newID int64, ext string) {
	if !img.KnownExt(ext) || oldID == newID {
		return
	}
	moveShotImageFile(img.Path(dir, oldID, ext, "shot-"), img.Path(dir, newID, ext, "shot-"))
	moveShotImageFile(img.ThumbPath(dir, oldID, ext, "shot-"), img.ThumbPath(dir, newID, ext, "shot-"))
	moveShotImageFile(img.OriginalPath(dir, oldID, "shot-"), img.OriginalPath(dir, newID, "shot-"))
}

// moveShotImageFile renames one photo file, tolerating the two cases that are
// not failures: the source is already gone (no photo under the old id) and
// the target already exists (never clobber it).
func moveShotImageFile(oldPath, newPath string) {
	if _, err := os.Stat(oldPath); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("shots: stat image %s: %v", oldPath, err)
		}
		return
	}
	if _, err := os.Stat(newPath); err == nil {
		return
	}
	if err := os.Rename(oldPath, newPath); err != nil {
		log.Printf("shots: moving image %s -> %s: %v", oldPath, newPath, err)
	}
}
