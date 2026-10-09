package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfstats"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/system"
)

// The developer tools are a third, opt-in slice (the stored
// allowDeveloperTools setting, effective only on a dev build): read-only
// analysis exposing full-resolution or bulk data a model should not get by
// default. get_shot_raw returns one shot's every recorded series without
// downsampling.
const maxRawSamples = 3000

type getShotRawInput struct {
	ID int64 `json:"id" jsonschema:"the shot id to fetch in full resolution; use list_shots to find ids"`
}

type rawSeries struct {
	Key    string    `json:"key" jsonschema:"the Gaggiuino datapoints key, verbatim"`
	Unit   string    `json:"unit" jsonschema:"the value's unit: bar, ml/s, g/s, g, C, ml, or empty when unknown"`
	Values []float64 `json:"values" jsonschema:"full-resolution samples, aligned with time_s and in whole units"`
}

type getShotRawOutput struct {
	ShotID      int64       `json:"shot_id" jsonschema:"the shot's stable id"`
	SampleCount int         `json:"sample_count" jsonschema:"number of samples in time_s and each series"`
	TimeS       []float64   `json:"time_s" jsonschema:"full-resolution time axis, seconds"`
	Series      []rawSeries `json:"series" jsonschema:"every recorded datapoint series, sorted by key"`
	Truncated   bool        `json:"truncated" jsonschema:"true when the shot exceeded 3000 samples and the arrays were cut"`
}

// rawUnits maps the known Gaggiuino datapoint keys to their unit. Anything
// else (a firmware key this slice does not know) gets an empty unit rather
// than a guess.
var rawUnits = map[string]string{
	"pressure":          "bar",
	"targetPressure":    "bar",
	"pumpFlow":          "ml/s",
	"targetPumpFlow":    "ml/s",
	"weightFlow":        "g/s",
	"shotWeight":        "g",
	"weight":            "g",
	"temperature":       "C",
	"targetTemperature": "C",
	"waterPumped":       "ml",
}

func registerDeveloperTools(srv *mcpsdk.Server, deps Deps) {
	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:         "get_shot_raw",
		Title:        "Get raw shot data",
		Description:  "Fetch one shot's full-resolution brew data: every recorded Gaggiuino datapoint series (pressure, flow, weight, temperature, targets, ...) without downsampling, for debugging and scoring analysis. The payload is large — prefer get_shot with include_curve for normal questions.",
		Annotations:  readOnlyAnnotations("Get raw shot data"),
		InputSchema:  getShotRawInputSchema(),
		OutputSchema: mustSchema[getShotRawOutput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in getShotRawInput) (*mcpsdk.CallToolResult, getShotRawOutput, error) {
		out, err := getShotRaw(deps.Shots, in)
		return nil, out, err
	})

	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:         "explain_score",
		Title:        "Explain shot score",
		Description:  "Break one shot's GLP score (0-100) into its weighted parts with the measured inputs and the targets used, and list the parts that were skipped and why. Use it to understand or debug a score.",
		Annotations:  readOnlyAnnotations("Explain shot score"),
		InputSchema:  explainScoreInputSchema(),
		OutputSchema: mustSchema[explainScoreOutput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in explainScoreInput) (*mcpsdk.CallToolResult, explainScoreOutput, error) {
		out, err := explainScore(deps.Shots, in)
		return nil, out, err
	})

	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:         "export_shots_dataset",
		Title:        "Export shots dataset",
		Description:  "Export a filtered batch of shots as one flat dataset: per shot its derived metrics, GLP score, used-bean-target flag and the user's own annotation (bean, rating, grind setting, TDS, notes), with no brew curves. Use it to compare a scoring idea against the user's ratings. Page with cursor/limit.",
		Annotations:  readOnlyAnnotations("Export shots dataset"),
		InputSchema:  exportShotsDatasetSchema(),
		OutputSchema: mustSchema[exportShotsDatasetOutput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in exportShotsDatasetInput) (*mcpsdk.CallToolResult, exportShotsDatasetOutput, error) {
		out, err := exportShotsDataset(deps.Shots, in)
		return nil, out, err
	})

	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:         "get_diagnostics",
		Title:        "Get diagnostics",
		Description:  "Return the app's own recent log output since start (at most 500 lines are kept in memory) plus its sync and machine-reachability state, for bug triage. Optionally filter the log to lines containing a case-insensitive substring. Obvious secrets in the lines are masked. Read-only.",
		Annotations:  readOnlyAnnotations("Get diagnostics"),
		InputSchema:  getDiagnosticsSchema(),
		OutputSchema: mustSchema[getDiagnosticsOutput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in getDiagnosticsInput) (*mcpsdk.CallToolResult, getDiagnosticsOutput, error) {
		out, err := getDiagnostics(deps, in)
		return nil, out, err
	})

	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:         "get_preheat_history",
		Title:        "Get preheat history",
		Description:  "Return the past preheat runs of the default machine: when it was switched on, the configured preheat window, when GLP predicted it ready versus when the temperature actually stabilised, the ready-by targets, and optionally the warm-up temperature curve, to analyse and tune the preheat and ready-by logic. At most the last 30 runs are kept.",
		Annotations:  readOnlyAnnotations("Get preheat history"),
		InputSchema:  getPreheatHistorySchema(),
		OutputSchema: mustSchema[getPreheatHistoryOutput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, in getPreheatHistoryInput) (*mcpsdk.CallToolResult, getPreheatHistoryOutput, error) {
		out, err := getPreheatHistory(deps, in)
		return nil, out, err
	})

	mcpsdk.AddTool(srv, &mcpsdk.Tool{
		Name:         "get_perf_stats",
		Title:        "Get performance stats",
		Description:  "Report the running install's own performance counters, held only in memory since process start: API request count, median, p95 and max per route pattern over all requests and over the last 15 minutes; process memory, goroutine count, uptime and GC pause p95; the database size and shot count; and outbound machine traffic per machine id, requests and WebSocket messages per minute split by idle and brewing plus the error count, resolved to machine ids so no host is ever returned. Read-only.",
		Annotations:  readOnlyAnnotations("Get performance stats"),
		InputSchema:  mustSchema[getPerfStatsInput](),
		OutputSchema: mustSchema[getPerfStatsOutput](),
	}, func(_ context.Context, _ *mcpsdk.CallToolRequest, _ getPerfStatsInput) (*mcpsdk.CallToolResult, getPerfStatsOutput, error) {
		out, err := getPerfStats(deps)
		return nil, out, err
	})
}

// get_diagnostics bounds: the log window and the substring filter length.
const (
	defaultDiagnosticLines = 100
	maxDiagnosticLines     = 500
	maxDiagnosticContains  = 100
)

type getDiagnosticsInput struct {
	Lines    int    `json:"lines,omitempty" jsonschema:"how many of the most recent log lines to return, 1..500 (default 100)"`
	Contains string `json:"contains,omitempty" jsonschema:"only return log lines containing this case-insensitive substring (longer values are truncated to 100 characters)"`
}

type getDiagnosticsOutput struct {
	LogLines               []string `json:"log_lines" jsonschema:"the app's recent log lines, oldest first, secrets masked"`
	LastSync               string   `json:"last_sync,omitempty" jsonschema:"RFC 3339 time of the last shot-history sync, when one has run"`
	LastSyncError          string   `json:"last_sync_error,omitempty" jsonschema:"the last sync error, when the last sync failed"`
	PolledMachineReachable *bool    `json:"polled_machine_reachable,omitempty" jsonschema:"whether the last poll reached the default machine"`
	LastMachineError       string   `json:"last_machine_error,omitempty" jsonschema:"the last polling error, when the default machine was unreachable"`
}

func getDiagnosticsSchema() *jsonschema.Schema {
	s := mustSchema[getDiagnosticsInput]()
	if p := schemaProp(s, "lines"); p != nil {
		p.Minimum = jsonschema.Ptr(1.0)
		p.Maximum = jsonschema.Ptr(float64(maxDiagnosticLines))
		p.Default = json.RawMessage(strconv.Itoa(defaultDiagnosticLines))
	}
	if p := schemaProp(s, "contains"); p != nil {
		p.MaxLength = jsonschema.Ptr(maxDiagnosticContains)
	}
	return s
}

func getDiagnostics(deps Deps, in getDiagnosticsInput) (getDiagnosticsOutput, error) {
	out := getDiagnosticsOutput{LogLines: recentLogLines(deps.Logs, in)}
	if deps.Sync != nil {
		st := deps.Sync.SyncState()
		if st.LastSync != nil {
			out.LastSync = *st.LastSync
		}
		if st.LastSyncError != nil {
			out.LastSyncError = *st.LastSyncError
		}
	}
	if deps.Poller != nil {
		info := deps.Poller.StatusInfo()
		out.PolledMachineReachable = info.MachineReachable
		if info.LastMachineError != nil {
			out.LastMachineError = *info.LastMachineError
		}
	}
	return out, nil
}

// recentLogLines returns up to in.Lines of the buffer's most recent lines,
// oldest first, filtered by in.Contains and with secrets masked. It reads the
// whole kept buffer before applying the limit so a filter matches older lines
// too, and returns an empty (never nil) slice so JSON gets [] rather than null.
func recentLogLines(src LogSource, in getDiagnosticsInput) []string {
	out := []string{}
	if src == nil {
		return out
	}
	n := in.Lines
	if n <= 0 {
		n = defaultDiagnosticLines
	}
	if n > maxDiagnosticLines {
		n = maxDiagnosticLines
	}
	contains := in.Contains
	if len(contains) > maxDiagnosticContains {
		contains = contains[:maxDiagnosticContains]
	}
	lines := src.Lines(maxDiagnosticLines)
	if contains != "" {
		needle := strings.ToLower(contains)
		filtered := make([]string, 0, len(lines))
		for _, line := range lines {
			if strings.Contains(strings.ToLower(line), needle) {
				filtered = append(filtered, line)
			}
		}
		lines = filtered
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	for _, line := range lines {
		out = append(out, maskSecrets(line))
	}
	return out
}

// The two shapes of credential the app might log: an X-GLP-Token header or
// token= query value, a Bearer token, or user:pass credentials in a URL. The
// URL pattern requires a trailing "@" so a bare host:port is left alone.
var (
	secretTokenPattern = regexp.MustCompile(`(?i)(X-GLP-Token\s*[:=]\s*|token=|Bearer\s+)([^/\s@&]+)`)
	secretURLPattern   = regexp.MustCompile(`(://[^/\s:@]+:)([^/\s@]+)(@)`)
)

func maskSecrets(line string) string {
	line = secretTokenPattern.ReplaceAllString(line, "${1}***")
	return secretURLPattern.ReplaceAllString(line, "${1}***${3}")
}

type explainScoreInput struct {
	ID int64 `json:"id" jsonschema:"the shot id to explain; use list_shots to find ids"`
}

type scoreComponentOutput struct {
	Name        string             `json:"name" jsonschema:"the weighted part: pressure, temperature, duration, ratio, extraction_yield or channeling"`
	Score       int                `json:"score" jsonschema:"this part's 0-100 score"`
	Weight      int                `json:"weight" jsonschema:"the part's weight in the total"`
	WeightShare float64            `json:"weight_share" jsonschema:"the part's weight divided by the total weight, 0..1"`
	Target      string             `json:"target" jsonschema:"which target band was used: profile, bean or generic"`
	Inputs      map[string]float64 `json:"inputs" jsonschema:"the measured values and targets this part was scored on"`
}

type skippedScoreComponent struct {
	Name   string `json:"name" jsonschema:"the part that could not be scored"`
	Reason string `json:"reason" jsonschema:"why the part was skipped"`
}

type explainScoreOutput struct {
	ShotID         int64                   `json:"shot_id" jsonschema:"the shot's stable id"`
	Score          *int                    `json:"score,omitempty" jsonschema:"the overall 0-100 score; omitted when there is too little data to score"`
	UsedBeanTarget bool                    `json:"used_bean_target" jsonschema:"true when the score used a bean-specific target"`
	Components     []scoreComponentOutput  `json:"components" jsonschema:"the weighted parts, in scoring order"`
	Skipped        []skippedScoreComponent `json:"skipped" jsonschema:"parts that could not be scored, with the reason"`
}

// skippedScoreParts are the optional parts, in scoring order, with the fixed
// reason each reports when it is absent. pressure and channeling always score
// once the shot clears the pressure-samples guard, so they are never listed.
var skippedScoreParts = []skippedScoreComponent{
	{Name: "temperature", Reason: "fewer than 6 temperature samples"},
	{Name: "duration", Reason: "shot shorter than 5 s"},
	{Name: "ratio", Reason: "no dose annotated or no weight recorded"},
	{Name: "extraction_yield", Reason: "no TDS annotated (needs dose and weight too)"},
}

func explainScoreInputSchema() *jsonschema.Schema {
	s := mustSchema[explainScoreInput]()
	if p := schemaProp(s, "id"); p != nil {
		p.Minimum = jsonschema.Ptr(1.0)
	}
	return s
}

func explainScore(svc *shots.Service, in explainScoreInput) (explainScoreOutput, error) {
	out := explainScoreOutput{
		ShotID:     in.ID,
		Components: []scoreComponentOutput{},
		Skipped:    []skippedScoreComponent{},
	}
	if svc == nil {
		return explainScoreOutput{}, fmt.Errorf("shot history is not available")
	}
	shot, err := svc.GetByID(in.ID)
	if err != nil {
		log.Printf("mcp: explain_score %d: %v", in.ID, err)
		return explainScoreOutput{}, fmt.Errorf("could not read shot %d; try again", in.ID)
	}
	if shot == nil {
		return explainScoreOutput{}, fmt.Errorf("shot %d not found; use list_shots to find ids", in.ID)
	}

	detail := svc.ComputeScoreDetail(shot)
	out.Score = detail.Score
	out.UsedBeanTarget = detail.UsedBeanTarget
	if detail.Score == nil {
		out.Skipped = append(out.Skipped, skippedScoreComponent{
			Name:   "all",
			Reason: "fewer than 4 pressure samples at or above 5 bar",
		})
		return out, nil
	}

	present := make(map[string]bool, len(detail.Components))
	totalWeight := 0
	for _, c := range detail.Components {
		present[c.Name] = true
		totalWeight += c.Weight
	}
	for _, c := range detail.Components {
		var share float64
		if totalWeight > 0 {
			share = float64(c.Weight) / float64(totalWeight)
		}
		out.Components = append(out.Components, scoreComponentOutput{
			Name:        c.Name,
			Score:       c.Score,
			Weight:      c.Weight,
			WeightShare: share,
			Target:      c.Target,
			Inputs:      c.Inputs,
		})
	}
	for _, part := range skippedScoreParts {
		if !present[part.Name] {
			out.Skipped = append(out.Skipped, part)
		}
	}
	return out, nil
}

func getShotRawInputSchema() *jsonschema.Schema {
	s := mustSchema[getShotRawInput]()
	if p := schemaProp(s, "id"); p != nil {
		p.Minimum = jsonschema.Ptr(1.0)
	}
	return s
}

func getShotRaw(svc *shots.Service, in getShotRawInput) (getShotRawOutput, error) {
	if svc == nil {
		return getShotRawOutput{}, fmt.Errorf("shot history is not available")
	}
	shot, err := svc.GetByID(in.ID)
	if err != nil {
		log.Printf("mcp: get_shot_raw %d: %v", in.ID, err)
		return getShotRawOutput{}, fmt.Errorf("could not read shot %d; try again", in.ID)
	}
	if shot == nil {
		return getShotRawOutput{}, fmt.Errorf("shot %d not found; use list_shots to find ids", in.ID)
	}
	d := shots.DatapointsMap(shot)
	timeS := scaleTenths(toFloats(d["timeInShot"]))
	if len(timeS) == 0 {
		return getShotRawOutput{}, fmt.Errorf("shot %d has no recorded brew data", in.ID)
	}

	// Every other key with a non-empty numeric array is a series; timeInShot
	// above is the shared time axis.
	keys := make([]string, 0, len(d))
	for k, v := range d {
		if k == "timeInShot" || len(toFloats(v)) == 0 {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	series := make([]rawSeries, 0, len(keys))
	for _, k := range keys {
		series = append(series, rawSeries{Key: k, Unit: rawUnits[k], Values: scaleTenths(toFloats(d[k]))})
	}

	truncated := len(timeS) > maxRawSamples
	if truncated {
		timeS = timeS[:maxRawSamples]
	}
	for i := range series {
		if len(series[i].Values) > maxRawSamples {
			series[i].Values = series[i].Values[:maxRawSamples]
		}
	}
	return getShotRawOutput{
		ShotID:      intField(shot, "id"),
		SampleCount: len(timeS),
		TimeS:       timeS,
		Series:      series,
		Truncated:   truncated,
	}, nil
}

// export_shots_dataset bounds: a batch large enough to analyse in one go, but
// capped so a single response stays manageable, plus the notes cap that keeps
// one long annotation from dominating the dataset.
const (
	defaultDatasetLimit = 100
	maxDatasetLimit     = 500
	maxDatasetNotes     = 2000
)

type exportShotsDatasetInput struct {
	Bean      string `json:"bean,omitempty" jsonschema:"case-insensitive substring of the shot's bean (coffee) name annotation"`
	MachineID int64  `json:"machine_id,omitempty" jsonschema:"only shots pulled on this machine id; omit or 0 for all machines"`
	MinRating int    `json:"min_rating,omitempty" jsonschema:"only shots whose 1-5 star rating is at least this value"`
	Since     string `json:"since,omitempty" jsonschema:"only shots at or after this date-time, RFC 3339 e.g. 2026-01-31T00:00:00Z"`
	Until     string `json:"until,omitempty" jsonschema:"only shots strictly before this date-time, RFC 3339"`
	Cursor    string `json:"cursor,omitempty" jsonschema:"opaque paging cursor from a previous export_shots_dataset response's next_cursor; omit for the first page"`
	Limit     int    `json:"limit,omitempty" jsonschema:"maximum rows to return, 1..500 (default 100)"`
}

// datasetRow is one flat row of the exported dataset: the identifying fields,
// the score and the user's annotation, plus the same shotMetrics buildMetrics
// derives for get_shot (embedded, so those fields sit at the top level rather
// than in a nested object). No curve data.
type datasetRow struct {
	ID             int64    `json:"id" jsonschema:"the shot's stable id"`
	Timestamp      string   `json:"timestamp" jsonschema:"shot start time, RFC 3339 UTC"`
	MachineID      int64    `json:"machine_id" jsonschema:"machine that pulled the shot"`
	ProfileName    string   `json:"profile_name,omitempty" jsonschema:"brewing profile name"`
	Bean           string   `json:"bean,omitempty" jsonschema:"bean (coffee) name annotation"`
	Score          *int     `json:"score,omitempty" jsonschema:"GLP score 0-100; omitted when there is too little data to score"`
	UsedBeanTarget bool     `json:"used_bean_target" jsonschema:"whether the score used a bean-specific target"`
	Rating         *int     `json:"rating,omitempty" jsonschema:"the user's 1-5 star rating"`
	GrindSetting   string   `json:"grind_setting,omitempty" jsonschema:"free-text grinder setting"`
	TDSPct         *float64 `json:"tds_pct,omitempty" jsonschema:"TDS annotation, percent"`
	Notes          string   `json:"notes,omitempty" jsonschema:"the user's full notes, truncated to 2000 characters"`
	shotMetrics
}

type exportShotsDatasetOutput struct {
	Shots      []datasetRow `json:"shots" jsonschema:"one batch of shots as flat rows, newest first"`
	NextCursor string       `json:"next_cursor,omitempty" jsonschema:"pass back as cursor to fetch the next page; empty when there are no more"`
	Count      int          `json:"count" jsonschema:"number of rows in shots"`
}

func exportShotsDatasetSchema() *jsonschema.Schema {
	s := mustSchema[exportShotsDatasetInput]()
	if p := schemaProp(s, "limit"); p != nil {
		p.Minimum = jsonschema.Ptr(1.0)
		p.Maximum = jsonschema.Ptr(float64(maxDatasetLimit))
		p.Default = json.RawMessage(strconv.Itoa(defaultDatasetLimit))
	}
	if p := schemaProp(s, "min_rating"); p != nil {
		p.Minimum = jsonschema.Ptr(1.0)
		p.Maximum = jsonschema.Ptr(5.0)
	}
	return s
}

func exportShotsDataset(svc *shots.Service, in exportShotsDatasetInput) (exportShotsDatasetOutput, error) {
	if svc == nil {
		return exportShotsDatasetOutput{}, fmt.Errorf("shot history is not available")
	}
	limit := in.Limit
	if limit <= 0 {
		limit = defaultDatasetLimit
	}
	filters, err := buildShotFilters(in.Bean, in.MachineID, in.MinRating, in.Since, in.Until, in.Cursor)
	if err != nil {
		return exportShotsDatasetOutput{}, err
	}
	out := exportShotsDatasetOutput{Shots: []datasetRow{}}
	nextCur, err := scanShots(svc, filters, limit, func(row shots.PageRow) {
		out.Shots = append(out.Shots, toDatasetRow(row))
	})
	if err != nil {
		return exportShotsDatasetOutput{}, err
	}
	out.Count = len(out.Shots)
	if nextCur.Set {
		out.NextCursor = shots.EncodeCursor(nextCur)
	}
	return out, nil
}

// toDatasetRow flattens one page row into a dataset row. The score and the
// bean-target flag come straight from the row — the paginated score already
// resolved the bean target once per page, so there is no per-shot re-scoring —
// and the metrics reuse buildMetrics so the numbers match get_shot's.
func toDatasetRow(row shots.PageRow) datasetRow {
	shot := row.Shot
	out := datasetRow{
		ID:             intField(shot, "id"),
		Timestamp:      formatTimestamp(shot),
		MachineID:      machineIDOf(shot),
		ProfileName:    profileNameOf(shot),
		Bean:           annotationString(shot, "coffee"),
		UsedBeanTarget: row.UsedBeanTarget,
		GrindSetting:   annotationString(shot, "grindSetting"),
		Notes:          truncate(annotationString(shot, "notes"), maxDatasetNotes),
		shotMetrics:    *buildMetrics(shot),
	}
	if row.Score != nil {
		s := *row.Score
		out.Score = &s
	}
	if r, ok := ratingOf(shot); ok {
		out.Rating = &r
	}
	out.TDSPct = annotationFloat(shot, "tds")
	return out
}

// annotationFloat reads a numeric annotation value or reports it absent. TDS
// is stored as a JSON number (float64 after unmarshal), but an integer is
// accepted too.
func annotationFloat(shot shots.Shot, key string) *float64 {
	switch v := annotationMap(shot)[key].(type) {
	case float64:
		out := v
		return &out
	case int64:
		out := float64(v)
		return &out
	default:
		return nil
	}
}

// get_preheat_history bounds: how many of the retained runs one call returns.
// The store itself keeps the newest preheatHistoryMaxRuns (30).
const (
	defaultPreheatLimit = 10
	maxPreheatLimit     = 30
)

type getPreheatHistoryInput struct {
	Limit          int  `json:"limit,omitempty" jsonschema:"how many of the most recent runs to return, 1..30 (default 10)"`
	IncludeSamples bool `json:"include_samples,omitempty" jsonschema:"include each run's warm-up temperature curve (t_s, temp_c, target_c); off by default because it is bulky"`
}

type preheatSampleOutput struct {
	TimeS   float64 `json:"t_s" jsonschema:"seconds since the run's switch-on"`
	TempC   float64 `json:"temp_c" jsonschema:"the measured temperature in Celsius"`
	TargetC float64 `json:"target_c" jsonschema:"the target temperature in Celsius"`
}

// preheatRunOutput is one recorded preheat run with its millisecond timeline
// resolved to RFC 3339 UTC and the derived comparisons the preheat/ready-by
// tuning needs.
type preheatRunOutput struct {
	SwitchOnAt           string                `json:"switch_on_at" jsonschema:"when the machine was switched on, RFC 3339 UTC"`
	SwitchOffAt          string                `json:"switch_off_at,omitempty" jsonschema:"when the machine was switched off, RFC 3339 UTC; omitted while the run is in progress"`
	InProgress           bool                  `json:"in_progress" jsonschema:"true when the run is still open (no switch-off recorded yet)"`
	PreheatMinutes       int                   `json:"preheat_minutes" jsonschema:"the configured preheat window, minutes"`
	PredictedReadyAt     string                `json:"predicted_ready_at" jsonschema:"when the preheat window predicted the machine ready, RFC 3339 UTC"`
	StableAt             string                `json:"stable_at,omitempty" jsonschema:"when the temperature actually stabilised, RFC 3339 UTC; omitted if it never did"`
	ReadyAt              string                `json:"ready_at" jsonschema:"the earlier of stable_at and predicted_ready_at, RFC 3339 UTC"`
	StableVsPredictedMin *float64              `json:"stable_vs_predicted_min,omitempty" jsonschema:"stable_at minus predicted_ready_at in minutes; negative means it stabilised earlier; omitted without a stable time"`
	ReadyByTargetAt      string                `json:"ready_by_target_at,omitempty" jsonschema:"the ready-by target time, RFC 3339 UTC; omitted unless the run was started for a ready-by target"`
	PlannedSwitchOnAt    string                `json:"planned_switch_on_at,omitempty" jsonschema:"the switch-on time planned to hit the ready-by target, RFC 3339 UTC; omitted unless the run was started for a ready-by target"`
	ReadyBeforeTargetMin *float64              `json:"ready_before_target_min,omitempty" jsonschema:"ready_by_target_at minus ready_at in minutes; positive means it was ready before the target; omitted for non-ready-by runs"`
	SampleCount          int                   `json:"sample_count" jsonschema:"number of warm-up temperature samples stored for the run"`
	Samples              []preheatSampleOutput `json:"samples,omitempty" jsonschema:"the warm-up temperature curve, oldest first; only present when include_samples is set"`
}

type getPreheatHistoryOutput struct {
	Runs []preheatRunOutput `json:"runs" jsonschema:"the recorded preheat runs, newest first; the in-progress run, if any, is first"`
}

func getPreheatHistorySchema() *jsonschema.Schema {
	s := mustSchema[getPreheatHistoryInput]()
	if p := schemaProp(s, "limit"); p != nil {
		p.Minimum = jsonschema.Ptr(1.0)
		p.Maximum = jsonschema.Ptr(float64(maxPreheatLimit))
		p.Default = json.RawMessage(strconv.Itoa(defaultPreheatLimit))
	}
	return s
}

func getPreheatHistory(deps Deps, in getPreheatHistoryInput) (getPreheatHistoryOutput, error) {
	if deps.Preheat == nil {
		return getPreheatHistoryOutput{}, fmt.Errorf("preheat history is not available")
	}
	limit := in.Limit
	if limit <= 0 {
		limit = defaultPreheatLimit
	}
	if limit > maxPreheatLimit {
		limit = maxPreheatLimit
	}
	out := getPreheatHistoryOutput{Runs: []preheatRunOutput{}}
	for _, run := range deps.Preheat.PreheatHistory() {
		if len(out.Runs) >= limit {
			break
		}
		out.Runs = append(out.Runs, toPreheatRunOutput(run, in.IncludeSamples))
	}
	return out, nil
}

// toPreheatRunOutput resolves one run's millisecond timestamps to RFC 3339 and
// derives ready_at (the earlier of the predicted and stable times),
// stable_vs_predicted_min and, for a ready-by run, ready_before_target_min.
func toPreheatRunOutput(run system.PreheatRun, includeSamples bool) preheatRunOutput {
	out := preheatRunOutput{
		SwitchOnAt:       formatMillis(run.SwitchOnAt),
		InProgress:       run.SwitchOffAt == nil,
		PreheatMinutes:   run.PreheatMinutes,
		PredictedReadyAt: formatMillis(run.PredictedReadyAt),
		SampleCount:      len(run.Samples),
	}
	if run.SwitchOffAt != nil {
		out.SwitchOffAt = formatMillis(*run.SwitchOffAt)
	}
	readyAt := run.PredictedReadyAt
	if run.StableAt != nil {
		out.StableAt = formatMillis(*run.StableAt)
		diff := float64(*run.StableAt-run.PredictedReadyAt) / 60000
		out.StableVsPredictedMin = &diff
		if *run.StableAt < readyAt {
			readyAt = *run.StableAt
		}
	}
	out.ReadyAt = formatMillis(readyAt)
	if run.ReadyByTargetAt != nil {
		out.ReadyByTargetAt = formatMillis(*run.ReadyByTargetAt)
		before := float64(*run.ReadyByTargetAt-readyAt) / 60000
		out.ReadyBeforeTargetMin = &before
	}
	if run.PlannedSwitchOnAt != nil {
		out.PlannedSwitchOnAt = formatMillis(*run.PlannedSwitchOnAt)
	}
	if includeSamples {
		out.Samples = make([]preheatSampleOutput, 0, len(run.Samples))
		for _, s := range run.Samples {
			out.Samples = append(out.Samples, preheatSampleOutput{TimeS: s.TS, TempC: s.TempC, TargetC: s.TargetC})
		}
	}
	return out
}

// formatMillis renders an epoch-milliseconds timestamp as RFC 3339 UTC, the
// same format get_machine_status uses for LastMachineSuccess.
func formatMillis(ms int64) string {
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}

// get_perf_stats takes no input: it reports whatever the recorder has seen.
type getPerfStatsInput struct{}

type databaseStats struct {
	SizeBytes int64 `json:"size_bytes" jsonschema:"the SQLite database file's size on disk plus its -wal sidecar when present, bytes"`
	ShotCount int   `json:"shot_count" jsonschema:"number of shots stored, including trashed ones"`
}

type getPerfStatsOutput struct {
	Routes   []perfstats.RouteSnapshot          `json:"routes" jsonschema:"per-route request timings, busiest first"`
	Process  perfstats.ProcessStats             `json:"process" jsonschema:"process resource use since start"`
	Database databaseStats                      `json:"database" jsonschema:"database size and shot count"`
	Machines []perfstats.MachineTrafficSnapshot `json:"machines" jsonschema:"outbound machine traffic per machine id since start, split by idle and brewing; hosts that did not resolve are one aggregate unknown entry, never a hostname"`
}

func getPerfStats(deps Deps) (getPerfStatsOutput, error) {
	if deps.Recorder == nil {
		return getPerfStatsOutput{}, fmt.Errorf("performance stats are not available")
	}
	snap := deps.Recorder.Snapshot(time.Now())
	out := getPerfStatsOutput{
		Routes:   snap.Routes,
		Process:  snap.Process,
		Database: databaseStats{SizeBytes: dbSizeBytes(deps.DBPath)},
		Machines: []perfstats.MachineTrafficSnapshot{},
	}
	if deps.ShotsRepo != nil {
		n, err := deps.ShotsRepo.Count()
		if err != nil {
			return getPerfStatsOutput{}, err
		}
		out.Database.ShotCount = n
	}
	if deps.Machines != nil {
		out.Machines = deps.Machines.Snapshot(time.Now(), machineHostResolver(deps.Registry))
	}
	return out, nil
}

// machineHostResolver maps a traffic-counter host key (a URL host, e.g.
// "192.168.1.50" or "machine.local:8080") to the registry machine id whose
// Host names it. It lists the registry once, so Snapshot's per-host resolve
// calls never touch the database. An unparseable or unknown host maps to
// (0, false) and folds into the aggregate unknown bucket.
func machineHostResolver(registry *machines.Registry) func(host string) (int64, bool) {
	byHost := map[string]int64{}
	byHostname := map[string]int64{}
	if registry != nil {
		if list, err := registry.ListMachines(); err == nil {
			for _, m := range list {
				host, hostname := canonicalMachineHost(m.Host)
				if host != "" {
					byHost[host] = m.ID
				}
				if hostname != "" {
					byHostname[hostname] = m.ID
				}
			}
		}
	}
	return func(host string) (int64, bool) {
		full, hostname := canonicalMachineHost(host)
		if id, ok := byHost[full]; ok {
			return id, true
		}
		if id, ok := byHostname[hostname]; ok {
			return id, true
		}
		return 0, false
	}
}

// canonicalMachineHost normalizes a machine Host or a traffic host key to a
// lowercase host:port and its bare hostname, accepting a bare host as well as
// one with an http(s) scheme. A port in the key wins the exact match; the
// hostname fallback covers a key with a default port and a stored host without
// one.
func canonicalMachineHost(raw string) (host, hostname string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ""
	}
	lower := strings.ToLower(raw)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", ""
	}
	return strings.ToLower(u.Host), strings.ToLower(u.Hostname())
}

// dbSizeBytes totals the SQLite file and its -wal sidecar, skipping whichever
// is not present.
func dbSizeBytes(path string) int64 {
	if path == "" {
		return 0
	}
	var total int64
	for _, p := range []string{path, path + "-wal"} {
		if fi, err := os.Stat(p); err == nil {
			total += fi.Size()
		}
	}
	return total
}
