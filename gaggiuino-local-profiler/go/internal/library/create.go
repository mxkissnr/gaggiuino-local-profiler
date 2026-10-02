package library

import "github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"

// This file extracts the read-validate-save entity-creation logic each
// create handler (handlers_beans.go's createBean et al.) already had
// inlined into its own http.ResponseWriter-bound handler, into plain
// functions taking a decoded body and returning (Entity, Library, error)
// — the same "same service method, not new logic" discipline
// ToggleBeanActive/MarkTaskDone already established for this package's
// other web/REST-shared actions. Each REST handler below is now a thin
// wrapper: decode + rate-limit + call + map a *ValidationError to its
// existing 400 response. Keeping the validation and Library-save logic in
// these functions keeps it out of the HTTP layer.
//
// Every Create* function also returns the just-saved Library (the same
// value SaveLibrary was called with, containing the new entity) alongside
// the created entity itself — the same convention ToggleBeanActive already
// established (service.go) — so a caller that needs the full list
// right after a create can build it straight from the returned Library
// instead of issuing a second, redundant repo.GetLibrary() read (#901 code
// review finding #3).

// ValidationError carries the 400 message a Create* function's caller
// should surface. Aliased to httputil.ValidationError (#901 code review
// finding #5) rather than redeclared — internal/machines' own create.go
// used to define an identical type independently; both now share one.
type ValidationError = httputil.ValidationError

// CreateBean builds POST /api/library/bean's entity-construction body
// (handlers_beans.go's createBean), minus that handler's own
// rate-limit/JSON-decode steps. imageDir is only used for the
// fire-and-forget SetBeanImage download when body["imageUrl"] is set (see
// that function's own doc comment) — a plain "name + roaster" form
// submission never sets it, so that goroutine simply never launches for
// such a caller.
func CreateBean(repo *Repository, imageDir string, body Entity) (Entity, Library, error) {
	// `!name || typeof name !== 'string' || !name.trim()` — trimMax already
	// collapses "not a string" and "blank after trim" to "", so a single
	// check on the trimmed result covers every branch.
	if trimMax(body["name"], 200) == "" {
		return nil, Library{}, &ValidationError{Message: "name required"}
	}

	stockG := floatOrNilFalsy(body["stock_g"])
	origins := sanitizeOrigins(body["origins"])
	if len(origins) == 0 {
		if code := sanitizeOrigin(body["origin"]); code != "" {
			origins = []any{Entity{"code": code}}
		}
	}
	roastDate := trimMax(body["roastDate"], 10)
	batchNumber := trimMax(body["batchNumber"], 50)

	origin := ""
	if len(origins) > 0 {
		if m, ok := origins[0].(Entity); ok {
			origin, _ = m["code"].(string)
		}
	}

	id := newID()
	bean := Entity{
		"id": id, "name": trimMax(body["name"], 200), "roaster": trimMax(body["roaster"], 200),
		"roastDate": roastDate, "notes": trimMax(body["notes"], 1000),
		"origin": origin, "origins": origins,
		"variety": trimMax(body["variety"], 200), "species": sanitizeSpecies(body["species"]),
		"category": sanitizeCategory(body["category"]), "process": trimMax(body["process"], 200),
		"flavors":    sanitizeFlavors(body["flavors"]),
		"roastType":  sanitizeRoastType(body["roastType"]),
		"region":     trimMax(body["region"], 200),
		"altitude_m": sanitizeAltitude(body["altitude_m"]),
		"importer":   trimMax(body["importer"], 200), "harvest": trimMax(body["harvest"], 50),
		"price_eur": sanitizePrice(body["price_eur"]),
		"producer":  trimMax(body["producer"], 200), "certification": trimMax(body["certification"], 200),
		"brewTempC": sanitizeBrewTemp(body["brewTempC"]), "brewRatio": trimMax(body["brewRatio"], 20),
		"brewTimeS": sanitizeBrewTime(body["brewTimeS"]), "brewNotes": trimMax(body["brewNotes"], 300),
		"stock_g": stockG,
		"decaf":   boolOf(body["decaf"]),
		"enabled": sanitizeEnabled(body["enabled"]),
	}
	if stockG != nil || roastDate != "" || batchNumber != "" {
		bean["bags"] = []any{Entity{
			"id": reserveID(id + 1), "roastDate": roastDate, "stock_g": stockG,
			"openedAt": newID(), "batchNumber": batchNumber, "sortOrder": int64(0),
		}}
	} else {
		bean["bags"] = []any{}
	}
	if source, _ := body["source"].(string); source != "" {
		bean["source"] = trimMax(body["source"], 200)
	}
	if importedAt, _ := body["importedAt"].(string); importedAt != "" {
		bean["importedAt"] = trimMax(body["importedAt"], 10)
	}
	if sourceURL, _ := body["sourceUrl"].(string); sourceURL != "" {
		bean["sourceUrl"] = safeURL(body["sourceUrl"])
	}

	var saved Library
	if err := repo.Update(func(lib *Library) error {
		lib.Beans = append(lib.Beans, bean)
		saved = *lib
		return nil
	}); err != nil {
		return nil, Library{}, err
	}

	// Fire-and-forget image download — see service.go's SetBeanImage doc
	// comment.
	if imageURL, _ := body["imageUrl"].(string); imageURL != "" {
		httputil.SafeGo("library: bean image fetch", func() { SetBeanImage(repo, imageDir, id, imageURL) })
	}

	// Fire-and-forget region -> map-coordinates geocode — a no-op unless
	// cmd/server wired GeocodeHook and region is non-empty.
	maybeGeocode(id, trimMax(body["region"], 200), origin)

	return bean, saved, nil
}

// CreateGrinder builds POST /api/library/grinder's entity-construction
// body (handlers_grinders.go's createGrinder).
func CreateGrinder(repo *Repository, body Entity) (Entity, Library, error) {
	if trimMax(body["name"], 200) == "" {
		return nil, Library{}, &ValidationError{Message: "name required"}
	}
	purchaseDate := trimMax(body["purchaseDate"], 10)
	burrsResetAt := trimMax(body["burrsResetAt"], 10)
	if burrsResetAt == "" {
		burrsResetAt = purchaseDate
	}
	grinder := Entity{
		"id": newID(), "name": trimMax(body["name"], 200), "notes": trimMax(body["notes"], 1000),
		"burrType": trimMax(body["burrType"], 200), "purchaseDate": purchaseDate,
		"burrsResetAt": burrsResetAt,
	}
	var saved Library
	if err := repo.Update(func(lib *Library) error {
		lib.Grinders = append(lib.Grinders, grinder)
		saved = *lib
		return nil
	}); err != nil {
		return nil, Library{}, err
	}
	return grinder, saved, nil
}

// CreateBasket builds POST /api/library/basket's entity-construction body
// (handlers_baskets.go's createBasket), including its wallType/shape enum
// validation.
func CreateBasket(repo *Repository, body Entity) (Entity, Library, error) {
	if trimMax(body["name"], 200) == "" {
		return nil, Library{}, &ValidationError{Message: "name required"}
	}
	wallType, _, wallTypeOK := enumStringField(body, "wallType", basketWallTypes)
	if !wallTypeOK {
		return nil, Library{}, &ValidationError{Message: "invalid wallType"}
	}
	shape, _, shapeOK := enumStringField(body, "shape", basketShapes)
	if !shapeOK {
		return nil, Library{}, &ValidationError{Message: "invalid shape"}
	}
	basket := Entity{
		"id": newID(), "name": trimMax(body["name"], 200), "doseCapacity": trimMax(body["doseCapacity"], 50),
		"wallType": wallType, "shape": shape,
		"holeCount": trimMax(body["holeCount"], 50), "notes": trimMax(body["notes"], 1000),
		"updatedAt": newID(),
	}
	var saved Library
	if err := repo.Update(func(lib *Library) error {
		lib.Baskets = append(lib.Baskets, basket)
		saved = *lib
		return nil
	}); err != nil {
		return nil, Library{}, err
	}
	return basket, saved, nil
}

// CreatePuckScreen builds POST /api/library/puckscreen's entity-construction
// body (handlers_puckscreens.go's createPuckScreen), including its
// thickness enum validation.
func CreatePuckScreen(repo *Repository, body Entity) (Entity, Library, error) {
	if trimMax(body["name"], 200) == "" {
		return nil, Library{}, &ValidationError{Message: "name required"}
	}
	thickness, _, thicknessOK := enumStringField(body, "thickness", puckScreenThicknesses)
	if !thicknessOK {
		return nil, Library{}, &ValidationError{Message: "invalid thickness"}
	}
	puckScreen := Entity{
		"id": newID(), "name": trimMax(body["name"], 200), "thickness": thickness,
		"material": trimMax(body["material"], 200), "notes": trimMax(body["notes"], 1000),
		"updatedAt": newID(),
	}
	var saved Library
	if err := repo.Update(func(lib *Library) error {
		lib.PuckScreens = append(lib.PuckScreens, puckScreen)
		saved = *lib
		return nil
	}); err != nil {
		return nil, Library{}, err
	}
	return puckScreen, saved, nil
}

// CreateMilk builds POST /api/library/milk's entity-construction body
// (handlers_milks.go's createMilk).
func CreateMilk(repo *Repository, body Entity) (Entity, Library, error) {
	if trimMax(body["name"], 100) == "" {
		return nil, Library{}, &ValidationError{Message: "name required"}
	}
	// `emoji?.trim() || '🥛'` — no length cap on create (unlike the
	// restore-path sanitizeMilkFields, which isn't called here).
	emoji := trimMax(body["emoji"], 1<<30)
	if emoji == "" {
		emoji = "🥛"
	}
	milk := Entity{
		"id": newID(), "name": trimMax(body["name"], 100),
		"emoji": emoji, "stockMl": floatOrZero(body["stockMl"]), "updatedAt": newID(),
	}
	var saved Library
	if err := repo.Update(func(lib *Library) error {
		lib.Milks = append(lib.Milks, milk)
		saved = *lib
		return nil
	}); err != nil {
		return nil, Library{}, err
	}
	return milk, saved, nil
}

// CreateRecipe builds POST /api/library/recipe's entity-construction body
// (handlers_recipes.go's createRecipe).
func CreateRecipe(repo *Repository, body Entity) (Entity, Library, error) {
	if trimMax(body["name"], 200) == "" {
		return nil, Library{}, &ValidationError{Message: "name required"}
	}
	recipe := Entity{
		"id": newID(), "name": trimMax(body["name"], 200),
		"brewMethod": brewMethodOrOther(body["brewMethod"]), "drinkType": trimMax(body["drinkType"], 50),
		"targetDose_g": floatOrNilFalsy(body["targetDose_g"]), "targetYield_g": floatOrNilFalsy(body["targetYield_g"]),
		"targetTime_s": floatOrNilFalsy(body["targetTime_s"]),
		"waterTemp_c":  floatOrNilFalsy(body["waterTemp_c"]), "water_g": floatOrNilFalsy(body["water_g"]),
		"ice_g":     floatOrNilFalsy(body["ice_g"]),
		"grindSize": trimMax(body["grindSize"], 200),
		"sourceUrl": safeURL(body["sourceUrl"]),
		"steps":     parseSteps(body["steps"]),
		"notes":     trimMax(body["notes"], 1000), "profileName": trimMax(body["profileName"], 200),
		"beanName": trimMax(body["beanName"], 200),
	}
	var saved Library
	if err := repo.Update(func(lib *Library) error {
		lib.Recipes = append(lib.Recipes, recipe)
		saved = *lib
		return nil
	}); err != nil {
		return nil, Library{}, err
	}
	return recipe, saved, nil
}
