package shots

import (
	"errors"
	"log"
	"os"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// The image helpers this package used to carry (imagePath / deleteImage /
// saveUploadedImage / the content-type whitelist / the magic-byte sniff)
// now live in internal/img, shared with internal/library and
// internal/backup — see that package's doc.go. DefaultImageDir stays
// re-exported here because Handlers takes it as an injectable field and
// tests reference shots.DefaultImageDir.
const DefaultImageDir = img.DefaultImageDir

// MoveShotImageFiles (#1162) is the best-effort other half of moving a
// misfiled shot: it renames the shot's photo files in dir from the old id to
// the new one — the full image (shot-<oldID>.<ext>) and its thumbnail
// (shot-<oldID>.thumb.<ext>). It is deliberately total: a shot without a
// photo or thumbnail is normal and skipped, an existing target is never
// overwritten, and any other rename failure is logged rather than returned,
// so a stale photo file can never fail the sync that moved its row.
func MoveShotImageFiles(dir string, oldID, newID int64, ext string) {
	if ext == "" || oldID == newID {
		return
	}
	moveShotImageFile(img.Path(dir, oldID, ext, "shot-"), img.Path(dir, newID, ext, "shot-"))
	moveShotImageFile(img.ThumbPath(dir, oldID, ext, "shot-"), img.ThumbPath(dir, newID, ext, "shot-"))
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
