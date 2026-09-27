package mcp

import (
	"context"
	"database/sql"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/logbuf"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/system"
)

// newDeveloperServer mirrors newWriteServer but also wires the developer-tools
// opt-in, so a test can flip either flag independently.
func newDeveloperServer(t *testing.T, allowDeveloper, allowWrite bool) (*httptest.Server, *sql.DB) {
	return newDeveloperServerFull(t, allowDeveloper, allowWrite, fakePoller{}, nil, nil, nil)
}

// newDeveloperServerFull is newDeveloperServer with the poller, log, sync and
// preheat sources made explicit, so the get_diagnostics and get_preheat_history
// tests can supply a log buffer, a sync fake, a populated machine-status fake
// and a preheat-history fake.
func newDeveloperServerFull(t *testing.T, allowDeveloper, allowWrite bool, poller MachineStatus, logs LogSource, sync SyncSource, preheat PreheatHistorySource) (*httptest.Server, *sql.DB) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	maintRepo := maintenance.NewRepository(sqlDB, libRepo)
	registry := machines.NewRegistry(sqlDB)
	mux := http.NewServeMux()
	mux.Handle(Path, NewHandler(Deps{
		Shots:               shots.NewService(shotsRepo),
		ShotsRepo:           shotsRepo,
		Library:             libRepo,
		Maintenance:         maintRepo,
		Registry:            registry,
		Poller:              poller,
		Logs:                logs,
		Sync:                sync,
		Preheat:             preheat,
		Version:             "test",
		AllowWrite:          allowWrite,
		AllowDeveloperTools: allowDeveloper,
	}))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, sqlDB
}

func rawSeriesByKey(t *testing.T, out map[string]any) map[string]map[string]any {
	t.Helper()
	res := map[string]map[string]any{}
	for _, raw := range objects(out, "series") {
		s, _ := raw.(map[string]any)
		key, _ := s["key"].(string)
		res[key] = s
	}
	return res
}

func floatList(m map[string]any, key string) []float64 {
	raw, _ := m[key].([]any)
	out := make([]float64, 0, len(raw))
	for _, v := range raw {
		f, _ := v.(float64)
		out = append(out, f)
	}
	return out
}

func equalFloats(a, b []float64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestDeveloperToolsHiddenWithoutOptIn(t *testing.T) {
	ts, _ := newDeveloperServer(t, false, false)
	session := connect(t, ts.URL+Path)
	names := toolNames(t, session)
	listed := "," + strings.Join(names, ",") + ","
	for _, name := range []string{"get_shot_raw", "explain_score", "export_shots_dataset", "get_diagnostics", "get_preheat_history"} {
		if strings.Contains(listed, ","+name+",") {
			t.Fatalf("%s is listed without the developer-tools opt-in: %v", name, names)
		}
		// An unregistered tool must not be callable either: the SDK either
		// rejects the call outright or returns a tool error.
		res, err := session.CallTool(context.Background(), &mcpsdk.CallToolParams{Name: name, Arguments: map[string]any{"id": 1}})
		if err == nil && (res == nil || !res.IsError) {
			t.Fatalf("%s is callable without the developer-tools opt-in", name)
		}
	}
}

func TestDeveloperToolsListedWithOptIn(t *testing.T) {
	ts, _ := newDeveloperServer(t, true, false)
	session := connect(t, ts.URL+Path)
	tools := listToolsByName(t, session)
	for _, name := range []string{"get_shot_raw", "explain_score"} {
		tool := tools[name]
		if tool == nil {
			t.Fatalf("%s is missing from tools/list with the opt-in", name)
		}
		a := tool.Annotations
		if a == nil || !a.ReadOnlyHint || !a.IdempotentHint {
			t.Fatalf("%s should be read-only and idempotent", name)
		}
		if a.OpenWorldHint == nil || *a.OpenWorldHint {
			t.Fatalf("%s should be closed-world", name)
		}
		if tool.OutputSchema == nil {
			t.Fatalf("%s has no output schema", name)
		}
		if min, _ := schemaProperty(t, tool.InputSchema, "id")["minimum"].(float64); min != 1 {
			t.Fatalf("%s id minimum = %v, want 1", name, schemaProperty(t, tool.InputSchema, "id")["minimum"])
		}
	}
}

func TestDeveloperToolsKeepWriteTools(t *testing.T) {
	ts, _ := newDeveloperServer(t, true, true)
	session := connect(t, ts.URL+Path)
	// The SDK lists tools sorted by name, so the write tools interleave rather
	// than trail; the invariant is that adding the developer tool leaves every
	// read and write tool registered.
	names := toolNames(t, session)
	want := "annotate_shot,compare_shots,explain_score,export_shots_dataset,get_analytics_summary,get_diagnostics,get_library,get_machine_status,get_maintenance_status,get_preheat_history,get_shot,get_shot_raw,list_beans,list_shots,mark_maintenance_done,set_known_grind"
	if got := strings.Join(names, ","); got != want {
		t.Fatalf("tool list = %v, want %v", names, want)
	}
}

func TestGetShotRawFullResolution(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 31, 1000, map[string]any{"datapoints": map[string]any{
		"timeInShot": []any{0.0, 40.0, 80.0},
		"pressure":   []any{90.0, 91.0, 92.0},
		"weightFlow": []any{4.0, 5.0, 6.0},
		"mystery":    []any{11.0, 12.0, 13.0},
	}}, map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "get_shot_raw", map[string]any{"id": 31}))

	if got := numberField(t, out, "shot_id"); got != 31 {
		t.Fatalf("shot_id = %v, want 31", got)
	}
	if got := numberField(t, out, "sample_count"); got != 3 {
		t.Fatalf("sample_count = %v, want 3", got)
	}
	if b, _ := out["truncated"].(bool); b {
		t.Fatalf("truncated = true for a three-sample shot")
	}
	if got := floatList(out, "time_s"); !equalFloats(got, []float64{0, 4, 8}) {
		t.Fatalf("time_s = %v, want [0 4 8] (tenths scaled)", got)
	}

	series := rawSeriesByKey(t, out)
	if len(series) != 3 {
		t.Fatalf("series count = %d, want 3", len(series))
	}
	keys := make([]string, 0, len(series))
	for _, raw := range objects(out, "series") {
		s, _ := raw.(map[string]any)
		key, _ := s["key"].(string)
		keys = append(keys, key)
	}
	if got := strings.Join(keys, ","); got != "mystery,pressure,weightFlow" {
		t.Fatalf("series keys = %v, want them sorted", keys)
	}
	if got := series["pressure"]["unit"]; got != "bar" {
		t.Fatalf("pressure unit = %v, want bar", got)
	}
	if got := series["weightFlow"]["unit"]; got != "g/s" {
		t.Fatalf("weightFlow unit = %v, want g/s", got)
	}
	if got := series["mystery"]["unit"]; got != "" {
		t.Fatalf("unknown key unit = %v, want empty", got)
	}
	if got := floatList(series["pressure"], "values"); !equalFloats(got, []float64{9, 9.1, 9.2}) {
		t.Fatalf("pressure values = %v, want [9 9.1 9.2] (tenths scaled)", got)
	}
	if got := floatList(series["mystery"], "values"); !equalFloats(got, []float64{1.1, 1.2, 1.3}) {
		t.Fatalf("unknown-key values = %v, want [1.1 1.2 1.3] (tenths scaled)", got)
	}
}

func TestGetShotRawTruncates(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	n := maxRawSamples + 1
	times := make([]any, 0, n)
	pressure := make([]any, 0, n)
	for i := 0; i < n; i++ {
		times = append(times, float64(i))
		pressure = append(pressure, float64(90))
	}
	insertShot(t, sqlDB, 32, 1000, map[string]any{"datapoints": map[string]any{
		"timeInShot": times,
		"pressure":   pressure,
	}}, map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "get_shot_raw", map[string]any{"id": 32}))

	if got := numberField(t, out, "sample_count"); got != float64(maxRawSamples) {
		t.Fatalf("sample_count = %v, want %d", got, maxRawSamples)
	}
	if b, _ := out["truncated"].(bool); !b {
		t.Fatalf("truncated = false for an over-limit shot")
	}
	if got := len(floatList(out, "time_s")); got != maxRawSamples {
		t.Fatalf("time_s samples = %d, want %d", got, maxRawSamples)
	}
	series := rawSeriesByKey(t, out)
	if got := len(floatList(series["pressure"], "values")); got != maxRawSamples {
		t.Fatalf("pressure samples = %d, want %d", got, maxRawSamples)
	}
}

func TestGetShotRawErrors(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 33, 1000, nil, map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)

	res := call(t, session, "get_shot_raw", map[string]any{"id": 424242})
	if !res.IsError {
		t.Fatalf("expected isError for an unknown shot id")
	}
	if msg := errorText(t, res); !strings.Contains(msg, "not found; use list_shots") {
		t.Fatalf("unknown-shot error = %q, want it to mention list_shots", msg)
	}

	res = call(t, session, "get_shot_raw", map[string]any{"id": 33})
	if !res.IsError {
		t.Fatalf("expected isError for a shot without datapoints")
	}
	if msg := errorText(t, res); !strings.Contains(msg, "no recorded brew data") {
		t.Fatalf("no-datapoints error = %q, want it to mention recorded brew data", msg)
	}
}

func TestExplainScoreComponents(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 41, 1000, map[string]any{"datapoints": map[string]any{
		"pressure":    []any{80.0, 81.0, 82.0, 80.0, 81.0},
		"temperature": []any{900.0, 901.0, 899.0, 900.0, 901.0, 900.0},
		"timeInShot":  []any{0.0, 10.0, 20.0, 30.0, 40.0, 50.0},
		"weight":      []any{0.0, 100.0, 200.0, 300.0, 400.0, 450.0},
	}}, map[string]any{"dose": 18.0, "tds": 9.0})
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "explain_score", map[string]any{"id": 41}))

	if got := numberField(t, out, "shot_id"); got != 41 {
		t.Fatalf("shot_id = %v, want 41", got)
	}
	score := numberField(t, out, "score")
	if b, _ := out["used_bean_target"].(bool); b {
		t.Fatalf("used_bean_target = true without a bean source")
	}

	var sumScoreWeight, sumWeight, shareSum float64
	names := map[string]bool{}
	for _, raw := range objects(out, "components") {
		c, _ := raw.(map[string]any)
		name, _ := c["name"].(string)
		names[name] = true
		partScore := c["score"].(float64)
		weight := c["weight"].(float64)
		share := c["weight_share"].(float64)
		sumScoreWeight += partScore * weight
		sumWeight += weight
		shareSum += share
		if target, _ := c["target"].(string); target != "generic" {
			t.Fatalf("%s target = %q, want generic", name, target)
		}
	}
	for _, want := range []string{"pressure", "temperature", "ratio", "extraction_yield", "channeling"} {
		if !names[want] {
			t.Fatalf("missing %s component: %v", want, names)
		}
	}
	if got := math.Floor(sumScoreWeight/sumWeight + 0.5); got != score {
		t.Fatalf("weighted component average = %v, want score %v", got, score)
	}
	if math.Abs(shareSum-1) > 1e-9 {
		t.Fatalf("weight_share sum = %v, want 1", shareSum)
	}
}

func TestExplainScoreSkipsRatioAndExtractionYieldWithoutDose(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 42, 1000, map[string]any{"datapoints": map[string]any{
		"pressure":    []any{80.0, 81.0, 82.0, 80.0, 81.0},
		"temperature": []any{900.0, 901.0, 899.0, 900.0, 901.0, 900.0},
		"timeInShot":  []any{0.0, 10.0, 20.0, 30.0, 40.0, 50.0},
	}}, map[string]any{"coffee": "Alpha"}) // no dose: no ratio and no extraction yield
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "explain_score", map[string]any{"id": 42}))

	skipped := map[string]string{}
	for _, raw := range objects(out, "skipped") {
		s, _ := raw.(map[string]any)
		name, _ := s["name"].(string)
		reason, _ := s["reason"].(string)
		skipped[name] = reason
	}
	if _, ok := skipped["ratio"]; !ok {
		t.Fatalf("ratio is not listed as skipped: %v", skipped)
	}
	if _, ok := skipped["extraction_yield"]; !ok {
		t.Fatalf("extraction_yield is not listed as skipped: %v", skipped)
	}
	for _, raw := range objects(out, "components") {
		c, _ := raw.(map[string]any)
		if name, _ := c["name"].(string); name == "ratio" || name == "extraction_yield" {
			t.Fatalf("%s component present without a dose", name)
		}
	}
}

func TestExplainScoreInsufficientData(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 43, 1000, map[string]any{"datapoints": map[string]any{
		"pressure":   []any{80.0, 80.0, 80.0}, // only 3 samples >= 5 bar
		"timeInShot": []any{0.0, 10.0, 20.0},
	}}, map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "explain_score", map[string]any{"id": 43}))

	if _, ok := out["score"]; ok {
		t.Fatalf("score present with too little data: %v", out["score"])
	}
	if n := len(objects(out, "components")); n != 0 {
		t.Fatalf("components = %d, want 0", n)
	}
	skipped := objects(out, "skipped")
	if len(skipped) != 1 {
		t.Fatalf("skipped = %v, want one all entry", skipped)
	}
	s, _ := skipped[0].(map[string]any)
	if name, _ := s["name"].(string); name != "all" {
		t.Fatalf("skipped name = %v, want all", s["name"])
	}
	if reason, _ := s["reason"].(string); reason == "" {
		t.Fatalf("skipped reason is empty")
	}
}

func TestExplainScoreUnknownID(t *testing.T) {
	ts, _ := newDeveloperServer(t, true, false)
	session := connect(t, ts.URL+Path)
	res := call(t, session, "explain_score", map[string]any{"id": 424242})
	if !res.IsError {
		t.Fatalf("expected isError for an unknown shot id")
	}
	if msg := errorText(t, res); !strings.Contains(msg, "not found; use list_shots") {
		t.Fatalf("unknown-shot error = %q, want it to mention list_shots", msg)
	}
}

func TestExportShotsDatasetListedWithOptIn(t *testing.T) {
	ts, _ := newDeveloperServer(t, true, false)
	session := connect(t, ts.URL+Path)
	tool := listToolsByName(t, session)["export_shots_dataset"]
	if tool == nil {
		t.Fatalf("export_shots_dataset is missing from tools/list with the opt-in")
	}
	a := tool.Annotations
	if a == nil || !a.ReadOnlyHint || !a.IdempotentHint {
		t.Fatalf("export_shots_dataset should be read-only and idempotent")
	}
	if a.OpenWorldHint == nil || *a.OpenWorldHint {
		t.Fatalf("export_shots_dataset should be closed-world")
	}
	if tool.OutputSchema == nil {
		t.Fatalf("export_shots_dataset has no output schema")
	}
	limit := schemaProperty(t, tool.InputSchema, "limit")
	if got := numberField(t, limit, "minimum"); got != 1 {
		t.Fatalf("limit minimum = %v, want 1", got)
	}
	if got := numberField(t, limit, "maximum"); got != maxDatasetLimit {
		t.Fatalf("limit maximum = %v, want %d", got, maxDatasetLimit)
	}
	if got := numberField(t, limit, "default"); got != defaultDatasetLimit {
		t.Fatalf("limit default = %v, want %d", got, defaultDatasetLimit)
	}
	// The export takes the same filter fields as list_shots.
	for _, name := range []string{"bean", "machine_id", "min_rating", "since", "until", "cursor"} {
		schemaProperty(t, tool.InputSchema, name)
	}
}

func datasetRowByID(t *testing.T, rows []any, id float64) map[string]any {
	t.Helper()
	for _, raw := range rows {
		row, _ := raw.(map[string]any)
		if v, _ := row["id"].(float64); v == id {
			return row
		}
	}
	t.Fatalf("dataset row id %v not found", id)
	return nil
}

func TestExportShotsDatasetFiltersPagingAndFields(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	data := map[string]any{"datapoints": map[string]any{
		"timeInShot": []any{0.0, 10.0, 20.0, 30.0, 40.0},
		"pressure":   []any{80.0, 81.0, 82.0, 80.0, 81.0},
		"shotWeight": []any{0.0, 100.0, 200.0, 300.0, 360.0},
	}}
	insertShot(t, sqlDB, 1, 1000, data, map[string]any{"coffee": "Alpha Blend", "dose": 18.0, "tds": 9.5, "rating": 4.0, "grindSetting": "3.2", "notes": "bright"})
	insertShot(t, sqlDB, 2, 1001, data, map[string]any{"coffee": "Beta Roast", "dose": 18.0, "rating": 2.0})
	insertShot(t, sqlDB, 3, 1002, data, map[string]any{"coffee": "Alpha Reserve", "dose": 19.0, "rating": 5.0})
	session := connect(t, ts.URL+Path)

	first := structured(t, call(t, session, "export_shots_dataset", map[string]any{"limit": 2}))
	if got := numberField(t, first, "count"); got != 2 {
		t.Fatalf("count = %v, want 2", got)
	}
	rows := objects(first, "shots")
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if got := numberField(t, rows[0].(map[string]any), "id"); got != 3 {
		t.Fatalf("first row id = %v, want 3 (newest first)", got)
	}
	cursor, _ := first["next_cursor"].(string)
	if cursor == "" {
		t.Fatalf("expected a next_cursor when the limit was hit")
	}

	second := structured(t, call(t, session, "export_shots_dataset", map[string]any{"limit": 2, "cursor": cursor}))
	if got := numberField(t, second, "count"); got != 1 {
		t.Fatalf("second count = %v, want 1", got)
	}
	if _, ok := second["next_cursor"]; ok {
		t.Fatalf("next_cursor present on the last page")
	}
	if got := numberField(t, objects(second, "shots")[0].(map[string]any), "id"); got != 1 {
		t.Fatalf("last row id = %v, want 1", got)
	}

	alpha := structured(t, call(t, session, "export_shots_dataset", map[string]any{"bean": "alpha"}))
	if got := numberField(t, alpha, "count"); got != 2 {
		t.Fatalf("bean filter count = %v, want 2", got)
	}
	rated := structured(t, call(t, session, "export_shots_dataset", map[string]any{"min_rating": 4}))
	if got := numberField(t, rated, "count"); got != 2 {
		t.Fatalf("min_rating filter count = %v, want 2", got)
	}

	row := datasetRowByID(t, objects(alpha, "shots"), 1)
	if got, _ := row["bean"].(string); got != "Alpha Blend" {
		t.Fatalf("bean = %v, want Alpha Blend", got)
	}
	if got, _ := row["grind_setting"].(string); got != "3.2" {
		t.Fatalf("grind_setting = %v, want 3.2", got)
	}
	if got, _ := row["notes"].(string); got != "bright" {
		t.Fatalf("notes = %v, want bright", got)
	}
	if got, ok := row["rating"].(float64); !ok || got != 4 {
		t.Fatalf("rating = %v, want 4", row["rating"])
	}
	if got, ok := row["tds_pct"].(float64); !ok || got != 9.5 {
		t.Fatalf("tds_pct = %v, want 9.5", row["tds_pct"])
	}
	if got, ok := row["dose_in_g"].(float64); !ok || got != 18 {
		t.Fatalf("dose_in_g = %v, want 18", row["dose_in_g"])
	}
	if _, ok := row["duration_s"]; !ok {
		t.Fatalf("duration_s missing from a dataset row")
	}
	if _, ok := row["channeling"]; !ok {
		t.Fatalf("channeling missing from a dataset row")
	}
	if b, _ := row["used_bean_target"].(bool); b {
		t.Fatalf("used_bean_target = true without a bean source")
	}
}

// TestDeveloperToolsKeepListShotsPaging pins that extracting scanShots left
// list_shots' paging handoff untouched, now with the developer tools also
// registered on the server.
func TestDeveloperToolsKeepListShotsPaging(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 1, 1000, nil, map[string]any{"coffee": "Alpha Blend"})
	insertShot(t, sqlDB, 2, 1001, nil, map[string]any{"coffee": "Beta Roast"})
	insertShot(t, sqlDB, 3, 1002, nil, map[string]any{"coffee": "Alpha Reserve"})
	session := connect(t, ts.URL+Path)

	first := structured(t, call(t, session, "list_shots", map[string]any{"limit": 2}))
	if got := len(objects(first, "shots")); got != 2 {
		t.Fatalf("first page = %d shots, want 2", got)
	}
	cursor, _ := first["next_cursor"].(string)
	if cursor == "" {
		t.Fatalf("expected a next_cursor")
	}
	second := structured(t, call(t, session, "list_shots", map[string]any{"limit": 2, "cursor": cursor}))
	if got := len(objects(second, "shots")); got != 1 {
		t.Fatalf("second page = %d shots, want 1", got)
	}
	if _, ok := second["next_cursor"]; ok {
		t.Fatalf("next_cursor present after the last page")
	}
	filtered := structured(t, call(t, session, "list_shots", map[string]any{"bean": "alpha"}))
	if got := len(objects(filtered, "shots")); got != 2 {
		t.Fatalf("bean filter = %d shots, want 2", got)
	}
}

type fakeSync struct {
	last    *string
	lastErr *string
}

func (f fakeSync) SyncState() system.SyncState {
	return system.SyncState{LastSync: f.last, LastSyncError: f.lastErr}
}

func newLogBuffer(t *testing.T, capacity int, lines ...string) *logbuf.Buffer {
	t.Helper()
	b := logbuf.New(capacity)
	for _, line := range lines {
		if _, err := b.Write([]byte(line + "\n")); err != nil {
			t.Fatalf("logbuf write %q: %v", line, err)
		}
	}
	return b
}

func TestGetDiagnosticsListedWithOptIn(t *testing.T) {
	ts, _ := newDeveloperServer(t, true, false)
	session := connect(t, ts.URL+Path)
	tool := listToolsByName(t, session)["get_diagnostics"]
	if tool == nil {
		t.Fatalf("get_diagnostics is missing from tools/list with the opt-in")
	}
	a := tool.Annotations
	if a == nil || !a.ReadOnlyHint || !a.IdempotentHint {
		t.Fatalf("get_diagnostics should be read-only and idempotent")
	}
	if a.OpenWorldHint == nil || *a.OpenWorldHint {
		t.Fatalf("get_diagnostics should be closed-world")
	}
	if tool.OutputSchema == nil {
		t.Fatalf("get_diagnostics has no output schema")
	}
	lines := schemaProperty(t, tool.InputSchema, "lines")
	if got := numberField(t, lines, "minimum"); got != 1 {
		t.Fatalf("lines minimum = %v, want 1", got)
	}
	if got := numberField(t, lines, "maximum"); got != maxDiagnosticLines {
		t.Fatalf("lines maximum = %v, want %d", got, maxDiagnosticLines)
	}
	if got := numberField(t, lines, "default"); got != defaultDiagnosticLines {
		t.Fatalf("lines default = %v, want %d", got, defaultDiagnosticLines)
	}
	contains := schemaProperty(t, tool.InputSchema, "contains")
	if got := numberField(t, contains, "maxLength"); got != maxDiagnosticContains {
		t.Fatalf("contains maxLength = %v, want %d", got, maxDiagnosticContains)
	}
}

func TestGetDiagnosticsReturnsLogsAndState(t *testing.T) {
	buf := newLogBuffer(t, 10, "one", "two", "three", "four")
	lastSync := "2026-09-27T10:00:00Z"
	syncErr := "history fetch failed"
	reachable := true
	machineErr := "connection refused"
	ts, _ := newDeveloperServerFull(t, true, false,
		fakePoller{reachable: &reachable, lastErr: &machineErr},
		buf,
		fakeSync{last: &lastSync, lastErr: &syncErr},
		nil,
	)
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "get_diagnostics", map[string]any{"lines": 2}))

	if lines := stringList(out, "log_lines"); strings.Join(lines, ",") != "three,four" {
		t.Fatalf("log_lines = %v, want [three four]", lines)
	}
	if got, _ := out["last_sync"].(string); got != lastSync {
		t.Fatalf("last_sync = %v, want %q", out["last_sync"], lastSync)
	}
	if got, _ := out["last_sync_error"].(string); got != syncErr {
		t.Fatalf("last_sync_error = %v, want %q", out["last_sync_error"], syncErr)
	}
	if got, ok := out["polled_machine_reachable"].(bool); !ok || !got {
		t.Fatalf("polled_machine_reachable = %v, want true", out["polled_machine_reachable"])
	}
	if got, _ := out["last_machine_error"].(string); got != machineErr {
		t.Fatalf("last_machine_error = %v, want %q", out["last_machine_error"], machineErr)
	}
}

func TestGetDiagnosticsOmitsAbsentState(t *testing.T) {
	ts, _ := newDeveloperServerFull(t, true, false, fakePoller{}, nil, nil, nil)
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "get_diagnostics", map[string]any{}))

	if raw, ok := out["log_lines"].([]any); !ok || len(raw) != 0 {
		t.Fatalf("log_lines = %#v, want an empty array without a log source", out["log_lines"])
	}
	for _, key := range []string{"last_sync", "last_sync_error", "last_machine_error", "polled_machine_reachable"} {
		if _, ok := out[key]; ok {
			t.Fatalf("%s present without a source: %v", key, out[key])
		}
	}
}

func TestGetDiagnosticsContainsFilter(t *testing.T) {
	buf := newLogBuffer(t, 20, "startup ok", "ERROR: pressure probe", "another line", "error: retry")
	ts, _ := newDeveloperServerFull(t, true, false, fakePoller{}, buf, nil, nil)
	session := connect(t, ts.URL+Path)

	out := structured(t, call(t, session, "get_diagnostics", map[string]any{"contains": "error", "lines": 10}))
	if got := strings.Join(stringList(out, "log_lines"), "|"); got != "ERROR: pressure probe|error: retry" {
		t.Fatalf("filtered log_lines = %q", got)
	}
	// The filter scans the whole kept buffer, so an older matching line is
	// still found even when the returned window is smaller.
	out = structured(t, call(t, session, "get_diagnostics", map[string]any{"contains": "startup", "lines": 1}))
	if got := strings.Join(stringList(out, "log_lines"), "|"); got != "startup ok" {
		t.Fatalf("filtered log_lines with a small window = %q", got)
	}
}

func TestGetDiagnosticsMasksSecrets(t *testing.T) {
	buf := newLogBuffer(t, 10,
		"request X-GLP-Token: supersecretvalue",
		"GET /api/shots?token=abc123&limit=5",
		"Authorization: Bearer eyJhbGciOiJIUzI1",
		"dialing https://alice:hunter2@example.test/api",
	)
	ts, _ := newDeveloperServerFull(t, true, false, fakePoller{}, buf, nil, nil)
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "get_diagnostics", map[string]any{}))
	joined := strings.Join(stringList(out, "log_lines"), "\n")

	for _, secret := range []string{"supersecretvalue", "abc123", "eyJhbGciOiJIUzI1", "hunter2"} {
		if strings.Contains(joined, secret) {
			t.Fatalf("secret %q leaked in %q", secret, joined)
		}
	}
	for _, masked := range []string{"X-GLP-Token: ***", "token=***&limit=5", "Bearer ***", "https://alice:***@example.test/api"} {
		if !strings.Contains(joined, masked) {
			t.Fatalf("expected %q in masked output %q", masked, joined)
		}
	}
}

type fakePreheatHistory struct {
	runs []system.PreheatRun
}

func (f fakePreheatHistory) PreheatHistory() []system.PreheatRun { return f.runs }

func newPreheatServer(t *testing.T, runs []system.PreheatRun) *httptest.Server {
	t.Helper()
	ts, _ := newDeveloperServerFull(t, true, false, fakePoller{}, nil, nil, fakePreheatHistory{runs: runs})
	return ts
}

func ptrI64(v int64) *int64 { return &v }

func preheatTime(ms int64) string { return time.UnixMilli(ms).UTC().Format(time.RFC3339) }

func TestGetPreheatHistoryListedWithOptIn(t *testing.T) {
	ts, _ := newDeveloperServer(t, true, false)
	session := connect(t, ts.URL+Path)
	tool := listToolsByName(t, session)["get_preheat_history"]
	if tool == nil {
		t.Fatalf("get_preheat_history is missing from tools/list with the opt-in")
	}
	a := tool.Annotations
	if a == nil || !a.ReadOnlyHint || !a.IdempotentHint {
		t.Fatalf("get_preheat_history should be read-only and idempotent")
	}
	if a.OpenWorldHint == nil || *a.OpenWorldHint {
		t.Fatalf("get_preheat_history should be closed-world")
	}
	if tool.OutputSchema == nil {
		t.Fatalf("get_preheat_history has no output schema")
	}
	limit := schemaProperty(t, tool.InputSchema, "limit")
	if got := numberField(t, limit, "minimum"); got != 1 {
		t.Fatalf("limit minimum = %v, want 1", got)
	}
	if got := numberField(t, limit, "maximum"); got != maxPreheatLimit {
		t.Fatalf("limit maximum = %v, want %d", got, maxPreheatLimit)
	}
	if got := numberField(t, limit, "default"); got != defaultPreheatLimit {
		t.Fatalf("limit default = %v, want %d", got, defaultPreheatLimit)
	}
	// include_samples is optional and defaults to false.
	if p := schemaProperty(t, tool.InputSchema, "include_samples"); p["type"] != "boolean" {
		t.Fatalf("include_samples type = %v, want boolean", p["type"])
	}
}

func TestGetPreheatHistoryDerivedFields(t *testing.T) {
	const min = int64(60_000)
	base := int64(1_700_000_000_000)
	stableRun := system.PreheatRun{
		SwitchOnAt:       base,
		SwitchOffAt:      ptrI64(base + 20*min),
		PreheatMinutes:   10,
		PredictedReadyAt: base + 10*min,
		StableAt:         ptrI64(base + 8*min),
		Samples: []system.PreheatSample{
			{TS: 0, TempC: 20, TargetC: 93},
			{TS: 30, TempC: 80, TargetC: 93},
		},
	}
	windowRun := system.PreheatRun{
		SwitchOnAt:       base + 100*min,
		SwitchOffAt:      ptrI64(base + 115*min),
		PreheatMinutes:   6,
		PredictedReadyAt: base + 106*min,
	}
	readyByRun := system.PreheatRun{
		SwitchOnAt:        base + 200*min,
		SwitchOffAt:       ptrI64(base + 212*min),
		PreheatMinutes:    5,
		PredictedReadyAt:  base + 205*min,
		StableAt:          ptrI64(base + 206*min),
		ReadyByTargetAt:   ptrI64(base + 209*min),
		PlannedSwitchOnAt: ptrI64(base + 200*min),
	}
	// Newest first, as the poller serves history.
	ts := newPreheatServer(t, []system.PreheatRun{readyByRun, windowRun, stableRun})
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "get_preheat_history", map[string]any{}))

	runs := objects(out, "runs")
	if len(runs) != 3 {
		t.Fatalf("runs = %d, want 3", len(runs))
	}
	byOn := map[string]map[string]any{}
	for _, raw := range runs {
		r, _ := raw.(map[string]any)
		on, _ := r["switch_on_at"].(string)
		byOn[on] = r
	}

	stable := byOn[preheatTime(base)]
	if stable == nil {
		t.Fatalf("stable run not found: %v", byOn)
	}
	if got, _ := stable["switch_off_at"].(string); got != preheatTime(base+20*min) {
		t.Fatalf("stable switch_off_at = %q, want %q", got, preheatTime(base+20*min))
	}
	if inProg, _ := stable["in_progress"].(bool); inProg {
		t.Fatalf("stable run marked in_progress")
	}
	if got := numberField(t, stable, "preheat_minutes"); got != 10 {
		t.Fatalf("stable preheat_minutes = %v, want 10", got)
	}
	if got, _ := stable["predicted_ready_at"].(string); got != preheatTime(base+10*min) {
		t.Fatalf("stable predicted_ready_at = %q, want %q", got, preheatTime(base+10*min))
	}
	if got, _ := stable["stable_at"].(string); got != preheatTime(base+8*min) {
		t.Fatalf("stable_at = %q, want %q", got, preheatTime(base+8*min))
	}
	if got, _ := stable["ready_at"].(string); got != preheatTime(base+8*min) {
		t.Fatalf("ready_at = %q, want the earlier stable time %q", got, preheatTime(base+8*min))
	}
	if got := numberField(t, stable, "stable_vs_predicted_min"); got != -2 {
		t.Fatalf("stable_vs_predicted_min = %v, want -2 (stabilised two minutes early)", got)
	}
	if got := numberField(t, stable, "sample_count"); got != 2 {
		t.Fatalf("stable sample_count = %v, want 2", got)
	}
	for _, key := range []string{"ready_by_target_at", "planned_switch_on_at", "ready_before_target_min", "samples"} {
		if _, ok := stable[key]; ok {
			t.Fatalf("stable run has %s without a ready-by target or a samples request", key)
		}
	}

	window := byOn[preheatTime(base+100*min)]
	if window == nil {
		t.Fatalf("window-only run not found: %v", byOn)
	}
	if _, ok := window["stable_at"]; ok {
		t.Fatalf("window-only run has stable_at: %v", window["stable_at"])
	}
	if _, ok := window["stable_vs_predicted_min"]; ok {
		t.Fatalf("window-only run has stable_vs_predicted_min without a stable time")
	}
	if got, _ := window["ready_at"].(string); got != preheatTime(base+106*min) {
		t.Fatalf("window-only ready_at = %q, want the predicted time %q", got, preheatTime(base+106*min))
	}
	if got := numberField(t, window, "sample_count"); got != 0 {
		t.Fatalf("window-only sample_count = %v, want 0", got)
	}

	readyBy := byOn[preheatTime(base+200*min)]
	if readyBy == nil {
		t.Fatalf("ready-by run not found: %v", byOn)
	}
	// ready_at is the earlier predicted time, not the later stable time.
	if got, _ := readyBy["ready_at"].(string); got != preheatTime(base+205*min) {
		t.Fatalf("ready-by ready_at = %q, want the earlier predicted time %q", got, preheatTime(base+205*min))
	}
	if got := numberField(t, readyBy, "stable_vs_predicted_min"); got != 1 {
		t.Fatalf("ready-by stable_vs_predicted_min = %v, want 1", got)
	}
	if got, _ := readyBy["ready_by_target_at"].(string); got != preheatTime(base+209*min) {
		t.Fatalf("ready_by_target_at = %q, want %q", got, preheatTime(base+209*min))
	}
	if got, _ := readyBy["planned_switch_on_at"].(string); got != preheatTime(base+200*min) {
		t.Fatalf("planned_switch_on_at = %q, want %q", got, preheatTime(base+200*min))
	}
	if got := numberField(t, readyBy, "ready_before_target_min"); got != 4 {
		t.Fatalf("ready_before_target_min = %v, want 4", got)
	}
}

func TestGetPreheatHistoryInProgressRun(t *testing.T) {
	const min = int64(60_000)
	base := int64(1_700_000_000_000)
	run := system.PreheatRun{
		SwitchOnAt:       base,
		PreheatMinutes:   5,
		PredictedReadyAt: base + 5*min,
	}
	ts := newPreheatServer(t, []system.PreheatRun{run})
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "get_preheat_history", map[string]any{}))

	runs := objects(out, "runs")
	if len(runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(runs))
	}
	row, _ := runs[0].(map[string]any)
	if inProg, _ := row["in_progress"].(bool); !inProg {
		t.Fatalf("open run not marked in_progress: %v", row)
	}
	if _, ok := row["switch_off_at"]; ok {
		t.Fatalf("open run has switch_off_at: %v", row["switch_off_at"])
	}
	if got, _ := row["ready_at"].(string); got != preheatTime(base+5*min) {
		t.Fatalf("open run ready_at = %q, want the predicted time", got)
	}
}

func TestGetPreheatHistorySamplesOnlyOnRequest(t *testing.T) {
	const min = int64(60_000)
	base := int64(1_700_000_000_000)
	run := system.PreheatRun{
		SwitchOnAt:       base,
		SwitchOffAt:      ptrI64(base + 10*min),
		PreheatMinutes:   5,
		PredictedReadyAt: base + 5*min,
		StableAt:         ptrI64(base + 6*min),
		Samples: []system.PreheatSample{
			{TS: 0, TempC: 21.5, TargetC: 93},
			{TS: 30, TempC: 91.25, TargetC: 93},
		},
	}
	ts := newPreheatServer(t, []system.PreheatRun{run})
	session := connect(t, ts.URL+Path)

	off := structured(t, call(t, session, "get_preheat_history", map[string]any{}))
	offRow, _ := objects(off, "runs")[0].(map[string]any)
	if _, ok := offRow["samples"]; ok {
		t.Fatalf("samples present without include_samples")
	}

	on := structured(t, call(t, session, "get_preheat_history", map[string]any{"include_samples": true}))
	onRow, _ := objects(on, "runs")[0].(map[string]any)
	samples := objects(onRow, "samples")
	if len(samples) != 2 {
		t.Fatalf("samples = %d, want 2", len(samples))
	}
	first, _ := samples[0].(map[string]any)
	if got := numberField(t, first, "t_s"); got != 0 {
		t.Fatalf("first sample t_s = %v, want 0", got)
	}
	if got := numberField(t, first, "temp_c"); got != 21.5 {
		t.Fatalf("first sample temp_c = %v, want 21.5", got)
	}
	if got := numberField(t, first, "target_c"); got != 93 {
		t.Fatalf("first sample target_c = %v, want 93", got)
	}
	second, _ := samples[1].(map[string]any)
	if got := numberField(t, second, "t_s"); got != 30 {
		t.Fatalf("second sample t_s = %v, want 30", got)
	}
}

func TestGetPreheatHistoryLimit(t *testing.T) {
	const min = int64(60_000)
	base := int64(1_700_000_000_000)
	makeRun := func(i int64) system.PreheatRun {
		return system.PreheatRun{
			SwitchOnAt:       base + i*min,
			SwitchOffAt:      ptrI64(base + i*min + 10*min),
			PreheatMinutes:   5,
			PredictedReadyAt: base + i*min + 5*min,
		}
	}
	// Newest first, as the poller serves history.
	ts := newPreheatServer(t, []system.PreheatRun{makeRun(3), makeRun(2), makeRun(1), makeRun(0)})
	session := connect(t, ts.URL+Path)

	limited := structured(t, call(t, session, "get_preheat_history", map[string]any{"limit": 2}))
	got := objects(limited, "runs")
	if len(got) != 2 {
		t.Fatalf("limit 2 returned %d runs, want 2", len(got))
	}
	first, _ := got[0].(map[string]any)
	if on, _ := first["switch_on_at"].(string); on != preheatTime(base+3*min) {
		t.Fatalf("first run switch_on_at = %q, want the newest %q", on, preheatTime(base+3*min))
	}
	second, _ := got[1].(map[string]any)
	if on, _ := second["switch_on_at"].(string); on != preheatTime(base+2*min) {
		t.Fatalf("second run switch_on_at = %q, want %q", on, preheatTime(base+2*min))
	}

	// The default limit (10) is above the four retained runs, so all come back.
	def := structured(t, call(t, session, "get_preheat_history", map[string]any{}))
	if n := len(objects(def, "runs")); n != 4 {
		t.Fatalf("default limit returned %d runs, want 4", n)
	}
}

func TestGetPreheatHistoryUnavailable(t *testing.T) {
	ts, _ := newDeveloperServer(t, true, false) // Preheat source left nil.
	session := connect(t, ts.URL+Path)
	res := call(t, session, "get_preheat_history", map[string]any{})
	if !res.IsError {
		t.Fatalf("expected isError when the preheat source is nil")
	}
	if msg := errorText(t, res); !strings.Contains(msg, "preheat history is not available") {
		t.Fatalf("nil-source error = %q, want it to say the history is not available", msg)
	}
}
