// Package library is the coffee library domain: the REST endpoints for
// beans, grinders, baskets, puckscreens, milks, recipes and barcode scans,
// the shared service logic those endpoints call, and getLibrary()/
// saveLibrary() DB access — the largest and most subdivided REST domain in
// the server, per go/README.md's Status section.
//
// File layout:
//
//	model.go               shared Entity/Library types + JS-semantics helpers
//	                        (parseInt/parseFloat coercion, trim/slice, etc.)
//	repository.go           getLibrary()/saveLibrary() (the `library` table)
//	sanitize.go              individual field sanitizers
//	image.go                 image download/validation (including the
//	                          URL-fetch half shots/image.go doesn't need)
//	ssrf.go                  assertPublicHost
//	ratelimit.go             rateLimit(key, maxPerMinute)
//	service.go               getBeansInfo/computeGrinderWearStats/
//	                          upsertKnownGrindSetting/setBeanImage
//	handlers.go              route registration + shared handler plumbing
//	handlers_beans.go        bean endpoints
//	handlers_grinders.go     grinder endpoints
//	handlers_baskets.go      basket endpoints
//	handlers_puckscreens.go  puckscreen endpoints
//	handlers_milks.go        milk endpoints
//	handlers_recipes.go      recipe endpoints
//	scan.go                  barcode-scan endpoint
//	orders_support.go        getActiveBeans/getActiveMilks/deductMilkByName/
//	                          computeBeanRemaining, for the orders domain
//	restore_sanitize.go      whole-entity sanitizers, for the backup domain's
//	                          restore path
//
// # Deliberately not implemented
//
// The five migrateX() methods (migrateImportedNotes/migrateNotesToFlavors/
// migrateOriginToOrigins/migrateVarietyToSpecies/migrateAnnotationBeanIds)
// are one-time startup migrations against data already migrated on every
// install this binary can run against, so they are not implemented. None of
// the five turned out to be live business logic on inspection (all are
// idempotent, guarded by "already has the new field" checks) — no flag
// needed there.
//
// # Cross-domain wiring
//
//   - The maintenance-table cleanup POST /api/library/grinder/:id/delete
//     runs (dropping the deleted grinder's `grinder_{id}` row) is wired via
//     a callback — see handlers.go's SetOnGrinderDeleted and
//     handlers_grinders.go's deleteGrinder. internal/maintenance imports
//     this package (for grinder-existence checks and names), so the wiring
//     runs the other direction to avoid a cycle: cmd/server's main.go calls
//     libraryHandlers.SetOnGrinderDeleted(maintenanceRepo.DeleteGrinderTask)
//     once at startup.
//   - computeBeanRemaining/getActiveBeans/getActiveMilks/deductMilkByName
//     live in orders_support.go — the orders domain (internal/orders) calls
//     them for GET /api/orders/active-beans, GET /api/orders/active-milks,
//     and completeOrder's milk-stock deduction. checkLowStockNotify/
//     resolveBeanForAnnotation/findBeanByName are not implemented: those back
//     the shots-annotate path's #450/#456 deferrals (still shots/doc.go's
//     scope, not touched here).
//   - Region -> map coordinates (via an external geocoding provider) live in
//     geo.go: CreateBean/UpdateBean call the package-level GeocodeHook
//     fire-and-forget when a bean's region is set/changed (cmd/server wires
//     it to a Geocoder; nil in tests). The outbound Nominatim call goes
//     through assertPublicHost (ssrf.go) like scan.go's Open Food Facts
//     call, and results are cached in the kv table.
//   - Bean-change events are not fired through an event bus (this server has
//     none): internal/achievements re-evaluates on every read instead, and
//     the restock badge's live "wasEmpty" moment is driven explicitly —
//     newBag calls the Handlers.SetOnBeanRestocked callback cmd/server wires
//     to the achievements service (#1286 R2), so the badge unlocks again. No
//     effect on the Library REST contract itself.
//
// See openapi.yaml's Library tag for the frozen response-shape contract.
// Where the running behavior and the OpenAPI doc disagree (e.g.
// Grinder.wear's real field names are shotsSinceBurrs/gramsSinceBurrs, not
// the doc's shots/grams — see handlers.go's withWear), the behavior wins,
// not the doc, same rule shots/doc.go states.
package library
