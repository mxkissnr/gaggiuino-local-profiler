package backup

import (
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

// This file ports routes/backup.js's validateEntityImages/
// validateRestoredLibraryImages — the path-traversal / integrity guard a
// restored entity's `.image` field must pass before its bytes are ever
// written to a real filesystem path. The filename / path / magic-byte
// helpers it used to carry now live in internal/img, shared with
// internal/shots and internal/library (see that package's doc.go).

// imageDir mirrors lib/constants.js's BEAN_IMAGE_DIR. A var, not a const,
// purely so the tests can point export/import at a throwaway directory of
// synthetic images.
var imageDir = library.DefaultImageDir

// imageMaxBytes mirrors lib/constants.js's BEAN_IMAGE_MAX_BYTES.
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
// after the DB transaction commits — mirrors routes/backup.js's
// pendingImageWrites array. It holds only the target path and the source
// entry name (never the bytes): writePendingImages streams the bytes from
// the restore image source zip-entry -> disk, so many restored images
// never sum up in memory (#959).
type pendingImageWrite struct {
	path    string
	srcName string
}

// validateEntityImages ports validateEntityImages(list, prefix, imagesMap,
// pendingImageWrites): validates one entity list's id/image fields against
// the actual restored image bytes and appends a pendingImageWrite for each
// image that survives every check. Any entity whose image fails validation
// for any reason has its `.image` field cleared (set to nil) rather than
// left pointing at a file that will never exist — list entries are mutated
// in place, matching the Node original. The image bytes are read once here
// (capped at imageMaxBytes) for the magic-byte + size checks and dropped;
// writePendingImages re-reads them lazily to write.
func validateEntityImages(list []map[string]any, prefix string, imgs restoreImages, pending *[]pendingImageWrite) {
	for _, entity := range list {
		if entity == nil {
			continue
		}
		ext, _ := entity["image"].(string)
		if ext == "" {
			continue
		}
		if !extAllowed(ext) {
			entity["image"] = nil
			continue
		}
		id, ok := jsIntStrict(entity["id"])
		if !ok || id <= 0 {
			entity["image"] = nil
			continue
		}
		filename := img.Filename(id, ext, prefix)
		buf, present := imgs.get(filename)
		if !present || len(buf) == 0 || len(buf) > imageMaxBytes || !img.MatchesMagicBytes(buf, ext) {
			entity["image"] = nil
			continue
		}
		*pending = append(*pending, pendingImageWrite{path: imagePath(id, ext, prefix), srcName: filename})
	}
}

// libraryImageEntityTypes mirrors IMAGE_ENTITY_TYPES: the library entity
// types that can carry an uploaded image, and the filename prefix each
// uses.
var libraryImageEntityTypes = []struct {
	key    string
	prefix string
}{
	{"beans", ""},
	{"grinders", "grinder-"},
	{"baskets", "basket-"},
	{"puckScreens", "puckscreen-"},
}

// validateRestoredLibraryImages ports validateRestoredLibraryImages(lib,
// imagesMap, pendingImageWrites): one validateEntityImages call per
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
