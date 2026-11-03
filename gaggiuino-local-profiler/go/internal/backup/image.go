package backup

import (
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

// This file holds validateEntityImages/validateRestoredLibraryImages — the
// path-traversal / integrity guard a restored entity's `.image` field must
// pass before its bytes are ever written to a real filesystem path, and the
// matching guard for its `imageCrop` + uncropped original (#1845). The
// filename / path / magic-byte helpers live in internal/img, shared with
// internal/shots and internal/library (see that package's doc.go).

// imageDir is the bean image directory. A var, not a const, purely so the
// tests can point export/import at a throwaway directory of synthetic images.
var imageDir = library.DefaultImageDir

// imageMaxBytes is the per-image size cap.
const imageMaxBytes = img.MaxBytes

// imagePath is the package-local shorthand for img.Path bound to imageDir
// (the restore path never crosses image directories).
func imagePath(id int64, ext, prefix string) string {
	return img.Path(imageDir, id, ext, prefix)
}

// extAllowed reports whether an `.image` field's value is one of the
// whitelisted on-disk extensions.
func extAllowed(ext string) bool {
	_, ok := img.ExtContentType[ext]
	return ok
}

// pendingImageWrite is one validated image queued to be written to disk
// after the DB transaction commits. It holds only the target path and the
// source entry name (never the bytes): writePendingImages streams the bytes
// from the restore image source zip-entry -> disk, so many restored images
// never sum up in memory (#959).
//
// An entry is either a main image (original == false) or the uncropped
// original that goes with one (original == true, same id/prefix). id and
// prefix are kept so the applier can address the original's path and delete
// a stale copy through internal/img's helpers.
type pendingImageWrite struct {
	path     string
	srcName  string
	id       int64
	prefix   string
	original bool
}

// mainImageCount is how many photos (not files) a queue would write: the
// entries that are not an uncropped original. The dry-run preview and the
// restore response both report this, so adding originals never looks like
// "twice as many photos".
func mainImageCount(pending []pendingImageWrite) int {
	n := 0
	for _, w := range pending {
		if !w.original {
			n++
		}
	}
	return n
}

// restoredCrop reads an entity's `imageCrop` from a decoded bundle. It is
// deliberately stricter than the route readers (library.entityCrop,
// shots.shotCrop): all four values must be JSON numbers that pass
// jsFiniteNumber — a string is rejected, not parsed — and the rectangle must
// be Valid(). Restore only ever drops a crop, never invents one.
func restoredCrop(v any) (img.Crop, bool) {
	m, ok := v.(map[string]any)
	if !ok {
		return img.Crop{}, false
	}
	values := make([]float64, 4)
	for i, key := range []string{"x", "y", "w", "h"} {
		n, ok := jsFiniteNumber(m[key])
		if !ok {
			return img.Crop{}, false
		}
		values[i] = n
	}
	c := img.Crop{X: values[0], Y: values[1], W: values[2], H: values[3]}
	if !c.Valid() {
		return img.Crop{}, false
	}
	return c, true
}

// validateEntityImages validates one entity list's id/image fields against
// the actual restored image bytes and appends a pendingImageWrite for each
// image that survives every check. Any entity whose image fails validation
// for any reason has its `.image` field cleared (set to nil) rather than
// left pointing at a file that will never exist — list entries are mutated
// in place. The image bytes are read once here (capped at imageMaxBytes) for
// the magic-byte + size checks and dropped; writePendingImages re-reads them
// lazily to write.
//
// `imageCrop` is validated with the photo it belongs to (#1845). The
// invariant is "a valid crop <=> a valid original file exists", so a crop is
// kept only when the bundle also carries that photo's `<prefix><id>.orig.jpg`
// as a JPEG within imageMaxBytes; the original is then queued immediately
// after the photo. In every other case the crop is dropped, and an original
// without a crop is never queued — restore cannot create a half-pair.
func validateEntityImages(list []map[string]any, prefix string, imgs restoreImages, pending *[]pendingImageWrite) {
	for _, entity := range list {
		if entity == nil {
			continue
		}
		ext, _ := entity["image"].(string)
		if ext == "" {
			delete(entity, "imageCrop")
			continue
		}
		if !extAllowed(ext) {
			entity["image"] = nil
			delete(entity, "imageCrop")
			continue
		}
		id, ok := jsIntStrict(entity["id"])
		if !ok || id <= 0 {
			entity["image"] = nil
			delete(entity, "imageCrop")
			continue
		}
		filename := img.Filename(id, ext, prefix)
		buf, present := imgs.get(filename)
		if !present || len(buf) == 0 || len(buf) > imageMaxBytes || !img.MatchesMagicBytes(buf, ext) {
			entity["image"] = nil
			delete(entity, "imageCrop")
			continue
		}
		*pending = append(*pending, pendingImageWrite{
			path: imagePath(id, ext, prefix), srcName: filename, id: id, prefix: prefix,
		})

		crop, ok := restoredCrop(entity["imageCrop"])
		if !ok {
			delete(entity, "imageCrop")
			continue
		}
		origName := img.OriginalFilename(id, prefix)
		obuf, present := imgs.get(origName)
		if !present || len(obuf) == 0 || len(obuf) > imageMaxBytes || !img.MatchesMagicBytes(obuf, "jpg") {
			delete(entity, "imageCrop")
			continue
		}
		entity["imageCrop"] = map[string]any{"x": crop.X, "y": crop.Y, "w": crop.W, "h": crop.H}
		*pending = append(*pending, pendingImageWrite{
			path:     img.OriginalPath(imageDir, id, prefix),
			srcName:  origName,
			id:       id,
			prefix:   prefix,
			original: true,
		})
	}
}

// libraryImageEntityTypes lists the library entity types that can carry an
// uploaded image, and the filename prefix each uses.
var libraryImageEntityTypes = []struct {
	key    string
	prefix string
}{
	{"beans", ""},
	{"grinders", "grinder-"},
	{"baskets", "basket-"},
	{"puckScreens", "puckscreen-"},
}

// validateRestoredLibraryImages runs one validateEntityImages call per
// library entity type. lib is the map-of-lists JSON shape produced by
// decoding the backup's raw `coffee_library` field (not library.Library —
// this runs before/independent of SanitizeLibraryForRestore's typed pass).
func validateRestoredLibraryImages(lib map[string]any, imgs restoreImages, pending *[]pendingImageWrite) {
	if lib == nil {
		return
	}
	for _, t := range libraryImageEntityTypes {
		arr, ok := lib[t.key].([]any)
		if !ok {
			continue
		}
		list := make([]map[string]any, 0, len(arr))
		for _, v := range arr {
			if m, ok := v.(map[string]any); ok {
				list = append(list, m)
			}
		}
		validateEntityImages(list, t.prefix, imgs, pending)
	}
}
