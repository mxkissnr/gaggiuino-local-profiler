package library

// This file extracts the field-patch logic each PUT /api/library/<kind>/:id
// REST handler (handlers_beans.go et al.) used to inline directly into its
// own http.HandlerFunc, into package-level functions the REST handlers now
// call as thin wrappers — the same "service layer, not the REST handler
// itself" reuse convention CreateBean et al. (create.go) already established
// for POST, applied to PUT so internal/web's Phase 2b/2c-follow-up Edit UI
// (go/README.md's "Status" section) can call the identical validated patch
// logic instead of duplicating it a second time.
//
// Every UpdateX returns (updated entity, current Library, found, error):
// found is false when id doesn't match any entity of that kind (including
// id==0, the noMatch case callers pass through unchanged — see
// parseIDParam's own doc comment on why 0 never collides with a real id).

// UpdateBean applies a partial update to bean id, mirroring
// PUT /api/library/bean/:id's own field-by-field patch semantics: omitted
// fields keep their current value.
func UpdateBean(repo *Repository, id int64, body Entity) (Entity, Library, bool, error) {
	lib, err := repo.GetLibrary()
	if err != nil {
		return nil, Library{}, false, err
	}
	idx := findBeanIndex(lib, id)
	if idx == -1 {
		return nil, Library{}, false, nil
	}
	bean := lib.Beans[idx]

	if v, present := trimMaxOrUndefined(body, "name", 200); present {
		if v != "" {
			bean["name"] = v
		}
	}
	if v, present := trimMaxOrUndefined(body, "roaster", 200); present {
		bean["roaster"] = v
	}
	if v, present := trimMaxOrUndefined(body, "roastDate", 10); present {
		bean["roastDate"] = v
	}
	if v, present := trimMaxOrUndefined(body, "notes", 1000); present {
		bean["notes"] = v
	}
	if _, present := body["origins"]; present {
		origins := sanitizeOrigins(body["origins"])
		bean["origins"] = origins
		origin := ""
		if len(origins) > 0 {
			if m, ok := origins[0].(Entity); ok {
				origin, _ = m["code"].(string)
			}
		}
		bean["origin"] = origin
	} else if _, present := body["origin"]; present {
		code := sanitizeOrigin(body["origin"])
		if code != "" {
			bean["origins"] = []any{Entity{"code": code}}
		} else {
			bean["origins"] = []any{}
		}
		bean["origin"] = code
	}
	if v, present := body["variety"]; present {
		bean["variety"] = trimMax(v, 200)
	}
	if _, present := body["species"]; present {
		bean["species"] = sanitizeSpecies(body["species"])
	}
	if _, present := body["category"]; present {
		bean["category"] = sanitizeCategory(body["category"])
	}
	if _, present := body["process"]; present {
		bean["process"] = trimMax(body["process"], 200)
	}
	if _, present := body["flavors"]; present {
		bean["flavors"] = sanitizeFlavors(body["flavors"])
	}
	if _, present := body["roastType"]; present {
		bean["roastType"] = sanitizeRoastType(body["roastType"])
	}
	if _, present := body["altitude_m"]; present {
		bean["altitude_m"] = sanitizeAltitude(body["altitude_m"])
	}
	if _, present := body["importer"]; present {
		bean["importer"] = trimMax(body["importer"], 200)
	}
	if _, present := body["harvest"]; present {
		bean["harvest"] = trimMax(body["harvest"], 50)
	}
	if _, present := body["price_eur"]; present {
		bean["price_eur"] = sanitizePrice(body["price_eur"])
	}
	if _, present := body["producer"]; present {
		bean["producer"] = trimMax(body["producer"], 200)
	}
	if _, present := body["certification"]; present {
		bean["certification"] = trimMax(body["certification"], 200)
	}
	if _, present := body["brewTempC"]; present {
		bean["brewTempC"] = sanitizeBrewTemp(body["brewTempC"])
	}
	if _, present := body["brewRatio"]; present {
		bean["brewRatio"] = trimMax(body["brewRatio"], 20)
	}
	if _, present := body["brewTimeS"]; present {
		bean["brewTimeS"] = sanitizeBrewTime(body["brewTimeS"])
	}
	if _, present := body["brewNotes"]; present {
		bean["brewNotes"] = trimMax(body["brewNotes"], 300)
	}
	// Phase 2g (#901): a region change clears the stale `location` AND
	// triggers a fire-and-forget re-geocode (maybeGeocode below, after the
	// save), matching routes/library/beans.js's
	// `if (regionChanged && ...region) libraryService.geocodeBean(id)`.
	regionChanged := false
	if _, present := body["region"]; present {
		newRegion := trimMax(body["region"], 200)
		oldRegion, _ := bean["region"].(string)
		bean["region"] = newRegion
		if newRegion != oldRegion {
			bean["location"] = nil
			regionChanged = true
		}
	}
	if _, present := body["stock_g"]; present {
		bean["stock_g"] = floatOrNilFalsy(body["stock_g"])
	}
	if _, present := body["decaf"]; present {
		bean["decaf"] = boolOf(body["decaf"])
	}
	if _, present := body["enabled"]; present {
		bean["enabled"] = sanitizeEnabled(body["enabled"])
	}

	_, roastDatePresent := body["roastDate"]
	_, stockPresent := body["stock_g"]
	_, batchPresent := body["batchNumber"]
	if roastDatePresent || stockPresent || batchPresent {
		if bags := bagsOf(bean); len(bags) > 0 {
			last, _ := bags[len(bags)-1].(Entity)
			if last != nil {
				if roastDatePresent {
					last["roastDate"] = trimMax(body["roastDate"], 10)
				}
				if stockPresent {
					last["stock_g"] = floatOrNilFalsy(body["stock_g"])
				}
				if batchPresent {
					last["batchNumber"] = trimMax(body["batchNumber"], 50)
				}
			}
		}
	}

	lib.Beans[idx] = bean
	if err := repo.SaveLibrary(lib); err != nil {
		return nil, Library{}, false, err
	}
	if regionChanged {
		region, _ := bean["region"].(string)
		origin, _ := bean["origin"].(string)
		maybeGeocode(id, region, origin)
	}
	return bean, lib, true, nil
}

// UpdateGrinder applies a partial update to grinder id, mirroring
// PUT /api/library/grinder/:id.
func UpdateGrinder(repo *Repository, id int64, body Entity) (Entity, Library, bool, error) {
	lib, err := repo.GetLibrary()
	if err != nil {
		return nil, Library{}, false, err
	}
	idx := findGrinderIndex(lib, id)
	if idx == -1 {
		return nil, Library{}, false, nil
	}
	grinder := lib.Grinders[idx]
	if v, present := trimMaxOrUndefined(body, "name", 200); present {
		if v != "" {
			grinder["name"] = v
		}
	}
	if v, present := trimMaxOrUndefined(body, "notes", 1000); present {
		grinder["notes"] = v
	}
	if v, present := trimMaxOrUndefined(body, "burrType", 200); present {
		grinder["burrType"] = v
	}
	if v, present := trimMaxOrUndefined(body, "purchaseDate", 10); present {
		grinder["purchaseDate"] = v
	}
	if v, present := trimMaxOrUndefined(body, "burrsResetAt", 10); present {
		grinder["burrsResetAt"] = v
	}
	lib.Grinders[idx] = grinder
	if err := repo.SaveLibrary(lib); err != nil {
		return nil, Library{}, false, err
	}
	return grinder, lib, true, nil
}

// UpdateBasket applies a partial update to basket id, mirroring
// PUT /api/library/basket/:id, including its wallType/shape enum validation
// (an invalid value is reported via the bool return going false with a nil
// error — see ErrInvalidField).
func UpdateBasket(repo *Repository, id int64, body Entity) (Entity, Library, bool, error) {
	lib, err := repo.GetLibrary()
	if err != nil {
		return nil, Library{}, false, err
	}
	idx := findBasketIndex(lib, id)
	if idx == -1 {
		return nil, Library{}, false, nil
	}
	wallType, wallTypePresent, wallTypeOK := enumStringField(body, "wallType", basketWallTypes)
	if !wallTypeOK {
		return nil, Library{}, false, &ValidationError{Message: "invalid wallType"}
	}
	shape, shapePresent, shapeOK := enumStringField(body, "shape", basketShapes)
	if !shapeOK {
		return nil, Library{}, false, &ValidationError{Message: "invalid shape"}
	}
	basket := lib.Baskets[idx]
	if v, present := trimMaxOrUndefined(body, "name", 200); present {
		if v != "" {
			basket["name"] = v
		}
	}
	if v, present := trimMaxOrUndefined(body, "doseCapacity", 50); present {
		basket["doseCapacity"] = v
	}
	if wallTypePresent {
		basket["wallType"] = wallType
	}
	if shapePresent {
		basket["shape"] = shape
	}
	if v, present := trimMaxOrUndefined(body, "holeCount", 50); present {
		basket["holeCount"] = v
	}
	if v, present := trimMaxOrUndefined(body, "notes", 1000); present {
		basket["notes"] = v
	}
	basket["updatedAt"] = newID()
	lib.Baskets[idx] = basket
	if err := repo.SaveLibrary(lib); err != nil {
		return nil, Library{}, false, err
	}
	return basket, lib, true, nil
}

// UpdatePuckScreen applies a partial update to puck screen id, mirroring
// PUT /api/library/puckscreen/:id.
func UpdatePuckScreen(repo *Repository, id int64, body Entity) (Entity, Library, bool, error) {
	lib, err := repo.GetLibrary()
	if err != nil {
		return nil, Library{}, false, err
	}
	idx := findPuckScreenIndex(lib, id)
	if idx == -1 {
		return nil, Library{}, false, nil
	}
	thickness, thicknessPresent, thicknessOK := enumStringField(body, "thickness", puckScreenThicknesses)
	if !thicknessOK {
		return nil, Library{}, false, &ValidationError{Message: "invalid thickness"}
	}
	puckScreen := lib.PuckScreens[idx]
	if v, present := trimMaxOrUndefined(body, "name", 200); present {
		if v != "" {
			puckScreen["name"] = v
		}
	}
	if thicknessPresent {
		puckScreen["thickness"] = thickness
	}
	if v, present := trimMaxOrUndefined(body, "material", 200); present {
		puckScreen["material"] = v
	}
	if v, present := trimMaxOrUndefined(body, "notes", 1000); present {
		puckScreen["notes"] = v
	}
	puckScreen["updatedAt"] = newID()
	lib.PuckScreens[idx] = puckScreen
	if err := repo.SaveLibrary(lib); err != nil {
		return nil, Library{}, false, err
	}
	return puckScreen, lib, true, nil
}

// UpdateMilk applies a partial update to milk id, mirroring
// PUT /api/library/milk/:id.
func UpdateMilk(repo *Repository, id int64, body Entity) (Entity, Library, bool, error) {
	lib, err := repo.GetLibrary()
	if err != nil {
		return nil, Library{}, false, err
	}
	idx := findMilkIndex(lib, id)
	if idx == -1 {
		return nil, Library{}, false, nil
	}
	milk := lib.Milks[idx]
	if v, present := body["name"]; present {
		if s := trimMax(v, 100); s != "" {
			milk["name"] = s
		}
	}
	if v, present := body["emoji"]; present {
		if s := trimMax(v, 1<<30); s != "" {
			milk["emoji"] = s
		}
	}
	if _, present := body["stockMl"]; present {
		milk["stockMl"] = floatOrZero(body["stockMl"])
	}
	milk["updatedAt"] = newID()
	lib.Milks[idx] = milk
	if err := repo.SaveLibrary(lib); err != nil {
		return nil, Library{}, false, err
	}
	return milk, lib, true, nil
}

// UpdateRecipe applies a partial update to recipe id, mirroring
// PUT /api/library/recipe/:id.
func UpdateRecipe(repo *Repository, id int64, body Entity) (Entity, Library, bool, error) {
	lib, err := repo.GetLibrary()
	if err != nil {
		return nil, Library{}, false, err
	}
	idx := findRecipeIndex(lib, id)
	if idx == -1 {
		return nil, Library{}, false, nil
	}
	recipe := lib.Recipes[idx]
	if v, present := trimMaxOrUndefined(body, "name", 200); present {
		if v != "" {
			recipe["name"] = v
		}
	}
	if _, present := body["brewMethod"]; present {
		recipe["brewMethod"] = brewMethodOrOther(body["brewMethod"])
	}
	if v, present := trimMaxOrUndefined(body, "drinkType", 50); present {
		recipe["drinkType"] = v
	}
	if _, present := body["targetDose_g"]; present {
		recipe["targetDose_g"] = floatOrNilFalsy(body["targetDose_g"])
	}
	if _, present := body["targetYield_g"]; present {
		recipe["targetYield_g"] = floatOrNilFalsy(body["targetYield_g"])
	}
	if _, present := body["targetTime_s"]; present {
		recipe["targetTime_s"] = floatOrNilFalsy(body["targetTime_s"])
	}
	if _, present := body["waterTemp_c"]; present {
		recipe["waterTemp_c"] = floatOrNilFalsy(body["waterTemp_c"])
	}
	if _, present := body["water_g"]; present {
		recipe["water_g"] = floatOrNilFalsy(body["water_g"])
	}
	if _, present := body["ice_g"]; present {
		recipe["ice_g"] = floatOrNilFalsy(body["ice_g"])
	}
	if v, present := trimMaxOrUndefined(body, "grindSize", 200); present {
		recipe["grindSize"] = v
	}
	if _, present := body["sourceUrl"]; present {
		recipe["sourceUrl"] = safeURL(body["sourceUrl"])
	}
	if _, present := body["steps"]; present {
		recipe["steps"] = parseSteps(body["steps"])
	}
	if v, present := trimMaxOrUndefined(body, "notes", 1000); present {
		recipe["notes"] = v
	}
	if v, present := trimMaxOrUndefined(body, "profileName", 200); present {
		recipe["profileName"] = v
	}
	if v, present := trimMaxOrUndefined(body, "beanName", 200); present {
		recipe["beanName"] = v
	}
	lib.Recipes[idx] = recipe
	if err := repo.SaveLibrary(lib); err != nil {
		return nil, Library{}, false, err
	}
	return recipe, lib, true, nil
}
