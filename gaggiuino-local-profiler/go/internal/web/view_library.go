package web

import (
	"fmt"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web/templates"
)

// This file projects library.Entity (a bag-of-any map, see
// internal/library/model.go's own doc comment on why) into the typed Row
// structs internal/web/templates/library.templ renders — the Phase 2b
// (#901) Library-domain counterpart to view.go's toShotRow, same rationale:
// a template typo fails at `go build`, not silently at render time.

// entityID reads e["id"] as an int64 regardless of whether it arrived as a
// float64 (every Entity this package ever sees comes back out of
// library.Repository.GetLibrary, i.e. through an encoding/json round trip)
// or an int64 — mirrors internal/library's own unexported idOf, duplicated
// here since that package doesn't export it (same small-enough-not-to-share
// call internal/library's own model.go doc comment makes about jsParseInt).
func entityID(e library.Entity) int64 {
	switch v := e["id"].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	}
	return 0
}

func strField(e library.Entity, key string) string {
	s, _ := e[key].(string)
	return s
}

func boolField(e library.Entity, key string) bool {
	b, _ := e[key].(bool)
	return b
}

// beanEnabled mirrors library.ToggleBeanActive's own "disabled only when
// explicitly false" rule — an absent/non-bool `enabled` field (every bean
// created before #578, or any field the frontend never touched) means the
// bean is active.
func beanEnabled(bean library.Entity) bool {
	if b, isBool := bean["enabled"].(bool); isBool && !b {
		return false
	}
	return true
}

// beanBags reads bean["bags"] as a []any the same way internal/library's own
// unexported bagsOf does — nested arrays inside an Entity are always []any
// (elements are library.Entity/map[string]any) once they've round-tripped
// through encoding/json.
func beanBags(bean library.Entity) []any {
	bags, _ := bean["bags"].([]any)
	return bags
}

// activeBagRoastDate mirrors sidebar.js's `activeBag?.roastDate || b.roastDate`.
func activeBagRoastDate(bean library.Entity) string {
	bags := beanBags(bean)
	if len(bags) > 0 {
		if bag, ok := bags[len(bags)-1].(library.Entity); ok {
			if rd := strField(bag, "roastDate"); rd != "" {
				return rd
			}
		}
	}
	return strField(bean, "roastDate")
}

// toBeanRow builds a templates.BeanRow from a hydrated library.Entity bean —
// the Go-side equivalent of public-src/views/library.js's renderBeanList
// per-bean field extraction (see that file's doc comment on which fields
// this first Library page's dispatch brief actually needs: name, roaster,
// remaining/bag status, speciality category).
func toBeanRow(bean library.Entity, doseRows []shots.AnnotatedDose, allBeans []library.Entity) templates.BeanRow {
	stockG, _ := bean["stock_g"].(float64)
	row := templates.BeanRow{
		ID:         entityID(bean),
		Name:       strField(bean, "name"),
		Roaster:    strField(bean, "roaster"),
		Category:   strField(bean, "category"),
		Speciality: strField(bean, "category") == "speciality",
		Decaf:      boolField(bean, "decaf"),
		Enabled:    beanEnabled(bean),
		RoastDate:  activeBagRoastDate(bean),
		Notes:      strField(bean, "notes"),
		StockGRaw:  stockG,
		BagCount:   len(beanBags(bean)),
	}
	if stockG > 0 {
		row.StockG = fmt.Sprintf("%g g", stockG)
		if remaining, ok := library.ComputeBeanRemaining(bean, doseRows, allBeans); ok {
			row.Remaining = fmt.Sprintf("%d g", remaining)
			row.StockLow = remaining < 100
			row.StockPct = clampPct(float64(remaining) / stockG * 100)
		}
	}
	return row
}

// clampPct mirrors public-src/views/library.js's own
// `Math.max(0, Math.min(100, ...))` stock-bar clamp (renderBeanList) — a bar
// width is only ever meaningful inside [0,100], and a bean can go
// (near-)negative remaining once consumption outpaces a stale stock_g.
func clampPct(pct float64) float64 {
	if pct < 0 {
		return 0
	}
	if pct > 100 {
		return 100
	}
	return pct
}

// formatWearGrams ports public-src/views/library.js's formatWearGrams: grams
// under 1000 print as a rounded integer, at/above 1000 as one decimal of kg.
func formatWearGrams(g float64) string {
	if g >= 1000 {
		return fmt.Sprintf("%.1f kg", g/1000)
	}
	return fmt.Sprintf("%.0f g", g)
}

// toGrinderRow builds a templates.GrinderRow, including its computed (not
// stored) wear stats — see library.ComputeGrinderWearStats.
func toGrinderRow(grinder library.Entity, shotsSinceBurrs int, gramsSinceBurrs float64) templates.GrinderRow {
	return templates.GrinderRow{
		ID:              entityID(grinder),
		Name:            strField(grinder, "name"),
		BurrType:        strField(grinder, "burrType"),
		PurchaseDate:    strField(grinder, "purchaseDate"),
		Notes:           strField(grinder, "notes"),
		ShotsSinceBurrs: shotsSinceBurrs,
		GramsSinceBurrs: formatWearGrams(gramsSinceBurrs),
	}
}

func toBasketRow(basket library.Entity) templates.BasketRow {
	return templates.BasketRow{
		ID:           entityID(basket),
		Name:         strField(basket, "name"),
		WallType:     strField(basket, "wallType"),
		Shape:        strField(basket, "shape"),
		DoseCapacity: strField(basket, "doseCapacity"),
		HoleCount:    strField(basket, "holeCount"),
		Notes:        strField(basket, "notes"),
	}
}

func toPuckScreenRow(puckScreen library.Entity) templates.PuckScreenRow {
	return templates.PuckScreenRow{
		ID:        entityID(puckScreen),
		Name:      strField(puckScreen, "name"),
		Thickness: strField(puckScreen, "thickness"),
		Material:  strField(puckScreen, "material"),
		Notes:     strField(puckScreen, "notes"),
	}
}

// toMilkRow mirrors internal/library's own listMilks projection
// (handlers_milks.go): emoji defaults to the milk-carton emoji when unset,
// stockMl formatted as a plain "N ml" (milks have no untracked-vs-tracked
// distinction beans/baskets do — every milk always has a numeric stockMl,
// possibly 0).
func toMilkRow(milk library.Entity) templates.MilkRow {
	emoji := strField(milk, "emoji")
	if emoji == "" {
		emoji = "🥛"
	}
	stockMl, _ := milk["stockMl"].(float64)
	return templates.MilkRow{
		ID:         entityID(milk),
		Name:       strField(milk, "name"),
		Emoji:      emoji,
		StockMl:    fmt.Sprintf("%g ml", stockMl),
		StockMlRaw: stockMl,
		StockPct:   milkStockPct(stockMl),
		StockClass: milkStockClass(stockMl),
	}
}

// milkStockPct/milkStockClass mirror public-src/views/library.js's
// renderMilkList exactly: 2000ml reads as a full bar (an arbitrary but
// stable reference capacity — milks have no stored container size of their
// own), and the same 300ml "low" cutoff picks the bar's colour.
func milkStockPct(stockMl float64) float64 {
	if stockMl <= 0 {
		return 0
	}
	return clampPct(stockMl / 20)
}

func milkStockClass(stockMl float64) string {
	switch {
	case stockMl <= 0:
		return "empty"
	case stockMl < 300:
		return "low"
	default:
		return "ok"
	}
}

func toRecipeRow(recipe library.Entity) templates.RecipeRow {
	return templates.RecipeRow{
		ID:         entityID(recipe),
		Name:       strField(recipe, "name"),
		BrewMethod: strField(recipe, "brewMethod"),
		DrinkType:  strField(recipe, "drinkType"),
		Notes:      strField(recipe, "notes"),
	}
}
