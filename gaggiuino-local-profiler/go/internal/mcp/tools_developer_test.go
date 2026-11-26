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
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfstats"
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
		Shots:       shots.NewService(shotsRepo),
		ShotsRepo:   shotsRepo,
		Library:     libRepo,
		Maintenance: maintRepo,
		Registry:    registry,
		Poller:      poller,
		Logs:        logs,
		Sync:        sync,
		Preheat:     preheat,
		Version:     "test",
		Settings:    settingsSource(true, allowWrite, allowDeveloper),
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
	for _, name := range []string{"get_shot_raw", "explain_score", "export_shots_dataset", "get_diagnostics", "get_preheat_history", "get_perf_stats"} {
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
	want := "annotate_shot,compare_shots,explain_score,export_shots_dataset,get_analytics_summary,get_diagnostics,get_library,get_machine_status,get_maintenance_status,get_perf_stats,get_preheat_history,get_shot,get_shot_raw,list_beans,list_shots,mark_maintenance_done,set_known_grind"
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

// TestExplainScoreProfileTimeTarget (#1504): with a window saved for the
// shot's profile and machine, the duration component scores against it and
// reports target "profile" with the window inputs; without one it stays
// "generic".
func TestExplainScoreProfileTimeTarget(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 43, 1000, map[string]any{"datapoints": map[string]any{
		"pressure":    []any{80.0, 81.0, 82.0, 80.0, 81.0},
		"temperature": []any{900.0, 901.0, 899.0, 900.0, 901.0, 900.0},
		"timeInShot":  []any{0.0, 10.0, 20.0, 30.0, 40.0, 50.0},
		"weight":      []any{0.0, 100.0, 200.0, 300.0, 400.0, 450.0},
	}}, map[string]any{"dose": 18.0})
	if _, err := sqlDB.Exec(`UPDATE shots SET duration = 300 WHERE id = 43`); err != nil {
		t.Fatalf("setting duration: %v", err)
	}

	session := connect(t, ts.URL+Path)
	durationComponent := func() (string, map[string]any) {
		t.Helper()
		out := structured(t, call(t, session, "explain_score", map[string]any{"id": 43}))
		for _, raw := range objects(out, "components") {
			c, _ := raw.(map[string]any)
			if name, _ := c["name"].(string); name == "duration" {
				inputs, _ := c["inputs"].(map[string]any)
				target, _ := c["target"].(string)
				return target, inputs
			}
		}
		t.Fatalf("no duration component: %+v", out)
		return "", nil
	}

	if target, _ := durationComponent(); target != "generic" {
		t.Fatalf("duration target = %q, want generic without a window", target)
	}

	repo := shots.NewRepository(sqlDB)
	if err := repo.SaveProfileTimeTargets(map[string][]shots.ProfileTimeTarget{
		"1": {{ProfileName: "Test Profile", MinS: 40, MaxS: 48}},
	}); err != nil {
		t.Fatalf("SaveProfileTimeTargets: %v", err)
	}

	target, inputs := durationComponent()
	if target != "profile" {
		t.Fatalf("duration target = %q, want profile with a window", target)
	}
	if got, _ := inputs["min_s"].(float64); got != 40 {
		t.Fatalf("duration min_s = %v, want 40", inputs["min_s"])
	}
	if got, _ := inputs["max_s"].(float64); got != 48 {
		t.Fatalf("duration max_s = %v, want 48", inputs["max_s"])
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

// #1538: a sub-5-bar shot with a FLOW-only profile scores without the
// pressure part, and explain_score explains why from the same field the shot
// detail hint reads.
func TestExplainScoreSub5BarOmitsPressure(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 44, 1000, map[string]any{
		"profile": map[string]any{"phases": []any{map[string]any{"type": "FLOW"}}},
		"datapoints": map[string]any{
			"pressure":       []any{40.0, 40.0, 40.0, 40.0, 40.0},
			"targetPressure": []any{80.0, 80.0, 80.0, 80.0, 80.0}, // a FLOW-phase limit
			"phaseIndex":     []any{0.0, 0.0, 0.0, 0.0, 0.0},
		},
	}, map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "explain_score", map[string]any{"id": 44}))

	if _, ok := out["score"]; !ok {
		t.Fatalf("expected a score for a sub-5-bar shot: %v", out)
	}
	if note, _ := out["pressure_note"].(string); !strings.Contains(note, "left out") {
		t.Fatalf("pressure_note = %q, want the left-out reason", note)
	}
	for _, raw := range objects(out, "components") {
		c, _ := raw.(map[string]any)
		if n, _ := c["name"].(string); n == "pressure" {
			t.Fatalf("pressure component present for a FLOW-only profile: %v", c)
		}
	}
	skipped := map[string]string{}
	for _, raw := range objects(out, "skipped") {
		s, _ := raw.(map[string]any)
		n, _ := s["name"].(string)
		r, _ := s["reason"].(string)
		skipped[n] = r
	}
	if _, ok := skipped["pressure"]; !ok {
		t.Fatalf("pressure not listed as skipped: %v", skipped)
	}
}

// #1538: a sub-5-bar shot with a PRESSURE phase is scored against its own
// target, visible as a profile-target pressure component and a note.
func TestExplainScoreSub5BarProfileTarget(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 45, 1000, map[string]any{
		"profile": map[string]any{"phases": []any{
			map[string]any{"type": "FLOW"},
			map[string]any{"type": "PRESSURE"},
		}},
		"datapoints": map[string]any{
			"pressure":       []any{40.0, 40.0, 40.0, 40.0, 40.0, 40.0},
			"targetPressure": []any{0.0, 40.0, 40.0, 40.0, 40.0, 40.0},
			"phaseIndex":     []any{0.0, 1.0, 1.0, 1.0, 1.0, 1.0},
		},
	}, map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "explain_score", map[string]any{"id": 45}))

	if _, ok := out["score"]; !ok {
		t.Fatalf("expected a score for a flat 4-bar shot")
	}
	if note, _ := out["pressure_note"].(string); !strings.Contains(note, "profile") {
		t.Fatalf("pressure_note = %q, want the profile-target reason", note)
	}
	var pressure map[string]any
	for _, raw := range objects(out, "components") {
		c, _ := raw.(map[string]any)
		if n, _ := c["name"].(string); n == "pressure" {
			pressure = c
		}
	}
	if pressure == nil {
		t.Fatalf("pressure component missing: %v", out)
	}
	if target, _ := pressure["target"].(string); target != "profile" {
		t.Fatalf("pressure target = %q, want profile", target)
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

// TestExportShotsDatasetBeanMix covers #1837: a mixed shot exports as "A + B"
// with its parts, the bean filter matches any part, and a single-bean row keeps
// its old shape (no bean_components key).
func TestExportShotsDatasetBeanMix(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 1, 1000, nil, map[string]any{
		"coffee": "Alpha Blend",
		"beanMix": []any{
			map[string]any{"coffee": "Alpha Blend", "beanId": float64(1), "grams": float64(12)},
			map[string]any{"coffee": "Beta Roast", "beanId": float64(2), "grams": float64(6)},
		},
	})
	insertShot(t, sqlDB, 2, 1001, nil, map[string]any{"coffee": "Gamma Light"})
	session := connect(t, ts.URL+Path)

	all := structured(t, call(t, session, "export_shots_dataset", map[string]any{}))
	mixed := datasetRowByID(t, objects(all, "shots"), 1)
	if got, _ := mixed["bean"].(string); got != "Alpha Blend + Beta Roast" {
		t.Fatalf("mixed row bean = %q, want \"Alpha Blend + Beta Roast\"", got)
	}
	components := objects(mixed, "bean_components")
	if len(components) != 2 {
		t.Fatalf("bean_components = %d entries, want 2", len(components))
	}
	second := components[1].(map[string]any)
	if got, _ := second["bean"].(string); got != "Beta Roast" {
		t.Fatalf("component[1].bean = %v, want Beta Roast", got)
	}
	if got, ok := second["grams"].(float64); !ok || got != 6 {
		t.Fatalf("component[1].grams = %v, want 6", second["grams"])
	}

	single := datasetRowByID(t, objects(all, "shots"), 2)
	if got, _ := single["bean"].(string); got != "Gamma Light" {
		t.Fatalf("single row bean = %q, want Gamma Light", got)
	}
	if _, ok := single["bean_components"]; ok {
		t.Fatalf("single-bean row carries a bean_components key")
	}

	filtered := structured(t, call(t, session, "export_shots_dataset", map[string]any{"bean": "beta"}))
	if got := numberField(t, filtered, "count"); got != 1 {
		t.Fatalf("bean=beta count = %v, want 1 (any part matches)", got)
	}
	if got, _ := objects(filtered, "shots")[0].(map[string]any)["bean"].(string); got != "Alpha Blend + Beta Roast" {
		t.Fatalf("filtered row bean = %q, want the mix label", got)
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

// #1626: the two error fields go through the same redaction as the log
// lines; reachability itself stays visible.
func TestGetDiagnosticsRedactsErrorFields(t *testing.T) {
	syncErr := `Get "https://gaggiuino.local/api/shots/latest": dial tcp 192.168.1.5:443: i/o timeout`
	reachable := false
	machineErr := "lookup gaggimate.local on 10.0.0.1:53: no such host"
	ts, _ := newDeveloperServerFull(t, true, false,
		fakePoller{reachable: &reachable, lastErr: &machineErr},
		newLogBuffer(t, 10),
		fakeSync{lastErr: &syncErr},
		nil,
	)
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "get_diagnostics", map[string]any{}))

	if got, _ := out["last_sync_error"].(string); got != `Get "[url]": dial tcp [host]: i/o timeout` {
		t.Fatalf("last_sync_error = %q", got)
	}
	if got, _ := out["last_machine_error"].(string); got != "lookup [host] on [host]: no such host" {
		t.Fatalf("last_machine_error = %q", got)
	}
	if got, ok := out["polled_machine_reachable"].(bool); !ok || got {
		t.Fatalf("polled_machine_reachable = %v, want false", out["polled_machine_reachable"])
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
		"mqtt connect password=hunter3 refused",
		"poll failed: dial tcp 192.168.1.5:80: connect: connection refused",
		"gaggimate: ws://gaggimate.local/ws closed",
	)
	ts, _ := newDeveloperServerFull(t, true, false, fakePoller{}, buf, nil, nil)
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "get_diagnostics", map[string]any{}))
	joined := strings.Join(stringList(out, "log_lines"), "\n")

	// #1626: one redaction function everywhere, so hosts are masked here too.
	for _, secret := range []string{"supersecretvalue", "abc123", "eyJhbGciOiJIUzI1", "hunter2", "alice", "example.test", "hunter3", "192.168.1.5", "gaggimate.local"} {
		if strings.Contains(joined, secret) {
			t.Fatalf("secret %q leaked in %q", secret, joined)
		}
	}
	for _, masked := range []string{"X-GLP-Token: ***", "token=***&limit=5", "Bearer ***", "dialing [url]", "password=*** refused", "dial tcp [host]: connect", "gaggimate: [url] closed"} {
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

// newPerfServer wires the request-timing recorder through the developer MCP
// server exactly as cmd/server does: the mux is wrapped with the recorder's
// middleware, so a test's own HTTP requests land in the same snapshot the
// get_perf_stats tool reads.
func newPerfServer(t *testing.T, rec *perfstats.Recorder) *httptest.Server {
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
	mux.HandleFunc("GET /api/shots/{id}", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle(Path, NewHandler(Deps{
		Shots:       shots.NewService(shotsRepo),
		ShotsRepo:   shotsRepo,
		Library:     libRepo,
		Maintenance: maintRepo,
		Registry:    registry,
		Poller:      fakePoller{},
		Recorder:    rec,
		DBPath:      dbPath,
		Version:     "test",
		Settings:    settingsSource(true, false, true),
	}))
	ts := httptest.NewServer(rec.Middleware(mux))
	t.Cleanup(ts.Close)
	return ts
}

func TestGetPerfStatsListedWithOptIn(t *testing.T) {
	ts := newPerfServer(t, perfstats.New())
	session := connect(t, ts.URL+Path)
	tool := listToolsByName(t, session)["get_perf_stats"]
	if tool == nil {
		t.Fatalf("get_perf_stats is missing from tools/list with the opt-in")
	}
	a := tool.Annotations
	if a == nil || !a.ReadOnlyHint || !a.IdempotentHint {
		t.Fatalf("get_perf_stats should be read-only and idempotent")
	}
	if a.OpenWorldHint == nil || *a.OpenWorldHint {
		t.Fatalf("get_perf_stats should be closed-world")
	}
	if tool.OutputSchema == nil {
		t.Fatalf("get_perf_stats has no output schema")
	}
	in := asMap(t, tool.InputSchema)
	if props, _ := in["properties"].(map[string]any); len(props) != 0 {
		t.Fatalf("get_perf_stats should take no input, got %v", props)
	}
}

func TestGetPerfStatsReturnsRecordedRoutes(t *testing.T) {
	rec := perfstats.New()
	ts := newPerfServer(t, rec)
	for i := 0; i < 4; i++ {
		resp, err := http.Get(ts.URL + "/api/shots/42")
		if err != nil {
			t.Fatalf("GET /api/shots/42: %v", err)
		}
		resp.Body.Close()
	}

	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "get_perf_stats", map[string]any{}))

	var shotsRoute map[string]any
	for _, raw := range objects(out, "routes") {
		r, _ := raw.(map[string]any)
		if r["route"] == "GET /api/shots/{id}" {
			shotsRoute = r
		}
	}
	if shotsRoute == nil {
		t.Fatalf("recorded route missing from %v", objects(out, "routes"))
	}
	if got := numberField(t, shotsRoute, "count"); got != 4 {
		t.Fatalf("route count = %v, want 4", got)
	}
	if got := numberField(t, shotsRoute, "recent_count"); got != 4 {
		t.Fatalf("route recent_count = %v, want 4", got)
	}

	proc := object(out, "process")
	if _, ok := proc["uptime_s"].(float64); !ok {
		t.Fatalf("process.uptime_s missing: %v", proc)
	}
	if got := numberField(t, proc, "goroutines"); got < 1 {
		t.Fatalf("process.goroutines = %v, want at least 1", got)
	}

	database := object(out, "database")
	if _, ok := database["size_bytes"].(float64); !ok {
		t.Fatalf("database.size_bytes missing: %v", database)
	}
	if got := numberField(t, database, "shot_count"); got != 0 {
		t.Fatalf("database.shot_count = %v, want 0 for an empty database", got)
	}
}

func TestGetPerfStatsUnavailable(t *testing.T) {
	ts, _ := newDeveloperServer(t, true, false) // Recorder left nil.
	session := connect(t, ts.URL+Path)
	res := call(t, session, "get_perf_stats", map[string]any{})
	if !res.IsError {
		t.Fatalf("expected isError when the recorder is nil")
	}
	if msg := errorText(t, res); !strings.Contains(msg, "performance stats are not available") {
		t.Fatalf("nil-recorder error = %q, want it to say stats are unavailable", msg)
	}
}

// scoreableDatapoints is the fully scoreable series TestExplainScoreComponents
// seeds, reused by the score-model tests so classic actually scores the shot.
func scoreableDatapoints() map[string]any {
	return map[string]any{"datapoints": map[string]any{
		"pressure":    []any{80.0, 81.0, 82.0, 80.0, 81.0},
		"temperature": []any{900.0, 901.0, 899.0, 900.0, 901.0, 900.0},
		"timeInShot":  []any{0.0, 10.0, 20.0, 30.0, 40.0, 50.0},
		"weight":      []any{0.0, 100.0, 200.0, 300.0, 400.0, 450.0},
	}}
}

// modelScoresOf reads a model_scores array as (id, score) pairs in order,
// with a nil score for an entry that omits it.
func modelScoresOf(t *testing.T, m map[string]any) []struct {
	Model string
	Score *int
} {
	t.Helper()
	raw, ok := m["model_scores"].([]any)
	if !ok {
		t.Fatalf("model_scores = %#v, want an array", m["model_scores"])
	}
	out := make([]struct {
		Model string
		Score *int
	}, 0, len(raw))
	for _, entry := range raw {
		e, _ := entry.(map[string]any)
		model, _ := e["model"].(string)
		if model == "" {
			t.Fatalf("model_scores entry has no model: %#v", e)
		}
		var score *int
		if v, ok := e["score"].(float64); ok {
			n := int(v)
			score = &n
		}
		out = append(out, struct {
			Model string
			Score *int
		}{model, score})
	}
	return out
}

// TestExplainScoreListsEveryScoreModel covers #1922: explain_score names the
// active model and lists every registered model's score side by side. The
// production registry holds only classic, so the listing is exactly one entry
// carrying the same score the tool shows.
func TestExplainScoreListsEveryScoreModel(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 41, 1000, scoreableDatapoints(), map[string]any{"dose": 18.0, "tds": 9.0})
	session := connect(t, ts.URL+Path)

	out := structured(t, call(t, session, "explain_score", map[string]any{"id": 41}))
	if got, _ := out["score_model"].(string); got != shots.ClassicScoreModel {
		t.Fatalf("score_model = %q, want %q", got, shots.ClassicScoreModel)
	}
	classicScore := numberField(t, out, "score")
	scores := modelScoresOf(t, out)
	if len(scores) != 1 || scores[0].Model != shots.ClassicScoreModel {
		t.Fatalf("model_scores = %+v, want only classic", scores)
	}
	if scores[0].Score == nil || *scores[0].Score != int(classicScore) {
		t.Fatalf("classic model score = %v, want the shown score %v", scores[0].Score, classicScore)
	}

	// A shot classic cannot score still carries the key: the listing is always a
	// slice, and the entry's score is omitted rather than the array going null.
	insertShot(t, sqlDB, 42, 1001, map[string]any{"datapoints": map[string]any{
		"pressure":   []any{80.0, 80.0, 80.0},
		"timeInShot": []any{0.0, 10.0, 20.0},
	}}, map[string]any{"coffee": "Alpha"})
	out = structured(t, call(t, session, "explain_score", map[string]any{"id": 42}))
	if _, ok := out["score"]; ok {
		t.Fatalf("score present with too little data: %v", out["score"])
	}
	scores = modelScoresOf(t, out)
	if len(scores) != 1 || scores[0].Model != shots.ClassicScoreModel {
		t.Fatalf("unscoreable shot model_scores = %+v, want only classic", scores)
	}
	if scores[0].Score != nil {
		t.Fatalf("unscoreable shot classic score = %v, want it omitted", *scores[0].Score)
	}
}

// TestExportShotsDatasetListsEveryScoreModel covers #1922's dataset half: the
// response names the active model and every row carries every registered
// model's score. Only classic is registered in production, so each row has
// exactly one model entry equal to the row's own score.
func TestExportShotsDatasetListsEveryScoreModel(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 1, 1000, scoreableDatapoints(), map[string]any{"dose": 18.0, "tds": 9.0})
	insertShot(t, sqlDB, 2, 1001, scoreableDatapoints(), map[string]any{"dose": 18.0, "tds": 9.0})
	session := connect(t, ts.URL+Path)

	out := structured(t, call(t, session, "export_shots_dataset", map[string]any{}))
	if got, _ := out["score_model"].(string); got != shots.ClassicScoreModel {
		t.Fatalf("score_model = %q, want %q", got, shots.ClassicScoreModel)
	}
	classicScores := map[float64]float64{}
	for _, raw := range objects(out, "shots") {
		row, _ := raw.(map[string]any)
		id := numberField(t, row, "id")
		classicScores[id] = numberField(t, row, "score")
		scores := modelScoresOf(t, row)
		if len(scores) != 1 || scores[0].Model != shots.ClassicScoreModel {
			t.Fatalf("row %v model_scores = %+v, want only classic", id, scores)
		}
		if scores[0].Score == nil || *scores[0].Score != int(classicScores[id]) {
			t.Fatalf("row %v classic model score = %v, want %v", id, scores[0].Score, classicScores[id])
		}
	}
	if len(classicScores) != 2 {
		t.Fatalf("got %d rows, want 2", len(classicScores))
	}
}

// adherenceDatapoints is a shot with target pressure data in a PRESSURE phase:
// 9 bar against a 7.5 bar target, so the adherence part's mean deviation is
// exactly 1.5 bar and it scores 50. classic sees a 9 bar average and scores
// its pressure part 100, so the combined score is strictly lower.
func adherenceDatapoints() map[string]any {
	return map[string]any{
		"profile": map[string]any{"phases": []any{map[string]any{"type": "PRESSURE"}}},
		"datapoints": map[string]any{
			"pressure":       []any{90.0, 90.0, 90.0, 90.0, 90.0},
			"targetPressure": []any{75.0, 75.0, 75.0, 75.0, 75.0},
			"timeInShot":     []any{0.0, 10.0, 20.0, 30.0, 40.0},
			"phaseIndex":     []any{0.0, 0.0, 0.0, 0.0, 0.0},
		},
	}
}

// adaptiveShotData is a Gaggiuino shot shaped like the demo "Adaptive"
// profile (#2219): global weight stop 37 g, recipe 15 g -> 33 g, phases
// FLOW, PRESSURE, PRESSURE, FLOW with a phaseIndex series, and a null
// top-level profileName as Gaggiuino history shots have.
func adaptiveShotData() map[string]any {
	return map[string]any{
		"profileName": nil,
		"profile": map[string]any{
			"name":                 "Adaptive",
			"globalStopConditions": map[string]any{"weight": 37.0},
			"recipe":               map[string]any{"coffeeIn": 15.0, "coffeeOut": 33.0},
			"phases": []any{
				map[string]any{"type": "FLOW", "target": map[string]any{"end": 7.0}, "restriction": 3.0, "stopConditions": map[string]any{"pressureAbove": 3.0, "time": 20000.0}},
				map[string]any{"type": "PRESSURE", "target": map[string]any{"end": 3.0}, "stopConditions": map[string]any{"time": 6000.0}},
				map[string]any{"type": "PRESSURE", "target": map[string]any{"end": 9.0, "time": 5000.0}, "stopConditions": map[string]any{"time": 5000.0}},
				map[string]any{"type": "FLOW", "target": map[string]any{"end": 2.5, "time": 25000.0}, "restriction": 9.0},
			},
		},
		"datapoints": map[string]any{
			"timeInShot":     []any{0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0},
			"pressure":       []any{20.0, 30.0, 30.0, 30.0, 60.0, 90.0, 85.0, 80.0},
			"phaseIndex":     []any{0.0, 0.0, 1.0, 1.0, 2.0, 2.0, 3.0, 3.0},
			"targetPumpFlow": []any{70.0, 70.0, 0.0, 0.0, 0.0, 0.0, 25.0, 25.0},
		},
	}
}

// TestExplainScoreReportsShotControl covers #2219: explain_score carries the
// control object for a Gaggiuino shot with an embedded profile (stop mode,
// free result, recipe and per-phase control) and for a shot classic cannot
// score at all, whose phases must still be an empty array.
func TestExplainScoreReportsShotControl(t *testing.T) {
	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 71, 1000, adaptiveShotData(), map[string]any{"coffee": "Alpha"})
	insertShot(t, sqlDB, 72, 1001, map[string]any{"datapoints": map[string]any{
		"pressure":   []any{0.0, 0.0},
		"timeInShot": []any{0.0, 10.0},
	}}, map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)

	out := structured(t, call(t, session, "explain_score", map[string]any{"id": 71}))
	control := object(out, "control")
	if control == nil {
		t.Fatalf("explain_score has no control object: %v", out)
	}
	if got, _ := control["source"].(string); got != "profile" {
		t.Errorf("source = %q, want profile", got)
	}
	if got, _ := control["stop_mode"].(string); got != "weight" {
		t.Errorf("stop_mode = %q, want weight", got)
	}
	if got := numberField(t, control, "stop_target"); got != 37 {
		t.Errorf("stop_target = %v, want 37", got)
	}
	if got, _ := control["stop_from"].(string); got != "global" {
		t.Errorf("stop_from = %q, want global", got)
	}
	if got, _ := control["free_result"].(string); got != "time" {
		t.Errorf("free_result = %q, want time", got)
	}
	recipe := object(control, "recipe")
	if got := numberField(t, recipe, "dose_g"); got != 15 {
		t.Errorf("recipe dose_g = %v, want 15", got)
	}
	if got := numberField(t, recipe, "yield_g"); got != 33 {
		t.Errorf("recipe yield_g = %v, want 33", got)
	}
	phases := objects(control, "phases")
	if len(phases) != 4 {
		t.Fatalf("got %d phases, want 4", len(phases))
	}
	p0, _ := phases[0].(map[string]any)
	if got, _ := p0["control"].(string); got != "flow" {
		t.Errorf("phase 0 control = %q, want flow", got)
	}
	if got, _ := p0["free"].(string); got != "pressure" {
		t.Errorf("phase 0 free = %q, want pressure", got)
	}
	if got := numberField(t, p0, "restriction"); got != 3 {
		t.Errorf("phase 0 restriction = %v, want 3", got)
	}
	p1, _ := phases[1].(map[string]any)
	if got, _ := p1["control"].(string); got != "pressure" {
		t.Errorf("phase 1 control = %q, want pressure", got)
	}
	if got := numberField(t, p1, "start_s"); got != 2 {
		t.Errorf("phase 1 start_s = %v, want 2", got)
	}

	out = structured(t, call(t, session, "explain_score", map[string]any{"id": 72}))
	control = object(out, "control")
	if control == nil {
		t.Fatalf("a shot classic cannot score has no control object: %v", out)
	}
	if got, _ := control["source"].(string); got != "none" {
		t.Errorf("source = %q, want none", got)
	}
	if got, _ := control["stop_mode"].(string); got != "none" {
		t.Errorf("stop_mode = %q, want none", got)
	}
	if got, _ := control["free_result"].(string); got != "unknown" {
		t.Errorf("free_result = %q, want unknown", got)
	}
	raw, ok := control["phases"].([]any)
	if !ok || len(raw) != 0 {
		t.Errorf("phases = %#v, want an empty array", control["phases"])
	}
}

// componentOf returns the named entry of an explain_score components array.
func componentOf(t *testing.T, out map[string]any, name string) map[string]any {
	t.Helper()
	for _, raw := range objects(out, "components") {
		c, _ := raw.(map[string]any)
		if c["name"] == name {
			return c
		}
	}
	t.Fatalf("no %q component in %v", name, out["components"])
	return nil
}

// skippedReason returns the skipped reason for the named part, or "" when the
// part is not listed as skipped.
func skippedReason(out map[string]any, name string) string {
	for _, raw := range objects(out, "skipped") {
		s, _ := raw.(map[string]any)
		if s["name"] == name {
			reason, _ := s["reason"].(string)
			return reason
		}
	}
	return ""
}

// TestExplainScoreAdherenceComponent covers #2186: with the adherence model
// active, explain_score lists its extra part with its inputs and reports the
// combined score for both the score and the adherence model entry.
func TestExplainScoreAdherenceComponent(t *testing.T) {
	t.Cleanup(shots.RegisterDevScoreModels())
	t.Cleanup(func() { shots.SetScoreModelSource(nil) })
	shots.SetScoreModelSource(func() string { return shots.AdherenceScoreModel })

	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 51, 1000, adherenceDatapoints(), map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)

	out := structured(t, call(t, session, "explain_score", map[string]any{"id": 51}))
	if got, _ := out["score_model"].(string); got != shots.AdherenceScoreModel {
		t.Fatalf("score_model = %q, want %q", got, shots.AdherenceScoreModel)
	}

	part := componentOf(t, out, shots.PressureAdherenceComponent)
	if got := numberField(t, part, "score"); got != 50 {
		t.Errorf("%s score = %v, want 50", shots.PressureAdherenceComponent, got)
	}
	if got := numberField(t, part, "weight"); got != 15 {
		t.Errorf("%s weight = %v, want 15", shots.PressureAdherenceComponent, got)
	}
	if got, _ := part["target"].(string); got != "profile" {
		t.Errorf("%s target = %q, want profile", shots.PressureAdherenceComponent, got)
	}
	inputs := object(part, "inputs")
	if got := numberField(t, inputs, "pressure_mae_bar"); math.Abs(got-1.5) > 1e-9 {
		t.Errorf("pressure_mae_bar = %v, want 1.5", got)
	}
	if got := numberField(t, inputs, "samples"); got != 5 {
		t.Errorf("samples = %v, want 5", got)
	}

	shareSum := 0.0
	for _, raw := range objects(out, "components") {
		c, _ := raw.(map[string]any)
		shareSum += numberField(t, c, "weight_share")
	}
	if math.Abs(shareSum-1) > 1e-9 {
		t.Errorf("weight_share values sum to %v, want 1", shareSum)
	}
	if reason := skippedReason(out, shots.PressureAdherenceComponent); reason != "" {
		t.Errorf("%s listed as skipped (%q) although it scored", shots.PressureAdherenceComponent, reason)
	}

	scores := modelScoresOf(t, out)
	if len(scores) != 2 || scores[0].Model != shots.ClassicScoreModel || scores[1].Model != shots.AdherenceScoreModel {
		t.Fatalf("model_scores = %+v, want classic then adherence", scores)
	}
	shown := int(numberField(t, out, "score"))
	if scores[1].Score == nil || *scores[1].Score != shown {
		t.Fatalf("adherence model score = %v, want the shown score %d", scores[1].Score, shown)
	}
}

// TestExplainScoreAdherenceNotApplicable covers #2186's other half: a shot with
// no target pressure data gets classic's ScoreDetail from the adherence model,
// so explain_score labels the part as skipped instead of listing it.
func TestExplainScoreAdherenceNotApplicable(t *testing.T) {
	t.Cleanup(shots.RegisterDevScoreModels())
	t.Cleanup(func() { shots.SetScoreModelSource(nil) })
	shots.SetScoreModelSource(func() string { return shots.AdherenceScoreModel })

	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 52, 1000, scoreableDatapoints(), map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)

	out := structured(t, call(t, session, "explain_score", map[string]any{"id": 52}))
	for _, raw := range objects(out, "components") {
		c, _ := raw.(map[string]any)
		if c["name"] == shots.PressureAdherenceComponent {
			t.Fatalf("%s listed as a component for a shot without target data", shots.PressureAdherenceComponent)
		}
	}
	if reason := skippedReason(out, shots.PressureAdherenceComponent); reason == "" {
		t.Fatalf("skipped has no %s entry with a reason: %v", shots.PressureAdherenceComponent, out["skipped"])
	}
	shown := int(numberField(t, out, "score"))
	for _, s := range modelScoresOf(t, out) {
		if s.Score == nil || *s.Score != shown {
			t.Fatalf("model %s score = %v, want the shown score %d (no target data means classic's result)", s.Model, s.Score, shown)
		}
	}

	// The reason is the adherence model's, not a generic one: with classic
	// active the same shot reports nothing about the part at all.
	shots.SetScoreModelSource(nil)
	out = structured(t, call(t, session, "explain_score", map[string]any{"id": 52}))
	if got, _ := out["score_model"].(string); got != shots.ClassicScoreModel {
		t.Fatalf("score_model = %q, want %q", got, shots.ClassicScoreModel)
	}
	if reason := skippedReason(out, shots.PressureAdherenceComponent); reason != "" {
		t.Errorf("classic reported the adherence part as skipped: %q", reason)
	}
}

// TestExportShotsDatasetListsAdherenceScore covers #2186's dataset half: every
// row carries both models side by side, the adherence score equals classic's
// on a shot without target data and is lower on one with it.
func TestExportShotsDatasetListsAdherenceScore(t *testing.T) {
	t.Cleanup(shots.RegisterDevScoreModels())
	t.Cleanup(func() { shots.SetScoreModelSource(nil) })
	shots.SetScoreModelSource(nil)

	ts, sqlDB := newDeveloperServer(t, true, false)
	insertShot(t, sqlDB, 61, 1000, adherenceDatapoints(), map[string]any{"coffee": "Alpha"})
	insertShot(t, sqlDB, 62, 1001, scoreableDatapoints(), map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)

	out := structured(t, call(t, session, "export_shots_dataset", map[string]any{}))
	if got, _ := out["score_model"].(string); got != shots.ClassicScoreModel {
		t.Fatalf("score_model = %q, want %q", got, shots.ClassicScoreModel)
	}

	rows := objects(out, "shots")
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	for _, raw := range rows {
		row, _ := raw.(map[string]any)
		id := numberField(t, row, "id")
		classic := int(numberField(t, row, "score"))
		scores := modelScoresOf(t, row)
		if len(scores) != 2 || scores[0].Model != shots.ClassicScoreModel || scores[1].Model != shots.AdherenceScoreModel {
			t.Fatalf("row %v model_scores = %+v, want classic then adherence", id, scores)
		}
		if scores[0].Score == nil || *scores[0].Score != classic {
			t.Fatalf("row %v classic model score = %v, want the row's score %d", id, scores[0].Score, classic)
		}
		if scores[1].Score == nil {
			t.Fatalf("row %v has no adherence score", id)
		}
		switch int(id) {
		case 62:
			if *scores[1].Score != classic {
				t.Errorf("row 62 (no target data) adherence score = %d, want classic's %d", *scores[1].Score, classic)
			}
		case 61:
			if *scores[1].Score >= classic {
				t.Errorf("row 61 (1.5 bar deviation) adherence score = %d, want lower than classic's %d", *scores[1].Score, classic)
			}
		}
	}
}
