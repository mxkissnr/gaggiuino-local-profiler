// Package maintenance covers static and per-grinder maintenance task
// tracking, thresholds, the maintenance log, and the machineId=all
// aggregate view (computeAllMachinesMaintenance). The maintenance-table
// halves of the coffee-library domain live in their own package here
// rather than alongside the library (see internal/library/doc.go's
// matching note on the library side of that split).
//
// File layout:
//
//	model.go       Task type, MAINTENANCE_DEFAULTS, isGlobalMaintenanceTask,
//	                canonicalTask
//	repository.go  the `maintenance`/`maintenance_log` tables (including the
//	                raw round-trip methods the backup domain calls)
//	service.go     computeMaintenanceStats, computeAllMachinesMaintenance
//	handlers.go    the HTTP handlers
//
// # Grinder deletion cleanup
//
// internal/library's deleteGrinder handler left a genuine gap: deleting a
// grinder didn't clean up its `grinder_{id}` row in the `maintenance`
// table, because this package didn't exist yet. Closed here via
// Repository.DeleteGrinderTask, wired as a callback —
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
