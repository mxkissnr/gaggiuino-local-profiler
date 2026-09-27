package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/jsonschema-go/jsonschema"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// Limits. Input schema bounds are documented in each field's jsonschema tag
// and enforced here; defaults are applied when the field is absent.
const (
	defaultListLimit   = 20
	maxListLimit       = 100
	minListChunk       = 20
	defaultCurvePoints = 100
	minCurvePoints     = 20
	maxCurvePoints     = 500
	minCompareIDs      = 2
	maxCompareIDs      = 5
)

type listShotsInput struct {
	Bean      string `json:"bean,omitempty" jsonschema:"case-insensitive substring of the shot's bean (coffee) name annotation"`
	MachineID int64  `json:"machine_id,omitempty" jsonschema:"only shots pulled on this machine id; omit or 0 for all machines"`
	MinRating int    `json:"min_rating,omitempty" jsonschema:"only shots whose 1-5 star rating is at least this value"`
	Since     string `json:"since,omitempty" jsonschema:"only shots at or after this date-time, RFC 3339 e.g. 2026-01-31T00:00:00Z"`
	Until     string `json:"until,omitempty" jsonschema:"only shots strictly before this date-time, RFC 3339"`
	Cursor    string `json:"cursor,omitempty" jsonschema:"opaque paging cursor from a previous list_shots response's next_cursor; omit for the first page"`
	Limit     int    `json:"limit,omitempty" jsonschema:"maximum summaries to return, 1..100 (default 20)"`
}

type shotSummary struct {
	ID           int64    `json:"id" jsonschema:"the shot's stable id"`
	Timestamp    string   `json:"timestamp" jsonschema:"shot start time, RFC 3339 UTC"`
	MachineID    int64    `json:"machine_id" jsonschema:"machine that pulled the shot"`
	ProfileName  string   `json:"profile_name,omitempty" jsonschema:"brewing profile name"`
	Bean         string   `json:"bean,omitempty" jsonschema:"bean (coffee) name annotation"`
	DoseInG      *float64 `json:"dose_in_g,omitempty" jsonschema:"ground coffee dosed in, grams (annotation dose)"`
	DoseOutG     *float64 `json:"dose_out_g,omitempty" jsonschema:"final yield in the cup, grams"`
	Ratio        *float64 `json:"ratio,omitempty" jsonschema:"yield-to-dose ratio, expressed as 1:X where X is this value"`
	DurationS    *float64 `json:"duration_s,omitempty" jsonschema:"total pump time, seconds"`
	Score        *int     `json:"score,omitempty" jsonschema:"GLP score 0-100; omitted when there is too little data to score"`
	Rating       *int     `json:"rating,omitempty" jsonschema:"the user's 1-5 star rating"`
	GrindSetting string   `json:"grind_setting,omitempty" jsonschema:"free-text grinder setting"`
	Notes        string   `json:"notes,omitempty" jsonschema:"short user notes"`
}

type listShotsOutput struct {
	Shots      []shotSummary `json:"shots" jsonschema:"one page of shot summaries, newest first"`
	NextCursor string        `json:"next_cursor,omitempty" jsonschema:"pass back as cursor to fetch the next page; empty when there are no more"`
}

type getShotInput struct {
	ID           int64 `json:"id" jsonschema:"the shot id to fetch; use list_shots to find ids"`
	IncludeCurve bool  `json:"include_curve,omitempty" jsonschema:"when true, include the downsampled brew curve"`
	CurvePoints  int   `json:"curve_points,omitempty" jsonschema:"samples per curve series, 20..500 (default 100); ignored unless include_curve is true"`
}

type shotMetrics struct {
	DoseInG            *float64 `json:"dose_in_g,omitempty" jsonschema:"ground coffee dosed in, grams"`
	YieldG             *float64 `json:"yield_g,omitempty" jsonschema:"final weight in the cup, grams"`
	Ratio              *float64 `json:"ratio,omitempty" jsonschema:"yield-to-dose ratio as 1:X"`
	ExtractionYieldPct *float64 `json:"extraction_yield_pct,omitempty" jsonschema:"extraction yield, percent (needs TDS)"`
	DurationS          float64  `json:"duration_s" jsonschema:"total pump time, seconds"`
	PreinfusionS       *float64 `json:"preinfusion_s,omitempty" jsonschema:"preinfusion duration, seconds"`
	ExtractionS        *float64 `json:"extraction_s,omitempty" jsonschema:"extraction duration, seconds"`
	Channeling         bool     `json:"channeling" jsonschema:"whether the pressure trace shows channeling"`
	AvgPressureBar     *float64 `json:"avg_pressure_bar,omitempty" jsonschema:"mean active pressure, bar"`
}

type comparativeAdvice struct {
	Type             string  `json:"type" jsonschema:"one of finer, coarser or ok"`
	Text             string  `json:"text" jsonschema:"human-readable advice"`
	SampleCount      int     `json:"sample_count" jsonschema:"number of comparable shots"`
	BestGrindSetting float64 `json:"best_grind_setting" jsonschema:"grind setting that scored best among comparable shots"`
	BestScore        int     `json:"best_score" jsonschema:"average score for the best grind setting"`
}

type curveSeries struct {
	Name   string    `json:"name" jsonschema:"series name"`
	Unit   string    `json:"unit" jsonschema:"unit of the values"`
	Values []float64 `json:"values" jsonschema:"evenly spaced samples, aligned with time_s"`
}

type shotCurve struct {
	Points int           `json:"points" jsonschema:"number of samples in time_s and each series"`
	TimeS  []float64     `json:"time_s" jsonschema:"shared time axis, seconds"`
	Series []curveSeries `json:"series" jsonschema:"pressure (bar), flow (ml/s), weight (g), temperature (C) and any targets"`
}

type getShotOutput struct {
	ID                int64              `json:"id" jsonschema:"the shot's stable id"`
	Timestamp         string             `json:"timestamp" jsonschema:"shot start time, RFC 3339 UTC"`
	MachineID         int64              `json:"machine_id" jsonschema:"machine that pulled the shot"`
	ProfileName       string             `json:"profile_name,omitempty" jsonschema:"brewing profile name"`
	Bean              string             `json:"bean,omitempty" jsonschema:"bean (coffee) name annotation"`
	DoseInG           *float64           `json:"dose_in_g,omitempty" jsonschema:"ground coffee dosed in, grams"`
	DoseOutG          *float64           `json:"dose_out_g,omitempty" jsonschema:"final yield in the cup, grams"`
	Ratio             *float64           `json:"ratio,omitempty" jsonschema:"yield-to-dose ratio as 1:X"`
	DurationS         *float64           `json:"duration_s,omitempty" jsonschema:"total pump time, seconds"`
	Score             *int               `json:"score,omitempty" jsonschema:"GLP score 0-100"`
	Rating            *int               `json:"rating,omitempty" jsonschema:"the user's 1-5 star rating"`
	GrindSetting      string             `json:"grind_setting,omitempty" jsonschema:"free-text grinder setting"`
	Notes             string             `json:"notes,omitempty" jsonschema:"short user notes"`
	UsedBeanTarget    bool               `json:"used_bean_target" jsonschema:"whether the score used a bean-specific target"`
	Metrics           *shotMetrics       `json:"metrics,omitempty" jsonschema:"derived recipe/duration/channeling figures"`
	Annotation        map[string]any     `json:"annotation,omitempty" jsonschema:"the raw shot annotation (coffee, grinder, dose, notes, flavours, ...)"`
	ComparativeAdvice *comparativeAdvice `json:"comparative_grind_advice,omitempty" jsonschema:"history-aware grind advice, when comparable shots exist"`
	Curve             *shotCurve         `json:"curve,omitempty" jsonschema:"downsampled brew curve; only when include_curve is true"`
}

type compareShotsInput struct {
	IDs []int64 `json:"ids" jsonschema:"2 to 5 shot ids to compare; the first is the baseline"`
}

type compareShot struct {
	ID           int64    `json:"id" jsonschema:"shot id"`
	ProfileName  string   `json:"profile_name,omitempty" jsonschema:"brewing profile name"`
	Bean         string   `json:"bean,omitempty" jsonschema:"bean (coffee) name annotation"`
	DoseInG      *float64 `json:"dose_in_g,omitempty" jsonschema:"ground coffee dosed in, grams"`
	DoseOutG     *float64 `json:"dose_out_g,omitempty" jsonschema:"final yield, grams"`
	Ratio        *float64 `json:"ratio,omitempty" jsonschema:"yield-to-dose ratio as 1:X"`
	DurationS    *float64 `json:"duration_s,omitempty" jsonschema:"pump time, seconds"`
	Score        *int     `json:"score,omitempty" jsonschema:"GLP score 0-100"`
	Rating       *int     `json:"rating,omitempty" jsonschema:"1-5 star rating"`
	GrindSetting string   `json:"grind_setting,omitempty" jsonschema:"free-text grinder setting"`
}

type compareMetric struct {
	ShotID   int64   `json:"shot_id" jsonschema:"the shot this delta belongs to"`
	Metric   string  `json:"metric" jsonschema:"metric name"`
	Unit     string  `json:"unit" jsonschema:"metric unit"`
	Baseline float64 `json:"baseline" jsonschema:"value for the first (baseline) shot"`
	Value    float64 `json:"value" jsonschema:"value for this shot"`
	Delta    float64 `json:"delta" jsonschema:"value minus baseline"`
}

type compareShotsOutput struct {
	Shots  []compareShot   `json:"shots" jsonschema:"the compared shots, in the requested order"`
	Deltas []compareMetric `json:"deltas" jsonschema:"per-metric deltas against the first shot"`
}

func readOnlyAnnotations(title string) *mcpsdk.ToolAnnotations {
	openWorld := false
	return &mcpsdk.ToolAnnotations{
		Title:          title,
		ReadOnlyHint:   true,
		IdempotentHint: true,
		OpenWorldHint:  &openWorld,
	}
}

func registerShotTools(srv *mcpsdk.Server, svc *shots.Service) {
	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:        "list_shots",
		Title:       "List shots",
		Description: "List espresso shots from the user's history, newest first, as compact summaries without brew curves. Filter by bean name substring, machine id, minimum 1-5 star rating and an RFC 3339 date range. Page with cursor/limit. Use this to discover shot ids before calling get_shot or compare_shots.",
		Annotations: readOnlyAnnotations("List shots"),
		InputSchema: listShotsSchema(),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in listShotsInput) (*mcpsdk.CallToolResult, listShotsOutput, error) {
		out, err := listShots(svc, in)
		return nil, out, err
	})

	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:         "get_shot",
		Title:        "Get shot",
		Description:  "Fetch one shot by id: its key recipe metrics in grams and seconds, score, annotation and, on request, the brew curve downsampled to a fixed number of samples per series (time s, pressure bar, flow ml/s, weight g, temperature C and any targets). Set include_curve only when the chart is actually needed.",
		Annotations:  readOnlyAnnotations("Get shot"),
		InputSchema:  getShotInputSchema(),
		OutputSchema: getShotOutputSchema(),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in getShotInput) (*mcpsdk.CallToolResult, getShotOutput, error) {
		out, err := getShot(svc, in)
		return nil, out, err
	})

	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:        "compare_shots",
		Title:       "Compare shots",
		Description: "Compare two to five shots side by side: key metrics for each, plus per-metric deltas of every shot against the first (baseline) shot. No curves.",
		Annotations: readOnlyAnnotations("Compare shots"),
		InputSchema: compareShotsSchema(),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in compareShotsInput) (*mcpsdk.CallToolResult, compareShotsOutput, error) {
		out, err := compareShots(svc, in)
		return nil, out, err
	})
}

// mustSchema infers the JSON schema for T. AddTool would infer the same
// schema on its own; building it here lets each tool advertise the explicit
// bounds, defaults and enums the plan requires — things a jsonschema struct
// tag (a plain description) cannot express — which the SDK then enforces
// before the handler runs.
func mustSchema[T any]() *jsonschema.Schema {
	s, err := jsonschema.For[T](&jsonschema.ForOptions{})
	if err != nil {
		panic(fmt.Sprintf("mcp: inferring schema: %v", err))
	}
	return s
}

func schemaProp(s *jsonschema.Schema, name string) *jsonschema.Schema {
	if s == nil || s.Properties == nil {
		return nil
	}
	return s.Properties[name]
}

func listShotsSchema() *jsonschema.Schema {
	s := mustSchema[listShotsInput]()
	if p := schemaProp(s, "limit"); p != nil {
		p.Minimum = jsonschema.Ptr(1.0)
		p.Maximum = jsonschema.Ptr(float64(maxListLimit))
		p.Default = json.RawMessage(strconv.Itoa(defaultListLimit))
	}
	if p := schemaProp(s, "min_rating"); p != nil {
		p.Minimum = jsonschema.Ptr(1.0)
		p.Maximum = jsonschema.Ptr(5.0)
	}
	return s
}

func getShotInputSchema() *jsonschema.Schema {
	s := mustSchema[getShotInput]()
	if p := schemaProp(s, "curve_points"); p != nil {
		p.Minimum = jsonschema.Ptr(float64(minCurvePoints))
		p.Maximum = jsonschema.Ptr(float64(maxCurvePoints))
		p.Default = json.RawMessage(strconv.Itoa(defaultCurvePoints))
	}
	return s
}

func compareShotsSchema() *jsonschema.Schema {
	s := mustSchema[compareShotsInput]()
	if p := schemaProp(s, "ids"); p != nil {
		p.MinItems = jsonschema.Ptr(minCompareIDs)
		p.MaxItems = jsonschema.Ptr(maxCompareIDs)
	}
	return s
}

func getShotOutputSchema() *jsonschema.Schema {
	s := mustSchema[getShotOutput]()
	if p := schemaProp(schemaProp(s, "comparative_grind_advice"), "type"); p != nil {
		p.Enum = []any{"finer", "coarser", "ok"}
	}
	return s
}

func listShots(svc *shots.Service, in listShotsInput) (listShotsOutput, error) {
	if svc == nil {
		return listShotsOutput{}, fmt.Errorf("shot history is not available")
	}
	// The input schema enforces limit 1..100 and defaults it to 20; this
	// fallback only matters for a directly-constructed In value.
	limit := in.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	cur, err := shots.DecodeCursor(in.Cursor)
	if err != nil {
		// Client-supplied input, not an internal failure: safe to describe.
		return listShotsOutput{}, fmt.Errorf("invalid cursor; omit it to start from the first page")
	}
	lo, hi, err := parseRange(in.Since, in.Until)
	if err != nil {
		return listShotsOutput{}, err
	}
	bean := strings.ToLower(strings.TrimSpace(in.Bean))

	chunk := limit
	if chunk < minListChunk {
		chunk = minListChunk
	}
	var out []shotSummary
	var nextCur shots.Cursor
	pageCursor := cur
	for {
		page, err := svc.GetPage(pageCursor, chunk, in.MachineID)
		if err != nil {
			log.Printf("mcp: list_shots: reading shot history: %v", err)
			return listShotsOutput{}, fmt.Errorf("could not read shot history; try again")
		}
		for _, row := range page.Rows {
			if !matchesFilters(row.Shot, bean, in.MinRating, lo, hi) {
				continue
			}
			out = append(out, toShotSummary(row.Shot, row.Score))
			nextCur = cursorOf(row)
			if len(out) == limit {
				break
			}
		}
		if len(out) == limit || !page.HasMore {
			break
		}
		pageCursor = page.NextCursor
	}

	res := listShotsOutput{Shots: []shotSummary{}}
	if len(out) > 0 {
		res.Shots = out
	}
	if len(out) == limit {
		res.NextCursor = shots.EncodeCursor(nextCur)
	}
	return res, nil
}

func getShot(svc *shots.Service, in getShotInput) (getShotOutput, error) {
	if svc == nil {
		return getShotOutput{}, fmt.Errorf("shot history is not available")
	}
	shot, err := svc.GetByID(in.ID)
	if err != nil {
		log.Printf("mcp: get_shot %d: %v", in.ID, err)
		return getShotOutput{}, fmt.Errorf("could not read shot %d; try again", in.ID)
	}
	if shot == nil {
		return getShotOutput{}, fmt.Errorf("shot %d not found; use list_shots to find ids", in.ID)
	}
	score := svc.ComputeScore(shot)
	out := getShotOutput{
		ID:             intField(shot, "id"),
		Timestamp:      formatTimestamp(shot),
		MachineID:      machineIDOf(shot),
		ProfileName:    profileNameOf(shot),
		Bean:           annotationString(shot, "coffee"),
		GrindSetting:   annotationString(shot, "grindSetting"),
		UsedBeanTarget: svc.ComputeScoreDetail(shot).UsedBeanTarget,
	}
	out.Notes = truncate(annotationString(shot, "notes"), 200)
	if score != nil {
		s := *score
		out.Score = &s
	}
	if r, ok := ratingOf(shot); ok {
		out.Rating = &r
	}
	m := shots.ComputeShotMetrics(shot)
	out.DoseInG = optionalFloat(m.HasDose, m.DoseG)
	out.DoseOutG = optionalFloat(m.HasYield, m.YieldG)
	out.Ratio = optionalFloat(m.HasRatio, m.Ratio)
	out.DurationS = optionalFloat(m.DurationSecs > 0, m.DurationSecs)
	out.Metrics = buildMetrics(shot)
	if ann := annotationMap(shot); len(ann) > 0 {
		out.Annotation = ann
	}
	if advice, aerr := svc.GetComparativeGrindAdvice(shot); aerr == nil && advice != nil {
		out.ComparativeAdvice = &comparativeAdvice{
			Type:             advice.Type,
			Text:             advice.Text,
			SampleCount:      advice.SampleCount,
			BestGrindSetting: advice.BestGrindSetting,
			BestScore:        advice.BestScore,
		}
	}
	if in.IncludeCurve {
		// The input schema enforces curve_points 20..500 and defaults it to
		// 100; this fallback only matters for a directly-constructed In value.
		points := in.CurvePoints
		if points <= 0 {
			points = defaultCurvePoints
		}
		out.Curve = buildCurve(shot, points)
	}
	return out, nil
}

func compareShots(svc *shots.Service, in compareShotsInput) (compareShotsOutput, error) {
	if svc == nil {
		return compareShotsOutput{}, fmt.Errorf("shot history is not available")
	}
	if len(in.IDs) < minCompareIDs || len(in.IDs) > maxCompareIDs {
		return compareShotsOutput{}, fmt.Errorf("ids must contain %d to %d shot ids", minCompareIDs, maxCompareIDs)
	}
	loaded := make([]shots.Shot, 0, len(in.IDs))
	for _, id := range in.IDs {
		s, err := svc.GetByID(id)
		if err != nil {
			log.Printf("mcp: compare_shots %d: %v", id, err)
			return compareShotsOutput{}, fmt.Errorf("could not read shot %d; try again", id)
		}
		if s == nil {
			return compareShotsOutput{}, fmt.Errorf("shot %d not found; use list_shots to find ids", id)
		}
		loaded = append(loaded, s)
	}
	out := compareShotsOutput{Shots: []compareShot{}, Deltas: []compareMetric{}}
	for _, s := range loaded {
		out.Shots = append(out.Shots, toCompareShot(s, svc.ComputeScore(s)))
	}
	base := compareMetrics(loaded[0], svc.ComputeScore(loaded[0]))
	for _, s := range loaded[1:] {
		vals := compareMetrics(s, svc.ComputeScore(s))
		id := intField(s, "id")
		for _, def := range compareMetricDefs {
			b, okB := base[def.Name]
			v, okV := vals[def.Name]
			if !okB || !okV {
				continue
			}
			out.Deltas = append(out.Deltas, compareMetric{
				ShotID:   id,
				Metric:   def.Name,
				Unit:     def.Unit,
				Baseline: b,
				Value:    v,
				Delta:    v - b,
			})
		}
	}
	return out, nil
}

var compareMetricDefs = []struct {
	Name string
	Unit string
}{
	{"dose_in_g", "g"},
	{"dose_out_g", "g"},
	{"ratio", "1:X"},
	{"duration_s", "s"},
	{"score", "0-100"},
	{"rating", "1-5"},
	{"avg_pressure_bar", "bar"},
}

func compareMetrics(shot shots.Shot, score *int) map[string]float64 {
	m := shots.ComputeShotMetrics(shot)
	out := map[string]float64{}
	if m.HasDose {
		out["dose_in_g"] = m.DoseG
	}
	if m.HasYield {
		out["dose_out_g"] = m.YieldG
	}
	if m.HasRatio {
		out["ratio"] = m.Ratio
	}
	if m.DurationSecs > 0 {
		out["duration_s"] = m.DurationSecs
	}
	if m.HasAvgPressure {
		out["avg_pressure_bar"] = m.AvgPressureBar
	}
	if score != nil {
		out["score"] = float64(*score)
	}
	if r, ok := ratingOf(shot); ok {
		out["rating"] = float64(r)
	}
	return out
}

func toCompareShot(shot shots.Shot, score *int) compareShot {
	out := compareShot{
		ID:           intField(shot, "id"),
		ProfileName:  profileNameOf(shot),
		Bean:         annotationString(shot, "coffee"),
		GrindSetting: annotationString(shot, "grindSetting"),
	}
	if score != nil {
		s := *score
		out.Score = &s
	}
	if r, ok := ratingOf(shot); ok {
		out.Rating = &r
	}
	m := shots.ComputeShotMetrics(shot)
	out.DoseInG = optionalFloat(m.HasDose, m.DoseG)
	out.DoseOutG = optionalFloat(m.HasYield, m.YieldG)
	out.Ratio = optionalFloat(m.HasRatio, m.Ratio)
	out.DurationS = optionalFloat(m.DurationSecs > 0, m.DurationSecs)
	return out
}

func toShotSummary(shot shots.Shot, score *int) shotSummary {
	out := shotSummary{
		ID:           intField(shot, "id"),
		Timestamp:    formatTimestamp(shot),
		MachineID:    machineIDOf(shot),
		ProfileName:  profileNameOf(shot),
		Bean:         annotationString(shot, "coffee"),
		GrindSetting: annotationString(shot, "grindSetting"),
	}
	out.Notes = truncate(annotationString(shot, "notes"), 200)
	if score != nil {
		s := *score
		out.Score = &s
	}
	if r, ok := ratingOf(shot); ok {
		out.Rating = &r
	}
	m := shots.ComputeShotMetrics(shot)
	out.DoseInG = optionalFloat(m.HasDose, m.DoseG)
	out.DoseOutG = optionalFloat(m.HasYield, m.YieldG)
	out.Ratio = optionalFloat(m.HasRatio, m.Ratio)
	out.DurationS = optionalFloat(m.DurationSecs > 0, m.DurationSecs)
	return out
}

func buildMetrics(shot shots.Shot) *shotMetrics {
	m := shots.ComputeShotMetrics(shot)
	out := &shotMetrics{
		DurationS:  m.DurationSecs,
		Channeling: m.Channeling,
	}
	out.DoseInG = optionalFloat(m.HasDose, m.DoseG)
	out.YieldG = optionalFloat(m.HasYield, m.YieldG)
	out.Ratio = optionalFloat(m.HasRatio, m.Ratio)
	out.ExtractionYieldPct = optionalFloat(m.HasEY, m.EY)
	if m.HasPhases {
		out.PreinfusionS = optionalFloat(true, m.PreinfusionSecs)
		out.ExtractionS = optionalFloat(true, m.ExtractionSecs)
	}
	out.AvgPressureBar = optionalFloat(m.HasAvgPressure, m.AvgPressureBar)
	return out
}

func buildCurve(shot shots.Shot, points int) *shotCurve {
	d := shots.DatapointsMap(shot)
	series := []curveSeries{}
	add := func(name, unit string, raw []float64) {
		if len(raw) == 0 {
			return
		}
		series = append(series, curveSeries{Name: name, Unit: unit, Values: downsample(scaleTenths(raw), points)})
	}
	add("pressure", "bar", toFloats(d["pressure"]))
	add("flow", "ml/s", toFloats(d["pumpFlow"]))
	weight := toFloats(d["shotWeight"])
	if len(weight) == 0 {
		weight = toFloats(d["weight"])
	}
	add("weight", "g", weight)
	add("temperature", "C", toFloats(d["temperature"]))
	add("target_pressure", "bar", toFloats(d["targetPressure"]))
	add("target_flow", "ml/s", toFloats(d["targetPumpFlow"]))
	add("target_temperature", "C", toFloats(d["targetTemperature"]))
	return &shotCurve{
		Points: points,
		TimeS:  downsample(scaleTenths(toFloats(d["timeInShot"])), points),
		Series: series,
	}
}

func matchesFilters(shot shots.Shot, bean string, minRating int, lo, hi int64) bool {
	if lo > 0 || hi > 0 {
		ts, _ := shot["timestamp"].(int64)
		if lo > 0 && ts < lo {
			return false
		}
		if hi > 0 && ts >= hi {
			return false
		}
	}
	if minRating > 0 {
		r, ok := ratingOf(shot)
		if !ok || r < minRating {
			return false
		}
	}
	if bean != "" && !strings.Contains(strings.ToLower(annotationString(shot, "coffee")), bean) {
		return false
	}
	return true
}

func parseRange(since, until string) (int64, int64, error) {
	var lo, hi int64
	if since != "" {
		t, err := time.Parse(time.RFC3339, since)
		if err != nil {
			return 0, 0, fmt.Errorf("invalid since %q: expected an RFC 3339 date-time such as 2026-01-31T00:00:00Z", since)
		}
		lo = t.Unix()
	}
	if until != "" {
		t, err := time.Parse(time.RFC3339, until)
		if err != nil {
			return 0, 0, fmt.Errorf("invalid until %q: expected an RFC 3339 date-time such as 2026-01-31T00:00:00Z", until)
		}
		hi = t.Unix()
	}
	return lo, hi, nil
}

func cursorOf(row shots.PageRow) shots.Cursor {
	ts, _ := row.Shot["timestamp"].(int64)
	return shots.Cursor{Timestamp: ts, ID: intField(row.Shot, "id"), Set: true}
}

func formatTimestamp(shot shots.Shot) string {
	ts, _ := shot["timestamp"].(int64)
	if ts <= 0 {
		return ""
	}
	return time.Unix(ts, 0).UTC().Format(time.RFC3339)
}

func machineIDOf(shot shots.Shot) int64 {
	if v, ok := shot["machineId"].(int64); ok {
		return v
	}
	return 1
}

func profileNameOf(shot shots.Shot) string {
	if v, ok := shot["profileName"].(string); ok {
		return v
	}
	return ""
}

func intField(shot shots.Shot, key string) int64 {
	v, _ := shot[key].(int64)
	return v
}

func annotationMap(shot shots.Shot) map[string]any {
	m, _ := shot["annotation"].(map[string]any)
	return m
}

func annotationString(shot shots.Shot, key string) string {
	v, _ := annotationMap(shot)[key].(string)
	return v
}

func ratingOf(shot shots.Shot) (int, bool) {
	switch v := annotationMap(shot)["rating"].(type) {
	case float64:
		// NaN fails both comparisons, so it is rejected as well; bounding the
		// value first keeps the int conversion safe (and CodeQL happy).
		if !(v >= 1 && v <= 5) {
			return 0, false
		}
		return int(v), true
	case int64:
		if v < 1 || v > 5 {
			return 0, false
		}
		return int(v), true
	default:
		return 0, false
	}
}

func optionalFloat(ok bool, v float64) *float64 {
	if !ok {
		return nil
	}
	out := v
	return &out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Cut on a rune boundary so a multi-byte character (umlaut, accent) is
	// never split into invalid UTF-8.
	i := n
	for i > 0 && !utf8.RuneStart(s[i]) {
		i--
	}
	return s[:i] + "..."
}

func toFloats(v any) []float64 {
	switch t := v.(type) {
	case []any:
		out := make([]float64, 0, len(t))
		for _, x := range t {
			if f, ok := x.(float64); ok {
				out = append(out, f)
			}
		}
		return out
	case []float64:
		return t
	default:
		return nil
	}
}

// scaleTenths converts GLP's stored series (tenths of a unit) to whole
// units — every chart series uses this same /10 convention.
func scaleTenths(values []float64) []float64 {
	out := make([]float64, len(values))
	for i, v := range values {
		out[i] = v / 10
	}
	return out
}

// downsample returns exactly `points` evenly spaced samples when the series
// has at least that many (fewer otherwise), so a curve never balloons the
// payload.
func downsample(values []float64, points int) []float64 {
	n := len(values)
	if n == 0 || points <= 0 {
		return []float64{}
	}
	if points >= n {
		out := make([]float64, n)
		copy(out, values)
		return out
	}
	if points == 1 {
		return []float64{values[0]}
	}
	out := make([]float64, points)
	for i := 0; i < points; i++ {
		idx := int(math.Round(float64(i) * float64(n-1) / float64(points-1)))
		if idx < 0 {
			idx = 0
		}
		if idx >= n {
			idx = n - 1
		}
		out[i] = values[idx]
	}
	return out
}
