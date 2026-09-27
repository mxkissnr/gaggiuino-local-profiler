package mcp

import (
	"context"
	"database/sql"
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
	if strings.Contains(","+strings.Join(names, ",")+",", ",get_shot_raw,") {
		t.Fatalf("get_shot_raw is listed without the developer-tools opt-in: %v", names)
	}
	// An unregistered tool must not be callable either: the SDK either rejects
	// the call outright or returns a tool error.
	res, err := session.CallTool(context.Background(), &mcpsdk.CallToolParams{Name: "get_shot_raw", Arguments: map[string]any{"id": 1}})
	if err == nil && (res == nil || !res.IsError) {
		t.Fatalf("get_shot_raw is callable without the developer-tools opt-in")
	}
}

func TestDeveloperToolsListedWithOptIn(t *testing.T) {
	ts, _ := newDeveloperServer(t, true, false)
	session := connect(t, ts.URL+Path)
	tool := listToolsByName(t, session)["get_shot_raw"]
	if tool == nil {
		t.Fatalf("get_shot_raw is missing from tools/list with the opt-in")
	}
	a := tool.Annotations
	if a == nil || !a.ReadOnlyHint || !a.IdempotentHint {
		t.Fatalf("get_shot_raw should be read-only and idempotent")
	}
	if a.OpenWorldHint == nil || *a.OpenWorldHint {
		t.Fatalf("get_shot_raw should be closed-world")
	}
	if tool.OutputSchema == nil {
		t.Fatalf("get_shot_raw has no output schema")
	}
	if min, _ := schemaProperty(t, tool.InputSchema, "id")["minimum"].(float64); min != 1 {
		t.Fatalf("get_shot_raw id minimum = %v, want 1", schemaProperty(t, tool.InputSchema, "id")["minimum"])
	}
}

func TestDeveloperToolsKeepWriteTools(t *testing.T) {
	ts, _ := newDeveloperServer(t, true, true)
	session := connect(t, ts.URL+Path)
	// The SDK lists tools sorted by name, so the write tools interleave rather
	// than trail; the invariant is that adding the developer tool leaves every
	// read and write tool registered.
	names := toolNames(t, session)
	want := "annotate_shot,compare_shots,get_analytics_summary,get_library,get_machine_status,get_maintenance_status,get_shot,get_shot_raw,list_beans,list_shots,mark_maintenance_done,set_known_grind"
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
