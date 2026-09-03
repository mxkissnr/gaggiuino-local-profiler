// Package backup is the Go port of routes/backup.js (Phase 1f, issue
// #901): scoped/full backup export (the legacy self-contained JSON shape
// GET /api/backup always returns, and the zip shape POST /api/backup
// produces), restore (POST /api/restore — dry-run preview, per-section
// apply, passphrase-encrypted secrets via AES-256-GCM-scrypt), and the
// image path-traversal/integrity validation restore depends on.
//
// File layout:
//
//	model.go     BACKUP_SECTIONS / SECTION_BUNDLE_KEYS /
//	              SECTION_PRESENCE_BUNDLE_KEYS / normaliseSections(raw)
//	kv.go         MqttSettingsRepository.js/ImportSettingsRepository.js's
//	              get/save round trip — narrowly, just what the `kv` block
//	              needs (see its own doc comment)
//	crypto.go     lib/backup-crypto.js — AES-256-GCM-scrypt secrets encryption
//	image.go      ImageService.js's filename/path helpers (duplicated, same
//	              precedent as internal/shots' own copy) + the restore-time
//	              path-traversal/magic-bytes image validation guard
//	sanitize.go   the restore-time row sanitizers (maintenance/
//	              maintenance_log/order rows) — the coffee_library restore
//	              sanitizer itself lives in internal/library/
//	              restore_sanitize.go, since only that package can export it
//	              without an import cycle
//	ratelimit.go  lib/helpers.js's rateLimit(key, maxPerMinute) — same
//	              duplication precedent as internal/orders' own copy
//	bundle.go     gatherSmallSections — every backup section except shots/
//	              annotations/images (all small regardless of dataset size)
//	stream.go     writeBundleJSON — the incremental bundle-JSON writer that
//	              streams the shots array one hydrated shot at a time
//	restore.go    the POST /api/restore handler and everything it composes
//	              — the largest file in this package, deliberately split
//	              from handlers.go given its size
//	restore_stream.go  the streaming restore plumbing: body -> temp file,
//	              parseBundleStream, lazy zip image source, zip-bomb caps
//	handlers.go   GET/POST /api/backup, route registration, zip streaming
//
// # Cross-domain dependencies this phase closed
//
// Two backup-only gaps flagged as deferred by earlier phases are closed
// here:
//
//   - internal/machines/registry.go's RestoreMachines (flagged deferred in
//     that package's own doc.go through Phase 1e) is now ported. NOT
//     included: evictLiveSession(oldHost) for every host that existed
//     before the restore (a stale WS session reconnects/fails naturally
//     against a host nothing identifies anymore, rather than being torn
//     down immediately — cosmetic timing, not data correctness) and
//     options-adoption.js's reconcileAfterRestore() (ties a restored
//     machine's stale host/switchEntity back to the current legacy add-on
//     options.json — no options.json facade exists in this Go port yet).
//     See RestoreMachines' own doc comment.
//   - internal/library's whole-entity restore sanitizers
//     (sanitizeBeanFields et al., flagged deferred in that package's
//     sanitize.go through Phase 1d) are now ported, in
//     internal/library/restore_sanitize.go, and called from this
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
// # Deliberately deferred in this phase
//
//   - Cross-section atomicity: routes/backup.js wraps every restore write
//     in one getDb().transaction(...). #959 closed most of that gap — the
//     structured shots restore (wipe + every shot upsert + annotations +
//     trash + blocklist + library-save) now commits as ONE transaction
//     via shots.Repository.RestoreShots, and orders restore is one tx
//     (orders.ReplaceAll). What is still NOT Node-identical: atomicity
//     *across* sections — a failure after the shots tx commits but during
//     a later section (maintenance, machines, kv) leaves shots restored
//     and that section not. Threading a shared *sql.Tx through every
//     repository across five packages (the only in-process way to close
//     it) remains out of scope. Flagged again in restore.go's header and
//     go/README.md's status section.
//   - A restored API token (POST /api/restore's decrypted secrets.apiToken)
//     is persisted to TOKEN_FILE on disk, but does NOT take effect in the
//     already-running Go server process: internal/auth.RequireToken closes
//     over a fixed token string at startup (cmd/server/main.go), with no
//     mutable/live token source the way Node's state.apiToken is. A
//     restarted process picks up the new token correctly (LoadOrCreateToken
//     reads the file); a not-yet-restarted one keeps accepting the old
//     token. See Dependencies.Token's doc comment.
//   - routes/debug.js's GET /api/debug/export-db / POST /api/debug/import-db
//     (raw SQLite file dump/restore, ~500MB body limit) are NOT part of
//     this package: they're closely related to backup/restore in spirit
//     but are a separate route file Node itself never merged into
//     routes/backup.js, and are a materially different mechanism
//     (whole-file SQLite blob, not a structured JSON bundle). Phase 2e
//     (#901) ported them into their own package, internal/debug.
//   - lib/zip.js's hand-rolled DEFLATE/CRC32 ZIP reader-writer is not
//     ported at all: Go's stdlib archive/zip already implements the same
//     ZIP format (APPNOTE.TXT, DEFLATE) that hand-rolled version targets,
//     so the export streams entries through an archive/zip.Writer and
//     restore reads them back through archive/zip.OpenReader on the
//     spooled temp file.
//
// See openapi.yaml's Backup tag for the frozen contract this package
// satisfies.
package backup
