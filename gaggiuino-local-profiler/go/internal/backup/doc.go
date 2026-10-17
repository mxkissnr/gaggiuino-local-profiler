// Package backup handles scoped/full backup export (the legacy
// self-contained JSON shape GET /api/backup always returns, and the zip
// shape POST /api/backup produces), restore (POST /api/restore — dry-run
// preview, per-section apply, passphrase-encrypted secrets via
// AES-256-GCM-scrypt), and the image path-traversal/integrity validation
// restore depends on.
//
// File layout:
//
//	model.go     backupSections / sectionBundleKeys /
//	              sectionPresenceBundleKeys / normaliseSections(raw)
//	kv.go         the mqtt/import settings get/save round trip — narrowly,
//	              just what the `kv` block needs (see its own doc comment)
//	crypto.go     AES-256-GCM-scrypt secrets encryption
//	image.go      the restore-time path-traversal/magic-bytes image
//	              validation guard (filename/path helpers are internal/img)
//	referenced.go which stored images a backup bundles, and orphan cleanup
//	sanitize.go   the restore-time row sanitizers (maintenance/
//	              maintenance_log/order rows) — the coffee_library restore
//	              sanitizer itself lives in internal/library/
//	              restore_sanitize.go, since only that package can export it
//	              without an import cycle
//	bundle.go     gatherSmallSections — every backup section except shots/
//	              annotations/images (all small regardless of dataset size)
//	stream.go     writeBundleJSON — the incremental bundle-JSON writer that
//	              streams the shots array one hydrated shot at a time
//	restore.go    the POST /api/restore handler (postRestore)
//	restore_plan.go  the validated restore plan and the dry-run preview
//	restore_apply.go applying a plan: per-section writes, kv, token, images
//	restore_stream.go  the streaming restore plumbing: body -> temp file,
//	              parseBundleStream, lazy zip image source, zip-bomb caps
//	handlers.go   GET/POST /api/backup, route registration, zip streaming
//
// Per-route rate limits use internal/ratelimit's keyed limiter.
//
// # Cross-domain dependencies
//
//   - internal/machines/registry.go's RestoreMachines handles machine
//     restore. It does not tear down live sessions for hosts that existed
//     before the restore; they idle out or reconnect on their own.
//   - internal/library's whole-entity restore sanitizers
//     (sanitizeBeanFields et al.) live in
//     internal/library/restore_sanitize.go, and are called from this
//     package's mapToLibrary.
//
// # Memory profile (#959)
//
// Every export/import path streams: peak Go heap growth is bounded by
// O(one shot + one image + the small non-shot sections) and does NOT rise
// with the shot/image count (proven by memory_test.go, which quadruples
// the dataset and asserts the same ceiling). The bundle JSON is written
// incrementally (stream.go) and parsed twice with a streaming decoder
// (restore_stream.go); restore images are read one body at a time from
// the zip on disk; the POST /api/restore body and the POST
// /api/debug/import-db body both go to a temp file, never a slice. The
// one remaining non-O(1) allocation is the `annotations` map (bounded by
// annotated-shot count, ~2 orders of magnitude below the datapoints
// payload) — noted, not a regression.
//
// # Deliberately deferred
//
//   - Cross-section atomicity: each section commits in its own transaction,
//     so a failure partway through a restore can leave earlier sections
//     applied and later ones not. The structured shots restore (wipe + every
//     shot upsert + annotations + trash + blocklist + library-save) commits
//     as ONE transaction via shots.Repository.RestoreShots, and orders
//     restore is one tx (orders.ReplaceAll); the two maintenance restores,
//     machines and kv are each their own. #959 closed most of the practical
//     gap, but atomicity *across* sections remains: a failure after the shots
//     tx commits but during a later section (maintenance, machines, kv)
//     leaves shots restored and that section not. Threading a shared *sql.Tx
//     through every repository across five packages (the only in-process way
//     to close it) remains out of scope. Flagged again in restore.go's header.
//   - A restored API token (POST /api/restore's decrypted secrets.apiToken)
//     is persisted to TOKEN_FILE on disk, but does NOT take effect in the
//     already-running Go server process: internal/auth.RequireToken closes
//     over a fixed token string at startup (cmd/server/main.go), with no
//     mutable/live token source. A restarted process picks up the new token
//     correctly (LoadOrCreateToken
//     reads the file); a not-yet-restarted one keeps accepting the old
//     token. See Dependencies.Token's doc comment.
//   - GET /api/debug/export-db / POST /api/debug/import-db
//     (raw SQLite file dump/restore, ~500MB body limit) are NOT part of
//     this package: they're closely related to backup/restore in spirit
//     but are a separate route, and are a materially different mechanism
//     (whole-file SQLite blob, not a structured JSON bundle). They live
//     in their own package, internal/debug.
//   - ZIP handling uses Go's stdlib: archive/zip already implements the
//     same ZIP format (APPNOTE.TXT, DEFLATE) the backup uses, so the export
//     streams entries through an archive/zip.Writer and restore reads them
//     back through archive/zip.OpenReader on the spooled temp file.
//
// See openapi.yaml's Backup tag for the contract this package satisfies.
package backup
