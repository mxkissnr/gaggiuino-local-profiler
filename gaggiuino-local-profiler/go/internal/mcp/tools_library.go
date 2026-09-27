package mcp

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// The library tools (list_beans, get_library) read internal/library's
// repository. Every entity is a map[string]any (library.Entity), so the
// helpers at the bottom of this file read fields defensively — a key
// added or removed in a later app version must never panic a tool call.

type listBeansInput struct {
	ActiveOnly *bool  `json:"active_only,omitempty" jsonschema:"only beans currently enabled in the library (default true); set false to include disabled beans"`
	Query      string `json:"query,omitempty" jsonschema:"case-insensitive substring matched against the bean name, roaster or origin"`
	Cursor     string `json:"cursor,omitempty" jsonschema:"opaque paging cursor from a previous list_beans response's next_cursor; omit for the first page"`
	Limit      int    `json:"limit,omitempty" jsonschema:"maximum beans to return, 1..100 (default 20)"`
}

type knownGrindSetting struct {
	Grinder      string `json:"grinder" jsonschema:"grinder name the setting applies to"`
	GrindSetting string `json:"grind_setting" jsonschema:"remembered winning grind setting for this grinder"`
}

type beanInfo struct {
	ID                  int64               `json:"id" jsonschema:"the bean's stable id"`
	Name                string              `json:"name" jsonschema:"bean (coffee) name"`
	Roaster             string              `json:"roaster,omitempty" jsonschema:"roaster name"`
	Origin              string              `json:"origin,omitempty" jsonschema:"origin country code"`
	Process             string              `json:"process,omitempty" jsonschema:"process (washed, natural, ...)"`
	RoastLevel          string              `json:"roast_level,omitempty" jsonschema:"roast level"`
	RoastDate           string              `json:"roast_date,omitempty" jsonschema:"roast date, YYYY-MM-DD"`
	DaysSinceRoast      *int                `json:"days_since_roast,omitempty" jsonschema:"whole days since the roast date"`
	Active              bool                `json:"active" jsonschema:"whether the bean is enabled in the library"`
	RemainingG          *int64              `json:"remaining_g,omitempty" jsonschema:"remaining stock in grams, frozen portions included; omitted when stock is not tracked"`
	FrozenPortionsG     *float64            `json:"frozen_portions_g,omitempty" jsonschema:"grams held in unthawed frozen portions of the active bag"`
	FrozenPortionsCount *int64              `json:"frozen_portions_count,omitempty" jsonschema:"number of unthawed frozen portions of the active bag"`
	KnownGrindSettings  []knownGrindSetting `json:"known_grind_settings,omitempty" jsonschema:"remembered winning grind settings per grinder"`
}

type listBeansOutput struct {
	Beans      []beanInfo `json:"beans" jsonschema:"one page of beans, ordered by name"`
	NextCursor string     `json:"next_cursor,omitempty" jsonschema:"pass back as cursor to fetch the next page; empty when there are no more"`
}

type getLibraryInput struct {
	Section string `json:"section,omitempty" jsonschema:"return only this section; omit for every section"`
}

type grinderInfo struct {
	ID              int64    `json:"id" jsonschema:"the grinder's stable id"`
	Name            string   `json:"name" jsonschema:"grinder name"`
	BurrType        string   `json:"burr_type,omitempty" jsonschema:"burr type"`
	PurchaseDate    string   `json:"purchase_date,omitempty" jsonschema:"purchase date, YYYY-MM-DD"`
	BurrsResetAt    string   `json:"burrs_reset_at,omitempty" jsonschema:"date the burrs were last reset or replaced"`
	ShotsSinceBurrs int      `json:"shots_since_burrs" jsonschema:"shots ground since the burr reset"`
	GramsSinceBurrs float64  `json:"grams_since_burrs" jsonschema:"grams of coffee ground since the burr reset"`
	ZeroPoint       *float64 `json:"zero_point,omitempty" jsonschema:"current grind zero point, when the grinder tracks one"`
}

type basketInfo struct {
	ID           int64  `json:"id" jsonschema:"the basket's stable id"`
	Name         string `json:"name" jsonschema:"basket name"`
	DoseCapacity string `json:"dose_capacity,omitempty" jsonschema:"rated dose capacity"`
	WallType     string `json:"wall_type,omitempty" jsonschema:"wall type (straight, tapered, ...)"`
	Shape        string `json:"shape,omitempty" jsonschema:"basket shape"`
	HoleCount    string `json:"hole_count,omitempty" jsonschema:"hole count"`
}

type puckScreenInfo struct {
	ID        int64  `json:"id" jsonschema:"the puck screen's stable id"`
	Name      string `json:"name" jsonschema:"puck screen name"`
	Thickness string `json:"thickness,omitempty" jsonschema:"screen thickness"`
	Material  string `json:"material,omitempty" jsonschema:"screen material"`
}

type milkInfo struct {
	ID      int64   `json:"id" jsonschema:"the milk's stable id"`
	Name    string  `json:"name" jsonschema:"milk name"`
	Emoji   string  `json:"emoji,omitempty" jsonschema:"emoji shown for this milk"`
	StockMl float64 `json:"stock_ml" jsonschema:"remaining stock in millilitres"`
}

type recipeInfo struct {
	ID          int64    `json:"id" jsonschema:"the recipe's stable id"`
	Name        string   `json:"name" jsonschema:"recipe name"`
	BrewMethod  string   `json:"brew_method,omitempty" jsonschema:"brew method"`
	DrinkType   string   `json:"drink_type,omitempty" jsonschema:"drink type"`
	GrindSize   string   `json:"grind_size,omitempty" jsonschema:"grind size"`
	ProfileName string   `json:"profile_name,omitempty" jsonschema:"brewing profile the recipe targets"`
	BeanName    string   `json:"bean_name,omitempty" jsonschema:"bean the recipe targets"`
	TargetDose  *float64 `json:"target_dose_g,omitempty" jsonschema:"target dose, grams"`
	TargetYield *float64 `json:"target_yield_g,omitempty" jsonschema:"target yield, grams"`
	TargetTime  *float64 `json:"target_time_s,omitempty" jsonschema:"target brew time, seconds"`
	WaterTemp   *float64 `json:"water_temp_c,omitempty" jsonschema:"target water temperature, Celsius"`
	WaterG      *float64 `json:"water_g,omitempty" jsonschema:"target water, grams"`
	IceG        *float64 `json:"ice_g,omitempty" jsonschema:"target ice, grams"`
}

type libraryOutput struct {
	Grinders    []grinderInfo    `json:"grinders" jsonschema:"configured grinders, with burr wear"`
	Baskets     []basketInfo     `json:"baskets" jsonschema:"configured baskets"`
	PuckScreens []puckScreenInfo `json:"puck_screens" jsonschema:"configured puck screens"`
	Milks       []milkInfo       `json:"milks" jsonschema:"configured milks"`
	Recipes     []recipeInfo     `json:"recipes" jsonschema:"saved recipes"`
}

func registerLibraryTools(srv *mcpsdk.Server, deps Deps) {
	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:        "list_beans",
		Title:       "List beans",
		Description: "List coffee beans from the user's library as compact summaries: roaster, origin, process, roast level/date, active flag, remaining stock in grams and remembered grind settings. Filter with query (name/roaster/origin substring) and active_only. Page with cursor/limit. Use before describing a bean or reasoning about stock.",
		Annotations: readOnlyAnnotations("List beans"),
		InputSchema: listBeansSchema(),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in listBeansInput) (*mcpsdk.CallToolResult, listBeansOutput, error) {
		out, err := listBeans(deps, in)
		return nil, out, err
	})

	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:        "get_library",
		Title:       "Get library",
		Description: "List the user's coffee equipment and recipes: grinders (burr type, last burr reset, shots/grams since, zero point), baskets, puck screens, milks and recipes, with names and key attributes only (no images). Pass section to return just one of grinders, baskets, puck_screens, milks or recipes.",
		Annotations: readOnlyAnnotations("Get library"),
		InputSchema: getLibraryInputSchema(),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in getLibraryInput) (*mcpsdk.CallToolResult, libraryOutput, error) {
		out, err := getLibrary(deps, in)
		return nil, out, err
	})
}

func listBeansSchema() *jsonschema.Schema {
	s := mustSchema[listBeansInput]()
	if p := schemaProp(s, "limit"); p != nil {
		p.Minimum = jsonschema.Ptr(1.0)
		p.Maximum = jsonschema.Ptr(float64(maxListLimit))
		p.Default = json.RawMessage(strconv.Itoa(defaultListLimit))
	}
	if p := schemaProp(s, "active_only"); p != nil {
		p.Default = json.RawMessage("true")
	}
	return s
}

func getLibraryInputSchema() *jsonschema.Schema {
	s := mustSchema[getLibraryInput]()
	if p := schemaProp(s, "section"); p != nil {
		p.Enum = []any{"grinders", "baskets", "puck_screens", "milks", "recipes"}
	}
	return s
}

func listBeans(deps Deps, in listBeansInput) (listBeansOutput, error) {
	if deps.Library == nil {
		return listBeansOutput{}, fmt.Errorf("the coffee library is not available")
	}
	// The input schema enforces limit 1..100 and defaults it to 20; this
	// fallback only matters for a directly-constructed In value.
	limit := in.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		// Client-supplied input, not an internal failure: safe to describe.
		return listBeansOutput{}, fmt.Errorf("invalid cursor; omit it to start from the first page")
	}
	lib, err := deps.Library.GetLibrary()
	if err != nil {
		log.Printf("mcp: list_beans: reading library: %v", err)
		return listBeansOutput{}, fmt.Errorf("could not read the coffee library; try again")
	}

	activeOnly := true
	if in.ActiveOnly != nil {
		activeOnly = *in.ActiveOnly
	}
	query := strings.ToLower(strings.TrimSpace(in.Query))

	beans := make([]library.Entity, 0, len(lib.Beans))
	for _, bean := range lib.Beans {
		if activeOnly && !entityActive(bean) {
			continue
		}
		if query != "" && !beanMatchesQuery(bean, query) {
			continue
		}
		beans = append(beans, bean)
	}
	// Stable, deterministic order: case-insensitive name, then id.
	sort.SliceStable(beans, func(i, j int) bool {
		ni, nj := strings.ToLower(entityStr(beans[i], "name")), strings.ToLower(entityStr(beans[j], "name"))
		if ni != nj {
			return ni < nj
		}
		return entityID(beans[i]) < entityID(beans[j])
	})

	out := listBeansOutput{Beans: []beanInfo{}}
	if offset >= len(beans) {
		return out, nil
	}
	end := offset + limit
	if end > len(beans) {
		end = len(beans)
	}

	// Annotated doses back computeBeanRemaining's stock maths; load them once,
	// lazily, only when a bean on this page actually tracks stock.
	var (
		doseRows     []shots.AnnotatedDose
		dosesLoaded  bool
		dosesFailed  bool
		now          = time.Now()
	)
	for _, bean := range beans[offset:end] {
		if !dosesLoaded && !dosesFailed && deps.ShotsRepo != nil && tracksStock(bean) {
			dosesLoaded = true
			rows, derr := deps.ShotsRepo.GetAnnotatedDoses()
			if derr != nil {
				log.Printf("mcp: list_beans: reading annotated doses: %v", derr)
				dosesFailed = true
			} else {
				doseRows = rows
			}
		}
		out.Beans = append(out.Beans, toBeanInfo(bean, lib.Beans, doseRows, now))
	}
	if end < len(beans) {
		out.NextCursor = encodeOffsetCursor(end)
	}
	return out, nil
}

func toBeanInfo(bean library.Entity, allBeans []library.Entity, doseRows []shots.AnnotatedDose, now time.Time) beanInfo {
	out := beanInfo{
		ID:         entityID(bean),
		Name:       entityStr(bean, "name"),
		Roaster:    entityStr(bean, "roaster"),
		Origin:     entityStr(bean, "origin"),
		Process:    entityStr(bean, "process"),
		RoastLevel: entityStr(bean, "roastType"),
		Active:     entityActive(bean),
	}
	if roastDate := beanRoastDate(bean); roastDate != "" {
		out.RoastDate = roastDate
		if days, ok := daysSinceDate(roastDate, now); ok {
			out.DaysSinceRoast = &days
		}
	}
	if remaining, ok := library.ComputeBeanRemaining(bean, doseRows, allBeans); ok {
		out.RemainingG = &remaining
	}
	if grams, count, ok := frozenPortionTotals(bean); ok {
		out.FrozenPortionsG = &grams
		out.FrozenPortionsCount = &count
	}
	if known := knownGrinds(bean); len(known) > 0 {
		out.KnownGrindSettings = known
	}
	return out
}

func getLibrary(deps Deps, in getLibraryInput) (libraryOutput, error) {
	if deps.Library == nil {
		return libraryOutput{}, fmt.Errorf("the coffee library is not available")
	}
	section := strings.TrimSpace(in.Section)
	if section != "" && !validLibrarySection(section) {
		return libraryOutput{}, fmt.Errorf("unknown section %q; use one of grinders, baskets, puck_screens, milks, recipes", section)
	}
	lib, err := deps.Library.GetLibrary()
	if err != nil {
		log.Printf("mcp: get_library: reading library: %v", err)
		return libraryOutput{}, fmt.Errorf("could not read the coffee library; try again")
	}
	out := libraryOutput{
		Grinders:    []grinderInfo{},
		Baskets:     []basketInfo{},
		PuckScreens: []puckScreenInfo{},
		Milks:       []milkInfo{},
		Recipes:     []recipeInfo{},
	}
	var allShots []shots.Shot
	if (section == "" || section == "grinders") && deps.Shots != nil {
		allShots, err = deps.Shots.GetAll()
		if err != nil {
			log.Printf("mcp: get_library: reading shots for grinder wear: %v", err)
			return libraryOutput{}, fmt.Errorf("could not read the coffee library; try again")
		}
	}
	if section == "" || section == "grinders" {
		for _, g := range lib.Grinders {
			out.Grinders = append(out.Grinders, toGrinderInfo(g, allShots))
		}
	}
	if section == "" || section == "baskets" {
		for _, b := range lib.Baskets {
			out.Baskets = append(out.Baskets, basketInfo{
				ID:           entityID(b),
				Name:         entityStr(b, "name"),
				DoseCapacity: entityStr(b, "doseCapacity"),
				WallType:     entityStr(b, "wallType"),
				Shape:        entityStr(b, "shape"),
				HoleCount:    entityStr(b, "holeCount"),
			})
		}
	}
	if section == "" || section == "puck_screens" {
		for _, p := range lib.PuckScreens {
			out.PuckScreens = append(out.PuckScreens, puckScreenInfo{
				ID:        entityID(p),
				Name:      entityStr(p, "name"),
				Thickness: entityStr(p, "thickness"),
				Material:  entityStr(p, "material"),
			})
		}
	}
	if section == "" || section == "milks" {
		for _, m := range lib.Milks {
			stock, _ := entityFloat(m, "stockMl")
			out.Milks = append(out.Milks, milkInfo{
				ID:      entityID(m),
				Name:    entityStr(m, "name"),
				Emoji:   entityStr(m, "emoji"),
				StockMl: stock,
			})
		}
	}
	if section == "" || section == "recipes" {
		for _, r := range lib.Recipes {
			out.Recipes = append(out.Recipes, toRecipeInfo(r))
		}
	}
	return out, nil
}

func validLibrarySection(s string) bool {
	switch s {
	case "grinders", "baskets", "puck_screens", "milks", "recipes":
		return true
	}
	return false
}

func toGrinderInfo(g library.Entity, allShots []shots.Shot) grinderInfo {
	out := grinderInfo{
		ID:           entityID(g),
		Name:         entityStr(g, "name"),
		BurrType:     entityStr(g, "burrType"),
		PurchaseDate: entityStr(g, "purchaseDate"),
		BurrsResetAt: entityStr(g, "burrsResetAt"),
	}
	if zp, ok := grinderZeroPoint(g); ok {
		out.ZeroPoint = &zp
	}
	// allShots is nil when the section wasn't requested or the shots service
	// is unwired: report zero wear rather than guessing.
	if allShots != nil {
		shotsSince, grams := library.ComputeGrinderWearFrom(allShots, g)
		out.ShotsSinceBurrs = shotsSince
		out.GramsSinceBurrs = grams
	}
	return out
}

func toRecipeInfo(r library.Entity) recipeInfo {
	out := recipeInfo{
		ID:          entityID(r),
		Name:        entityStr(r, "name"),
		BrewMethod:  entityStr(r, "brewMethod"),
		DrinkType:   entityStr(r, "drinkType"),
		GrindSize:   entityStr(r, "grindSize"),
		ProfileName: entityStr(r, "profileName"),
		BeanName:    entityStr(r, "beanName"),
	}
	if v, ok := entityFloat(r, "targetDose_g"); ok {
		out.TargetDose = &v
	}
	if v, ok := entityFloat(r, "targetYield_g"); ok {
		out.TargetYield = &v
	}
	if v, ok := entityFloat(r, "targetTime_s"); ok {
		out.TargetTime = &v
	}
	if v, ok := entityFloat(r, "waterTemp_c"); ok {
		out.WaterTemp = &v
	}
	if v, ok := entityFloat(r, "water_g"); ok {
		out.WaterG = &v
	}
	if v, ok := entityFloat(r, "ice_g"); ok {
		out.IceG = &v
	}
	return out
}

// grinderZeroPoint reads the most recently activated zero point from the
// grinder's zeroPointHistory, mirroring library.currentGrinderZeroPoint
// (unexported there).
func grinderZeroPoint(g library.Entity) (float64, bool) {
	raw, _ := g["zeroPointHistory"].([]any)
	var (
		best      float64
		bestSince int64 = -1
		found     bool
	)
	for _, item := range raw {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		zp, ok := entityFloat(m, "zeroPoint")
		if !ok {
			continue
		}
		since, _ := entityInt(m, "since")
		if !found || since >= bestSince {
			best, bestSince, found = zp, since, true
		}
	}
	return best, found
}

func frozenPortionTotals(bean library.Entity) (grams float64, count int64, ok bool) {
	bag := activeBagOf(bean)
	if bag == nil {
		return 0, 0, false
	}
	portions, _ := bag["frozenPortions"].([]any)
	for _, raw := range portions {
		p, _ := raw.(map[string]any)
		if p == nil {
			continue
		}
		if _, thawed := p["thawedAt"]; thawed {
			continue
		}
		remaining, hasRemaining := entityInt(p, "remainingCount")
		if !hasRemaining {
			remaining, _ = entityInt(p, "portionCount")
		}
		if remaining <= 0 {
			continue
		}
		weight, hasWeight := entityFloat(p, "portionWeight_g")
		if !hasWeight {
			continue
		}
		grams += weight * float64(remaining)
		count += remaining
	}
	if count == 0 {
		return 0, 0, false
	}
	return grams, count, true
}

func knownGrinds(bean library.Entity) []knownGrindSetting {
	raw, _ := bean["knownGrindSettings"].([]any)
	out := []knownGrindSetting{}
	for _, item := range raw {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		grinder := entityStr(m, "grinder")
		setting := grindSettingString(m["grindSetting"])
		if grinder == "" && setting == "" {
			continue
		}
		out = append(out, knownGrindSetting{Grinder: grinder, GrindSetting: setting})
	}
	return out
}

// grindSettingString renders a knownGrindSettings value the way the app
// stores it: normally a string, but a numeric click count is also accepted.
func grindSettingString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		if t != t {
			return ""
		}
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	case int64:
		return strconv.FormatInt(t, 10)
	default:
		return ""
	}
}

func beanRoastDate(bean library.Entity) string {
	if bag := activeBagOf(bean); bag != nil {
		if v := entityStr(bag, "roastDate"); v != "" {
			return v
		}
	}
	return entityStr(bean, "roastDate")
}

func beanMatchesQuery(bean library.Entity, query string) bool {
	for _, key := range []string{"name", "roaster", "origin"} {
		if strings.Contains(strings.ToLower(entityStr(bean, key)), query) {
			return true
		}
	}
	return false
}

func tracksStock(bean library.Entity) bool {
	v, ok := entityFloat(bean, "stock_g")
	return ok && v > 0
}

func daysSinceDate(date string, now time.Time) (int, bool) {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		t, err = time.Parse(time.RFC3339, date)
		if err != nil {
			return 0, false
		}
	}
	days := int(now.Sub(t).Hours() / 24)
	if days < 0 {
		days = 0
	}
	return days, true
}

func encodeOffsetCursor(offset int) string {
	if offset <= 0 {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(offset)))
}

func decodeOffsetCursor(token string) (int, error) {
	if token == "" {
		return 0, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(string(raw))
	if err != nil || n < 0 {
		return 0, fmt.Errorf("bad cursor payload")
	}
	return n, nil
}

func entityID(e library.Entity) int64 {
	switch v := e["id"].(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	case int:
		return int64(v)
	default:
		return 0
	}
}

func entityStr(e library.Entity, key string) string {
	v, _ := e[key].(string)
	return v
}

func entityFloat(e library.Entity, key string) (float64, bool) {
	switch v := e[key].(type) {
	case float64:
		if v != v { // NaN
			return 0, false
		}
		return v, true
	case int64:
		return float64(v), true
	case int:
		return float64(v), true
	default:
		return 0, false
	}
}

func entityInt(e library.Entity, key string) (int64, bool) {
	switch v := e[key].(type) {
	case int64:
		return v, true
	case float64:
		if v != v { // NaN
			return 0, false
		}
		return int64(v), true
	case int:
		return int64(v), true
	default:
		return 0, false
	}
}

// entityActive mirrors library.sanitizeEnabled's default: an absent
// `enabled` key means the bean is active; only an explicit false-ish value
// disables it.
func entityActive(e library.Entity) bool {
	switch v := e["enabled"].(type) {
	case bool:
		return v
	case string:
		return v != "false" && v != "0"
	case float64:
		return v != 0
	default:
		return true
	}
}

func activeBagOf(bean library.Entity) library.Entity {
	bags, _ := bean["bags"].([]any)
	if len(bags) == 0 {
		return nil
	}
	m, _ := bags[len(bags)-1].(map[string]any)
	return m
}
