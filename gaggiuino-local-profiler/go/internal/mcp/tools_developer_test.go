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

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newDeveloperServer mirrors newWriteServer but also wires the developer-tools
// opt-in, so a test can flip either flag independently.
func newDeveloperServer(t *testing.T, allowDeveloper, allowWrite bool) (*httptest.Server, *sql.DB) {
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
		Poller:              fakePoller{},
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
	for _, name := range []string{"get_shot_raw", "explain_score"} {
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
	want := "annotate_shot,compare_shots,explain_score,get_analytics_summary,get_library,get_machine_status,get_maintenance_status,get_shot,get_shot_raw,list_beans,list_shots,mark_maintenance_done,set_known_grind"
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
