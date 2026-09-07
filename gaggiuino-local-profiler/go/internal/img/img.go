package img

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DefaultImageDir mirrors lib/constants.js's BEAN_IMAGE_DIR — the one
// directory every entity photo (bean/grinder/basket/puckScreen/shot) lives
// in, distinguished by filename prefix (see Filename). Handlers take this as
// an injectable field so tests can point uploads at a t.TempDir() instead
// of the real /data mount.
const DefaultImageDir = "/data/bean-images"

// MaxBytes mirrors lib/constants.js's BEAN_IMAGE_MAX_BYTES — the cap on a
// raw uploaded / fetched / restored image body.
const MaxBytes = 4 * 1024 * 1024

// MaxEdge / ThumbEdge are the #961 downscale targets: the long edge of the
// stored full image and of its thumbnail, in pixels. Downscale only — an
// image already within bounds is never upscaled.
const (
	MaxEdge   = 1600
	ThumbEdge = 320
)

// JPEGQuality is the quality passed to jpeg.Encode for every re-encoded
// opaque image.
const JPEGQuality = 85

// MaxPixels caps the decoded dimensions (width * height) of any image the
// pipeline will hand to a decoder. The bytes are attacker-controlled and a
// highly-compressible format (a ~4 MB PNG at zlib's ~1000:1 ceiling)
// decodes to gigabytes of RGBA — so DecodeConfig is checked first and an
// over-cap image is left untouched (stored raw on upload, skipped on
// migration), matching the pre-#961 "magic-byte check only" behaviour. ~50
// MP clears every real camera (a 200 MP phone sensor bins to well under
// this) with a wide margin.
const MaxPixels = 50_000_000

// withinPixelCap reports whether a w*h image is safe to decode.
func withinPixelCap(w, h int) bool {
	return w > 0 && h > 0 && int64(w)*int64(h) <= MaxPixels
}

// ContentTypeExt mirrors ImageService.js's CONTENT_TYPE_EXT: the whitelist
// of image content types the app accepts, mapped to the on-disk extension.
var ContentTypeExt = map[string]string{
	"image/jpeg": "jpg",
	"image/png":  "png",
	"image/webp": "webp",
	"image/gif":  "gif",
}

// ExtContentType is ContentTypeExt inverted — ports the effect of Node's
// `res.type(ext)` (mime-type lookup by extension) for GET .../image.
var ExtContentType = map[string]string{
	"jpg":  "image/jpeg",
	"png":  "image/png",
	"webp": "image/webp",
	"gif":  "image/gif",
}

// knownExt reports whether ext is one of the four whitelisted on-disk
// extensions.
func knownExt(ext string) bool {
	_, ok := ExtContentType[ext]
	return ok
}

// ContentTypeKnown reports whether contentType (optionally with a
// "; charset=..." suffix, as raw Content-Type headers carry) names one of
// the whitelisted image types, returning the on-disk extension.
func ContentTypeKnown(contentType string) (ext string, ok bool) {
	base := strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0])
	ext, ok = ContentTypeExt[base]
	return ext, ok
}

// Filename ports ImageService.js's imageFilename: prefix distinguishes
// entity types sharing the image dir ("shot-", "grinder-", …) so ids can
// never collide across types (beans use the empty prefix).
func Filename(id int64, ext, prefix string) string {
	return fmt.Sprintf("%s%d.%s", prefix, id, ext)
}

// Path ports ImageService.js's imagePath.
func Path(dir string, id int64, ext, prefix string) string {
	return filepath.Join(dir, Filename(id, ext, prefix))
}

// ThumbFilename is Filename with a ".thumb" infix — the #961 thumbnail
// variant served for `?thumb=1` requests.
func ThumbFilename(id int64, ext, prefix string) string {
	return fmt.Sprintf("%s%d.thumb.%s", prefix, id, ext)
}

// ThumbPath is Path for the thumbnail variant.
func ThumbPath(dir string, id int64, ext, prefix string) string {
	return filepath.Join(dir, ThumbFilename(id, ext, prefix))
}

// thumbPathFor derives the ".thumb.<ext>" sibling of a full-image path,
// e.g. "/d/grinder-5.jpg" -> "/d/grinder-5.thumb.jpg".
func thumbPathFor(path, ext string) string {
	return strings.TrimSuffix(path, filepath.Ext(path)) + ".thumb." + ext
}

// Delete ports ImageService.js's deleteImage: best-effort removal of a
// stored image AND its thumbnail, silently ignoring an already-missing
// file.
func Delete(dir string, id int64, ext, prefix string) {
	if ext == "" {
		return
	}
	_ = os.Remove(Path(dir, id, ext, prefix))
	_ = os.Remove(ThumbPath(dir, id, ext, prefix))
}

// ServePath returns the filesystem path a `GET .../image` handler should
// serve. When thumb is true and a thumbnail file actually exists it is
// preferred; otherwise the full-image path is returned, so a missing or
// never-generated thumbnail transparently falls back to full resolution and
// never 404s. The caller still stat-checks the returned path for its
// not-found response.
func ServePath(dir string, id int64, ext, prefix string, thumb bool) string {
	if thumb {
		tp := ThumbPath(dir, id, ext, prefix)
		if st, err := os.Stat(tp); err == nil && !st.IsDir() {
			return tp
		}
	}
	return Path(dir, id, ext, prefix)
}

// MatchesMagicBytes ports ImageService.js's matchesImageMagicBytes: a
// first-bytes sniff for the whitelisted image types. Content-Type headers
// and extensions are caller-supplied and trivially spoofable, so a blob
// claiming to be `png` must actually start with a PNG signature before it
// is ever written to disk or handed to a decoder.
func MatchesMagicBytes(buf []byte, ext string) bool {
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
