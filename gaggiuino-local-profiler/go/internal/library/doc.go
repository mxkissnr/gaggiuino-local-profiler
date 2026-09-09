// Package library is the Go port of the coffee library domain (Phase 1d,
// issue #901): routes/library/{index,beans,grinders,baskets,puckscreens,
// milks,recipes,scan}.js's REST endpoints, the subset of
// lib/services/LibraryService.js's methods those routes actually call, and
// lib/repositories/LibraryRepository.js's getLibrary()/saveLibrary() DB
// access — the largest and most subdivided REST domain in this rewrite, per
// go/README.md's Status section.
//
// File layout mirrors the Node source it ports:
//
//	model.go               shared Entity/Library types + JS-semantics helpers
//	                        (parseInt/parseFloat coercion, trim/slice, etc.)
//	repository.go           lib/repositories/LibraryRepository.js's
//	                         getLibrary()/saveLibrary() (the `library` table)
//	sanitize.go              lib/sanitize-bean.js's individual field sanitizers
//	image.go                 lib/services/ImageService.js (full — including the
//	                          URL-fetch half shots/image.go doesn't need)
//	ssrf.go                  lib/ssrf-guard.js's assertPublicHost
//	ratelimit.go             lib/helpers.js's rateLimit(key, maxPerMinute)
//	service.go               the LibraryService.js methods this phase calls
//	                          (getBeansInfo/computeGrinderWearStats/
//	                          upsertKnownGrindSetting/setBeanImage)
//	handlers.go              routes/library/index.js + shared handler plumbing
//	handlers_beans.go        routes/library/beans.js
//	handlers_grinders.go     routes/library/grinders.js
//	handlers_baskets.go      routes/library/baskets.js
//	handlers_puckscreens.go  routes/library/puckscreens.js
//	handlers_milks.go        routes/library/milks.js
//	handlers_recipes.go      routes/library/recipes.js
//	scan.go                  routes/library/scan.js
//	orders_support.go        (Phase 1f) getActiveBeans/getActiveMilks/
//	                          deductMilkByName/computeBeanRemaining, for the
//	                          orders domain
//	restore_sanitize.go      (Phase 1f) lib/sanitize-bean.js's whole-entity
//	                          sanitizers, for the backup domain's restore path
//
// # Deliberately not ported in this phase
//
// Per the Phase 1d task's explicit scope, the five LibraryService.js
// migrateX() methods (migrateImportedNotes/migrateNotesToFlavors/
// migrateOriginToOrigins/migrateVarietyToSpecies/migrateAnnotationBeanIds)
// are one-time startup migrations against data already migrated on every
// install this Go binary can run against — not ported, matching the task's
// instruction. None of the five turned out to be live business logic on
// inspection (all are idempotent, guarded by "already has the new field"
// checks, and only ever called once at process startup in server.js) — no
// flag needed there.
//
// Two of the three cross-domain gaps flagged in the original (Phase 1d)
// version of this comment were closed in Phase 1f (#901):
//
//   - The maintenance-table cleanup POST /api/library/grinder/:id/delete
//     runs (dropping the deleted grinder's `grinder_{id}` row) is now
//     wired via a callback — see handlers.go's SetOnGrinderDeleted and
//     handlers_grinders.go's deleteGrinder. internal/maintenance now
//     exists and already imports this package (for grinder-existence
//     checks and names), so the wiring runs the other direction to avoid
//     a cycle: cmd/server's main.go calls
//     libraryHandlers.SetOnGrinderDeleted(maintenanceRepo.DeleteGrinderTask)
//     once at startup.
//   - computeBeanRemaining/getActiveBeans/getActiveMilks/deductMilkByName
//     are now ported, in orders_support.go — the orders domain
//     (internal/orders) calls them for GET /api/orders/active-beans,
//     GET /api/orders/active-milks, and completeOrder's milk-stock
//     deduction. checkLowStockNotify/resolveBeanForAnnotation/
//     findBeanByName remain unported: those back the shots-annotate path's
//     #450/#456 deferrals (still shots/doc.go's scope, not touched here).
//
// Still deferred, unchanged from Phase 1d:
//
//   - LibraryService.js's geocodeBean (region -> map coordinates via
//     lib/geo.js, an external geocoding provider) is now ported (Phase 2g,
//     #901) in geo.go: CreateBean/UpdateBean call the package-level
//     GeocodeHook fire-and-forget when a bean's region is set/changed
//     (cmd/server wires it to a Geocoder; nil in tests). The outbound
//     Nominatim call goes through assertPublicHost (ssrf.go) like scan.go's
//     Open Food Facts call, and results are cached in the kv table.
//   - bus.emit(EVENTS.BEAN_CHANGED, ...) (routes/library/beans.js's
//     create/update/new-bag) is not fired: this Go port has no event bus.
//     internal/achievements now exists (Phase 2b) but re-evaluates on
//     every read instead of on bus events, so the only thing lost is the
//     restock badge's live "wasEmpty" moment (documented in
//     internal/achievements/doc.go). No effect on the Library REST
//     contract itself.
//
// See openapi.yaml's Library tag for the frozen response-shape contract.
// Where Node's actual runtime behavior and the OpenAPI doc disagree (e.g.
// Grinder.wear's real field names are shotsSinceBurrs/gramsSinceBurrs, not
// the doc's shots/grams — see handlers.go's withWear), this package matches
// Node's real behavior, not the doc, same rule shots/doc.go states.
package library
