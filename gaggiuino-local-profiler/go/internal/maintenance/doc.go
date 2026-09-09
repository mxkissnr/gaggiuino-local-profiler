// Package maintenance is the Go port of routes/maintenance.js (Phase 1f,
// issue #901): static and per-grinder maintenance task tracking,
// thresholds, the maintenance log, and the machineId=all aggregate view
// (computeAllMachinesMaintenance). Also absorbs the maintenance-table
// halves of lib/repositories/LibraryRepository.js and
// lib/services/LibraryService.js Node keeps in the same files as the
// coffee-library domain — this Go port splits them into their own package
// instead (see internal/library/doc.go's matching note on the library
// side of that split).
//
// File layout:
//
//	model.go       Task type, MAINTENANCE_DEFAULTS, isGlobalMaintenanceTask,
//	                canonicalTask
//	repository.go  the `maintenance`/`maintenance_log` tables (including the
//	                raw round-trip methods the backup domain calls)
//	service.go     computeMaintenanceStats, computeAllMachinesMaintenance
//	handlers.go    routes/maintenance.js
//
// # The Phase 1d gap this phase closes
//
// internal/library's deleteGrinder handler (Phase 1d) left a genuine gap:
// deleting a grinder didn't clean up its `grinder_{id}` row in the
// `maintenance` table, because this package didn't exist yet. Closed here
// via Repository.DeleteGrinderTask, wired as a callback —
// library.Handlers.SetOnGrinderDeleted — rather than a direct import,
// since this package already imports internal/library (for grinder-
// existence checks in canonicalTask() and grinder names in
// GetMaintenance()/GetMaintenanceLog()); a reverse import would close a
// cycle. cmd/server's main.go wires the callback once at startup, after
// both packages' Handlers exist.
//
// See openapi.yaml's Maintenance tag for the frozen contract this package
// satisfies.
package maintenance
