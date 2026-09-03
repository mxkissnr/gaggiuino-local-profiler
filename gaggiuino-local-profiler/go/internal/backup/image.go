package backup

import (
	"bytes"
	"fmt"
	"path/filepath"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

// This file ports lib/services/ImageService.js's imageFilename/imagePath
// (duplicated here rather than exported from internal/library, the same
// "small enough to duplicate" precedent internal/shots' own image.go
// already set relative to internal/library's) plus routes/backup.js's
// validateEntityImages/validateRestoredLibraryImages — the actual path-
// traversal/integrity guard a restored entity's `.image` field must pass
// before its bytes are ever written to a real filesystem path.

// imageDir mirrors lib/constants.js's BEAN_IMAGE_DIR — reused from
// internal/library rather than a second copy of the literal path. A var,
// not a const, purely so memory_test.go can point export/import at a
// throwaway directory of synthetic images.
var imageDir = library.DefaultImageDir

// imageMaxBytes mirrors lib/constants.js's BEAN_IMAGE_MAX_BYTES.
const imageMaxBytes = 4 * 1024 * 1024

// contentTypeExtensions mirrors ImageService.js's CONTENT_TYPE_EXT values
// — the whitelist of extensions an `.image` field may ever legitimately
// hold.
var contentTypeExtensions = map[string]bool{"jpg": true, "png": true, "webp": true, "gif": true}

func imageFilename(id int64, ext, prefix string) string {
	return fmt.Sprintf("%s%d.%s", prefix, id, ext)
}

func imagePath(id int64, ext, prefix string) string {
	return filepath.Join(imageDir, imageFilename(id, ext, prefix))
}

// matchesImageMagicBytes ports ImageService.js's matchesImageMagicBytes:
// a first-bytes sniff for the four whitelisted image types — Content-Type
// headers/extensions are caller-supplied and trivially spoofable, so a
// blob claiming to be `png` must actually start with a PNG signature
// before it's ever written to disk.
func matchesImageMagicBytes(buf []byte, ext string) bool {
	if len(buf) < 12 {
		return false
	}
	switch ext {
	case "jpg":
		return buf[0] == 0xFF && buf[1] == 0xD8 && buf[2] == 0xFF
	case "png":
		return bytes.Equal(buf[:8], []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A})
	case "gif":
		return bytes.Equal(buf[:4], []byte("GIF8"))
	case "webp":
		return string(buf[:4]) == "RIFF" && string(buf[8:12]) == "WEBP"
	default:
		return false
	}
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
		if !contentTypeExtensions[ext] {
			entity["image"] = nil
			continue
		}
		id, ok := jsIntStrict(entity["id"])
		if !ok || id <= 0 {
			entity["image"] = nil
			continue
		}
		filename := imageFilename(id, ext, prefix)
		buf, present := imgs.get(filename)
		if !present || len(buf) == 0 || len(buf) > imageMaxBytes || !matchesImageMagicBytes(buf, ext) {
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
