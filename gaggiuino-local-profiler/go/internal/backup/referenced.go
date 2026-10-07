package backup

import (
	"os"
	"path/filepath"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file implements #1525: which stored image files an install still
// refers to, the backup's use of that set (skip orphaned app-named files),
// and the startup sweep that deletes them.

// referencedImageNames returns the set of stored image basenames some row
// still refers to: every library entity that carries an `image` extension
// (beans/grinders/baskets/puck screens), and the photo of every shot that
// exists — trashed shots included, since their rows (and therefore their
// photos) are still live until the trash purge drops them.
//
// Only main images are returned; thumbnails are derived from a full image
// (see img.FullImageName) and are kept or dropped with it. The set lives in
// this package because internal/img cannot import internal/library or
// internal/shots (both import img), so a shared builder here is importable by
// both the backup path and cmd/server's startup cleanup.
func referencedImageNames(libRepo *library.Repository, shotsRepo *shots.Repository) (map[string]struct{}, error) {
	names := make(map[string]struct{})

	lib, err := libRepo.GetLibrary()
	if err != nil {
		return nil, err
	}
	for _, t := range libraryImageEntityTypes {
		for _, e := range libraryEntitiesFor(lib, t.key) {
			addEntityImage(names, e, t.prefix)
		}
	}

	// Streamed, not FindAll: the export path this feeds is O(1) in shot
	// count, and hydrating every shot's datapoints here would undo that.
	err = shotsRepo.ForEachImageRef(func(id int64, ext string) error {
		names[img.Filename(id, ext, "shot-")] = struct{}{}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return names, nil
}

// addEntityImage records the image file name entity's `image` extension and
// numeric `id` resolve to under prefix, if both are present and valid.
func addEntityImage(names map[string]struct{}, entity map[string]any, prefix string) {
	ext, _ := entity["image"].(string)
	if ext == "" {
		return
	}
	id, ok := jsIntStrict(entity["id"])
	if !ok || id <= 0 {
		return
	}
	names[img.Filename(id, ext, prefix)] = struct{}{}
}

// libraryEntitiesFor returns the entity list a libraryImageEntityTypes key
// names. The switch (rather than reflection) keeps the mapping explicit.
func libraryEntitiesFor(lib library.Library, key string) []library.Entity {
	switch key {
	case "beans":
		return lib.Beans
	case "grinders":
		return lib.Grinders
	case "baskets":
		return lib.Baskets
	case "puckScreens":
		return lib.PuckScreens
	default:
		return nil
	}
}

// imageBundled reports whether a main image file name should be included in a
// backup. A nil referenced set means the lookup failed, so everything is
// bundled (never risk dropping a referenced photo). Otherwise an app-named
// file is bundled only when referenced, while a foreign name that matches no
// app pattern is preserved — no entry can refer to it, and dropping it would
// lose a file the app did not create.
func imageBundled(name string, referenced map[string]struct{}) bool {
	if referenced == nil {
		return true
	}
	if _, ok := referenced[name]; ok {
		return true
	}
	return !img.KnownImageName(name)
}

// removeUnreferencedImages deletes every app-named image file in dir that no
// entry refers to, together with its ".thumb." sibling: a name whose full
// image is not in referenced is removed whether it is the full image itself
// or its thumbnail. A file matching none of the app's own patterns is left
// alone, as is every directory. Returns the number of files removed and the
// bytes they occupied.
func removeUnreferencedImages(dir string, referenced map[string]struct{}, logf func(string, ...any)) (removed int, freed int64) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, 0
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		full := img.FullImageName(name)
		if !img.KnownImageName(full) {
			continue // not one of the app's own image names — never touch it
		}
		if _, ok := referenced[full]; ok {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if err := os.Remove(filepath.Join(dir, name)); err != nil {
			if !os.IsNotExist(err) {
				logf("image cleanup: removing %s: %v", name, err)
			}
			continue
		}
		removed++
		freed += info.Size()
	}
	return removed, freed
}

// CleanupOrphanedImages removes image files (and their thumbnails) in dir
// that no library entry or existing shot refers to. It builds the referenced
// set first; if that fails it removes nothing, so a transient DB error can
// never delete a live photo. Intended to run once at startup, after the image
// migration, on a background goroutine.
//
// Delete paths checked for #1525: the four library entry handlers
// (beans/grinders/baskets/puck screens) and POST /api/shots/{id}/delete
// already remove their photo via img.Delete; the trash purge
// (shots.Repository.PurgeExpiredTrash) and shots moved/purged outside those
// handlers do not, which is what this sweep reclaims.
func CleanupOrphanedImages(dir string, libRepo *library.Repository, shotsRepo *shots.Repository, logf func(string, ...any)) {
	referenced, err := referencedImageNames(libRepo, shotsRepo)
	if err != nil {
		logf("image cleanup: building referenced set: %v (removing nothing)", err)
		return
	}
	removed, freed := removeUnreferencedImages(dir, referenced, logf)
	if removed > 0 {
		logf("image cleanup: removed %d orphaned image file(s), freed %d bytes", removed, freed)
	}
}
