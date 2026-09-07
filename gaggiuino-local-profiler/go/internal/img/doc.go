// Package img consolidates the entity-image helpers that were previously
// triplicated across internal/shots, internal/library and internal/backup
// (each of those packages' old image.go doc comments flagged "this should
// become a shared package once both exist") and adds the #961 optimize
// pipeline: every stored bean / grinder / basket / puck-screen / shot photo
// is decoded, downscaled to at most MaxEdge on its long edge, re-encoded
// without metadata (no EXIF / GPS), and written alongside a MaxEdge-capped
// thumbnail (<prefix><id>.thumb.<ext>).
//
// The single source of truth now lives here:
//
//   - filename / path construction (Filename, Path, ThumbFilename, ThumbPath)
//   - the content-type <-> extension whitelist (ContentTypeExt,
//     ExtContentType, ContentTypeKnown)
//   - the first-bytes magic-number sniff (MatchesMagicBytes)
//   - best-effort deletion of a stored image and its thumbnail (Delete)
//   - the upload / URL-fetch save path (Save)
//   - the restore write path (WriteOptimized)
//   - the one-time background migration of an existing library
//     (MigrateExisting)
package img
