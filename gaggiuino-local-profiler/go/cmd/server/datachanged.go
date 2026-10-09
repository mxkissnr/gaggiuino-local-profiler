package main

import "github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"

// dataKinds is every data-change kind the server publishes. sse.NewDataChanges
// seeds one revision per kind at start; a kind not listed here would be added
// on first use instead.
var dataKinds = []string{
	"library",
	"library-image",
	"shot",
	"shots",
	"orders",
	"maintenance",
	"ui-prefs",
	"settings",
	"profiles",
}

// dataRoutes classifies every write route the mux serves by the data-change
// kinds it changes, and dataIgnored records the write routes that deliberately
// publish nothing. datachanged_test.go fails when a documented write route is
// missing from one of the two, so a new route must be classified here.
var dataRoutes = buildDataRoutes()

// dataIgnored maps a write route the mux serves to the reason it publishes no
// data-changed event. A route belongs here only when it writes nothing to
// GLP's own database, or when another push already covers its change.
var dataIgnored = buildDataIgnored()

// buildDataRoutes is a function rather than a map literal so each entry is a
// short statement that names its own kinds.
func buildDataRoutes() map[string]sse.Route {
	routes := make(map[string]sse.Route, 64)
	add := func(pattern string, route sse.Route) { routes[pattern] = route }

	routeLibrary := sse.Route{Kinds: []string{"library"}}
	// library-image: an image write addresses one entity's photo. It carries the
	// client's cache key (bean:<id>, grinder:<id>, ...) as the event id, and also
	// reports the library change so the derived stock/wear views refresh.
	routeLibraryImageBean := sse.Route{Kinds: []string{"library-image", "library"}, WithID: true, IDPrefix: "bean:"}
	routeLibraryImageGrinder := sse.Route{Kinds: []string{"library-image", "library"}, WithID: true, IDPrefix: "grinder:"}
	routeLibraryImageBasket := sse.Route{Kinds: []string{"library-image", "library"}, WithID: true, IDPrefix: "basket:"}
	routeLibraryImagePuckScreen := sse.Route{Kinds: []string{"library-image", "library"}, WithID: true, IDPrefix: "puckscreen:"}
	routeShot := sse.Route{Kinds: []string{"shot"}, WithID: true}
	routeOrders := sse.Route{Kinds: []string{"orders"}}
	routeMaintenance := sse.Route{Kinds: []string{"maintenance"}}
	routeUIPrefs := sse.Route{Kinds: []string{"ui-prefs"}}
	routeProfiles := sse.Route{Kinds: []string{"profiles"}}
	routeSettings := sse.Route{Kinds: []string{"settings"}}
	routeAll := sse.Route{Kinds: []string{sse.KindAll}}

	// library — every write under /api/library/... changes the library. Deleting
	// a grinder also removes its maintenance row (library.SetOnGrinderDeleted ->
	// maintenance.DeleteGrinderTask, wired in main.go).
	add("POST /api/library/bean", routeLibrary)
	add("PUT /api/library/bean/{id}", routeLibrary)
	add("POST /api/library/bean/{id}/new-bag", routeLibrary)
	add("POST /api/library/bean/{id}/reorder-bags", routeLibrary)
	add("POST /api/library/bean/{id}/freeze-portions", routeLibrary)
	add("POST /api/library/bean/{id}/thaw-portion", routeLibrary)
	add("POST /api/library/bean/{id}/adjust-frozen-portion", routeLibrary)
	add("PUT /api/library/bean/{id}/bag/{bagId}", routeLibrary)
	add("DELETE /api/library/bean/{id}/bag/{bagId}", routeLibrary)
	add("POST /api/library/bean/{id}/delete", routeLibrary)
	add("POST /api/library/bean/{id}/toggle-active", routeLibrary)
	add("POST /api/library/bean/{id}/known-grind", routeLibrary)
	add("POST /api/library/bean/{id}/image", routeLibraryImageBean)
	add("POST /api/library/grinder", routeLibrary)
	add("PUT /api/library/grinder/{id}", routeLibrary)
	add("POST /api/library/grinder/{id}/reset-burrs", routeLibrary)
	add("PUT /api/library/grinder/{id}/zero-point", routeLibrary)
	add("DELETE /api/library/grinder/{id}/zero-point/{since}", routeLibrary)
	add("POST /api/library/grinder/{id}/delete", sse.Route{Kinds: []string{"library", "maintenance"}})
	add("POST /api/library/grinder/{id}/image", routeLibraryImageGrinder)
	add("POST /api/library/basket", routeLibrary)
	add("PUT /api/library/basket/{id}", routeLibrary)
	add("DELETE /api/library/basket/{id}", routeLibrary)
	add("POST /api/library/basket/{id}/image", routeLibraryImageBasket)
	add("POST /api/library/puckscreen", routeLibrary)
	add("PUT /api/library/puckscreen/{id}", routeLibrary)
	add("DELETE /api/library/puckscreen/{id}", routeLibrary)
	add("POST /api/library/puckscreen/{id}/image", routeLibraryImagePuckScreen)
	add("POST /api/library/milk", routeLibrary)
	add("PUT /api/library/milk/{id}", routeLibrary)
	add("DELETE /api/library/milk/{id}", routeLibrary)
	add("POST /api/library/milk/{id}/deduct", routeLibrary)
	add("POST /api/library/milk/{id}/restock", routeLibrary)
	add("POST /api/library/recipe", routeLibrary)
	add("PUT /api/library/recipe/{id}", routeLibrary)
	add("POST /api/library/recipe/{id}/delete", routeLibrary)

	// shot — one shot's own photo, addressed by id. The client refetches that
	// shot, not the whole list.
	add("POST /api/shots/{id}/image", routeShot)
	add("DELETE /api/shots/{id}/image", routeShot)

	// shot + library — annotating a shot also changes the library, because
	// GET /api/library derives bag stock and grinder wear from shots.
	add("POST /api/shots/{id}/annotate", sse.Route{Kinds: []string{"shot", "library"}, WithID: true})

	// shots + library — trashing, restoring or deleting a shot changes the shot
	// list and the library's derived stock and wear.
	add("POST /api/shots/{id}/trash", sse.Route{Kinds: []string{"shots", "library"}})
	add("POST /api/shots/{id}/restore", sse.Route{Kinds: []string{"shots", "library"}})
	add("POST /api/shots/{id}/delete", sse.Route{Kinds: []string{"shots", "library"}})

	// orders — every write under /api/orders/... is an order change. Completing
	// one also annotates the shot it links to (orders.Service.CompleteOrder
	// calls shotsRepo.UpdateAnnotation) and deducts milk stock, so both the shot
	// list and the library change too.
	add("POST /api/orders", routeOrders)
	add("POST /api/orders/menu", routeOrders)
	add("PUT /api/orders/menu/{id}", routeOrders)
	add("DELETE /api/orders/menu/{id}", routeOrders)
	add("POST /api/orders/settings", routeOrders)
	add("POST /api/orders/notify-mapping", routeOrders)
	add("POST /api/orders/{id}/accept", routeOrders)
	add("POST /api/orders/{id}/decline", routeOrders)
	add("DELETE /api/orders/{id}", routeOrders)
	add("DELETE /api/orders/history", routeOrders)
	add("POST /api/orders/{id}/complete", sse.Route{Kinds: []string{"orders", "shots", "library"}})

	// maintenance — the log and custom tasks, plus a firmware update which
	// records a maintenance entry (main.go's machinesHandlers.SetOnFirmwareUpdate).
	add("POST /api/maintenance/{task}/done", routeMaintenance)
	add("POST /api/maintenance/{task}/threshold", routeMaintenance)
	add("POST /api/maintenance/custom", routeMaintenance)
	add("DELETE /api/maintenance/custom/{key}", routeMaintenance)
	add("POST /api/maintenance/log", routeMaintenance)
	add("DELETE /api/maintenance/log/{id}", routeMaintenance)
	add("POST /api/machine/firmware/update", routeMaintenance)

	// ui-prefs — the per-install UI choices.
	add("PUT /api/ui-prefs", routeUIPrefs)

	// profiles — the locally stored machine profiles and their pending sync.
	add("POST /api/machine/profile", routeProfiles)
	add("PUT /api/machine/profile/{id}", routeProfiles)
	add("DELETE /api/machine/profile/{id}", routeProfiles)
	add("POST /api/machine/profile/set", routeProfiles)
	add("POST /api/machine/profile/save", routeProfiles)

	// settings — the shot defaults, the machine registry, and the broker/MCP/
	// import/machine-control options, all stored in GLP's own database.
	add("POST /api/shots/defaults", routeSettings)
	add("POST /api/machines", routeSettings)
	add("PUT /api/machines/{id}", routeSettings)
	add("DELETE /api/machines/{id}", routeSettings)
	add("POST /api/machines/{id}/default", routeSettings)
	add("POST /api/mqtt/settings", routeSettings)
	add("POST /api/mcp/settings", routeSettings)
	add("POST /api/import/settings", routeSettings)
	add("POST /api/machine/control/settings", routeSettings)

	// all — a whole-database change: every kind is bumped and one all event
	// tells the client to refetch everything.
	add("POST /api/restore", routeAll)
	add("POST /api/debug/import-db", routeAll)
	add("POST /api/demo/seed", routeAll)
	add("POST /api/demo/end", routeAll)

	return routes
}

// buildDataIgnored is a function rather than a map literal so each entry is a
// short statement that carries its own reason.
func buildDataIgnored() map[string]string {
	reasons := make(map[string]string, 16)
	add := func(pattern, reason string) { reasons[pattern] = reason }

	// Not part of live sync: writes data a client never refetches, or pushes
	// elsewhere; achievements are not synced live.
	add("POST /api/backup", "writes only achievement unlocks; achievements are not part of live sync")
	add("POST /api/sync", "a manual shot pull: new shots arrive through the status poll's revision")
	add("POST /api/preheat/ready-by", "preheat-update already carries the resulting status")
	add("/api/mcp", "MCP write tools publish their own data-changed events (slice 2)")

	// Machine-side control: the controller acts, GLP's database does not change.
	add("POST /api/machine/flush/start", "machine-side only: starts a flush on the controller")
	add("POST /api/machine/flush/stop", "machine-side only: stops a flush on the controller")
	add("POST /api/machine/brew-confirm/confirm", "machine-side only: confirms a brew on the controller")
	add("POST /api/machine/brew-confirm/cancel", "machine-side only: cancels a brew confirmation on the controller")
	add("POST /api/machine/opmode", "machine-side only: sets the controller's operation mode")
	add("POST /api/machine/tare", "machine-side only: tares the controller's scale")
	add("POST /api/machine/service-test", "machine-side only: runs a controller service test")
	add("POST /api/machine/settings/save", "machine-side only: saves settings on the controller")
	add("POST /api/machine/settings/{category}", "machine-side only: updates a settings category on the controller")
	add("POST /api/machines/{id}/test", "machine-side only: tests connectivity to the controller")
	add("POST /api/mqtt/apply-to-machine", "machine-side only: pushes the broker settings to the controller")
	add("POST /api/switch/toggle", "machine-side only: toggles the controller's HA switch")

	return reasons
}
