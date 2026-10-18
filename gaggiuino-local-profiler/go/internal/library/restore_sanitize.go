package library

// This file holds the whole-entity sanitizers
// (sanitizeBeanFields/sanitizeGrinderFields/sanitizeRecipeFields/
// sanitizeMilkFields/sanitizeBasketFields/sanitizePuckScreenFields) —
// deliberately left out of sanitize.go (see that file's header comment):
// their only caller is the backup domain's POST /api/restore, which
// re-runs every field sanitizer over a restored coffee_library so it can
// never bypass the validation the regular POST/PUT bean/grinder/recipe
// routes apply (a crafted backup could otherwise inject unsanitized
// strings that later render unescaped in the frontend). Exported (capital
// S) so internal/backup, a different package, can call them.

// SanitizeBeanFields applies every bean field sanitizer, preserving
// structural fields (id, bags, image, location, source, importedAt, ...)
// unchanged. The user-editable fields come from the same beanFields helper
// CreateBean uses (#1603); bags get updateBag's per-field rules via
// sanitizeBag, so a restored bag cannot carry values the edit route rejects.
func SanitizeBeanFields(bean Entity) Entity {
	if bean == nil {
		return nil
	}
	out := Entity{}
	for k, v := range bean {
		out[k] = v
	}
	for k, v := range beanFields(bean) {
		out[k] = v
	}
	// The `s(x, n) || x` idiom: an empty trimmed name falls back to the raw
	// value rather than clobbering it with "".
	out["name"] = orFallback(trimMax(bean["name"], 200), bean["name"])
	out["sourceUrl"] = safeURL(bean["sourceUrl"])

	if bags, ok := bean["bags"].([]any); ok {
		sanitizedBags := make([]any, 0, len(bags))
		for _, raw := range bags {
			if bag, ok := sanitizeBag(raw); ok {
				sanitizedBags = append(sanitizedBags, bag)
			}
		}
		out["bags"] = sanitizedBags
	}
	return out
}

// orFallback implements the `s(x, n) || x` idiom (the `name` field of the
// bean/grinder/milk sanitizers): an empty trimmed/truncated result falls back
// to the original raw value rather than clobbering it with "".
func orFallback(trimmed string, raw any) any {
	if trimmed != "" {
		return trimmed
	}
	return raw
}

// SanitizeGrinderFields applies every grinder field sanitizer.
func SanitizeGrinderFields(grinder Entity) Entity {
	if grinder == nil {
		return nil
	}
	out := Entity{}
	for k, v := range grinder {
		out[k] = v
	}
	out["name"] = orFallback(trimMax(grinder["name"], 200), grinder["name"])
	out["notes"] = trimMax(grinder["notes"], 1000)
	out["burrType"] = trimMax(grinder["burrType"], 200)
	out["purchaseDate"] = trimMax(grinder["purchaseDate"], 10)
	return out
}

// SanitizeMilkFields applies every milk field sanitizer (#635).
func SanitizeMilkFields(milk Entity) Entity {
	if milk == nil {
		return nil
	}
	out := Entity{}
	for k, v := range milk {
		out[k] = v
	}
	out["name"] = orFallback(trimMax(milk["name"], 100), milk["name"])
	out["emoji"] = sanitizeMilkEmoji(milk["emoji"])
	stockMl, ok := jsParseFloat(milk["stockMl"])
	if !ok || stockMl < 0 {
		stockMl = 0
	}
	out["stockMl"] = stockMl
	return out
}

// basketWallTypes/basketShapes are handlers_baskets.go's existing enum
// whitelists — reused here rather than redeclared.
func sanitizeBasketWallType(v any) string {
	s, ok := v.(string)
	if ok && basketWallTypes[s] {
		return s
	}
	return ""
}

func sanitizeBasketShape(v any) string {
	s, ok := v.(string)
	if ok && basketShapes[s] {
		return s
	}
	return ""
}

// SanitizeBasketFields applies every basket field sanitizer (#635).
func SanitizeBasketFields(basket Entity) Entity {
	if basket == nil {
		return nil
	}
	out := Entity{}
	for k, v := range basket {
		out[k] = v
	}
	out["name"] = orFallback(trimMax(basket["name"], 200), basket["name"])
	out["doseCapacity"] = trimMax(basket["doseCapacity"], 50)
	out["wallType"] = sanitizeBasketWallType(basket["wallType"])
	out["shape"] = sanitizeBasketShape(basket["shape"])
	out["holeCount"] = trimMax(basket["holeCount"], 50)
	out["notes"] = trimMax(basket["notes"], 1000)
	return out
}

// puckScreenThicknesses is handlers_puckscreens.go's existing enum
// whitelist — reused here rather than redeclared.
func sanitizePuckScreenThickness(v any) string {
	s, ok := v.(string)
	if ok && puckScreenThicknesses[s] {
		return s
	}
	return ""
}

// SanitizePuckScreenFields applies every puckScreen field sanitizer (#635).
func SanitizePuckScreenFields(ps Entity) Entity {
	if ps == nil {
		return nil
	}
	out := Entity{}
	for k, v := range ps {
		out[k] = v
	}
	out["name"] = orFallback(trimMax(ps["name"], 200), ps["name"])
	out["thickness"] = sanitizePuckScreenThickness(ps["thickness"])
	out["material"] = trimMax(ps["material"], 200)
	out["notes"] = trimMax(ps["notes"], 1000)
	return out
}

// validBrewMethods is handlers_recipes.go's existing enum whitelist —
// reused here rather than redeclared.
func sanitizeRecipeSteps(v any) []any {
	arr, ok := v.([]any)
	if !ok {
		return []any{}
	}
	out := []any{}
	for i, raw := range arr {
		if i >= 30 {
			break
		}
		step, _ := raw.(Entity)
		text := ""
		if step != nil {
			text = trimMax(step["text"], 500)
		}
		if text == "" {
			continue
		}
		entry := Entity{"text": text, "duration_s": nil}
		if step != nil {
			if d, ok := jsParseFloat(step["duration_s"]); ok {
				entry["duration_s"] = d
			}
		}
		out = append(out, entry)
	}
	return out
}

// SanitizeRecipeFields applies every recipe field sanitizer.
func SanitizeRecipeFields(recipe Entity) Entity {
	if recipe == nil {
		return nil
	}
	out := Entity{}
	for k, v := range recipe {
		out[k] = v
	}
	out["name"] = orFallback(trimMax(recipe["name"], 200), recipe["name"])
	brewMethod, _ := recipe["brewMethod"].(string)
	if !validBrewMethods[brewMethod] {
		brewMethod = "other"
	}
	out["brewMethod"] = brewMethod
	out["drinkType"] = trimMax(recipe["drinkType"], 50)
	out["grindSize"] = trimMax(recipe["grindSize"], 200)
	out["sourceUrl"] = safeURL(recipe["sourceUrl"])
	out["steps"] = sanitizeRecipeSteps(recipe["steps"])
	out["notes"] = trimMax(recipe["notes"], 1000)
	out["profileName"] = trimMax(recipe["profileName"], 200)
	out["beanName"] = trimMax(recipe["beanName"], 200)
	return out
}

// SanitizeLibraryForRestore re-runs every entity type's field sanitizer over
// a restored coffee_library.
func SanitizeLibraryForRestore(lib Library) Library {
	out := lib
	if lib.Beans != nil {
		out.Beans = make([]Entity, len(lib.Beans))
		for i, b := range lib.Beans {
			out.Beans[i] = SanitizeBeanFields(b)
		}
	}
	if lib.Grinders != nil {
		out.Grinders = make([]Entity, len(lib.Grinders))
		for i, g := range lib.Grinders {
			out.Grinders[i] = SanitizeGrinderFields(g)
		}
	}
	if lib.Recipes != nil {
		out.Recipes = make([]Entity, len(lib.Recipes))
		for i, rec := range lib.Recipes {
			out.Recipes[i] = SanitizeRecipeFields(rec)
		}
	}
	if lib.Milks != nil {
		out.Milks = make([]Entity, len(lib.Milks))
		for i, m := range lib.Milks {
			out.Milks[i] = SanitizeMilkFields(m)
		}
	}
	if lib.Baskets != nil {
		out.Baskets = make([]Entity, len(lib.Baskets))
		for i, b := range lib.Baskets {
			out.Baskets[i] = SanitizeBasketFields(b)
		}
	}
	if lib.PuckScreens != nil {
		out.PuckScreens = make([]Entity, len(lib.PuckScreens))
		for i, p := range lib.PuckScreens {
			out.PuckScreens[i] = SanitizePuckScreenFields(p)
		}
	}
	return out
}
