package mcp

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

func newTestServer(t *testing.T) (*httptest.Server, *sql.DB) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	mux := http.NewServeMux()
	mux.Handle(Path, NewHandler(Deps{Shots: shots.NewService(shots.NewRepository(sqlDB)), Version: "test"}))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, sqlDB
}

func insertShot(t *testing.T, sqlDB *sql.DB, id, ts int64, data, annotation map[string]any) {
	t.Helper()
	if data == nil {
		data = map[string]any{}
	}
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal data: %v", err)
	}
	if _, err := sqlDB.Exec(`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,1)`, id, ts, nil, "Test Profile", string(b)); err != nil {
		t.Fatalf("insert shot %d: %v", id, err)
	}
	if annotation != nil {
		ab, err := json.Marshal(annotation)
		if err != nil {
			t.Fatalf("marshal annotation: %v", err)
		}
		if _, err := sqlDB.Exec(`INSERT INTO annotations (shot_id, data) VALUES (?,?)`, id, string(ab)); err != nil {
			t.Fatalf("insert annotation %d: %v", id, err)
		}
	}
}

func connect(t *testing.T, endpoint string) *mcpsdk.ClientSession {
	t.Helper()
	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "glp-test", Version: "0"}, nil)
	transport := &mcpsdk.StreamableClientTransport{Endpoint: endpoint, DisableStandaloneSSE: true}
	session, err := client.Connect(context.Background(), transport, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	return session
}

func call(t *testing.T, session *mcpsdk.ClientSession, name string, args map[string]any) *mcpsdk.CallToolResult {
	t.Helper()
	res, err := session.CallTool(context.Background(), &mcpsdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("CallTool %s: %v", name, err)
	}
	return res
}

func asMap(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return m
}

func structured(t *testing.T, res *mcpsdk.CallToolResult) map[string]any {
	t.Helper()
	return asMap(t, res.StructuredContent)
}

func objects(m map[string]any, key string) []any {
	v, _ := m[key].([]any)
	return v
}

func object(m map[string]any, key string) map[string]any {
	v, _ := m[key].(map[string]any)
	return v
}

func schemaProperty(t *testing.T, schema any, name string) map[string]any {
	t.Helper()
	props, _ := asMap(t, schema)["properties"].(map[string]any)
	p, _ := props[name].(map[string]any)
	if p == nil {
		t.Fatalf("schema has no property %q", name)
	}
	return p
}

func numberField(t *testing.T, m map[string]any, key string) float64 {
	t.Helper()
	v, ok := m[key].(float64)
	if !ok {
		t.Fatalf("field %q missing or not a number: %#v", key, m[key])
	}
	return v
}

func stringList(m map[string]any, key string) []string {
	raw, _ := m[key].([]any)
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		s, _ := v.(string)
		out = append(out, s)
	}
	return out
}

func TestListTools(t *testing.T) {
	ts, _ := newTestServer(t)
	session := connect(t, ts.URL+Path)
	res, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
		if tool.Annotations == nil {
			t.Fatalf("tool %s has no annotations", tool.Name)
		}
		if !tool.Annotations.ReadOnlyHint || !tool.Annotations.IdempotentHint {
			t.Fatalf("tool %s missing read-only/idempotent hints", tool.Name)
		}
		if tool.Annotations.OpenWorldHint == nil || *tool.Annotations.OpenWorldHint {
			t.Fatalf("tool %s should be closed-world", tool.Name)
		}
		if tool.OutputSchema == nil {
			t.Fatalf("tool %s has no output schema", tool.Name)
		}
	}
	want := []string{"compare_shots", "get_shot", "list_shots"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("tool order = %v, want %v", names, want)
	}
}

func TestListShotsPagingAndFilter(t *testing.T) {
	ts, sqlDB := newTestServer(t)
	insertShot(t, sqlDB, 1, 1000, nil, map[string]any{"coffee": "Alpha Blend"})
	insertShot(t, sqlDB, 2, 1001, nil, map[string]any{"coffee": "Beta Roast"})
	insertShot(t, sqlDB, 3, 1002, nil, map[string]any{"coffee": "Alpha Reserve"})
	session := connect(t, ts.URL+Path)

	first := structured(t, call(t, session, "list_shots", map[string]any{"limit": 2}))
	if got := len(objects(first, "shots")); got != 2 {
		t.Fatalf("first page = %d shots, want 2", got)
	}
	nextCursor, _ := first["next_cursor"].(string)
	if nextCursor == "" {
		t.Fatalf("expected a next_cursor")
	}
	second := structured(t, call(t, session, "list_shots", map[string]any{"limit": 2, "cursor": nextCursor}))
	if got := len(objects(second, "shots")); got != 1 {
		t.Fatalf("second page = %d shots, want 1", got)
	}
	filtered := structured(t, call(t, session, "list_shots", map[string]any{"bean": "alpha"}))
	if got := len(objects(filtered, "shots")); got != 2 {
		t.Fatalf("bean filter = %d shots, want 2", got)
	}
}

func TestGetShotUnknownID(t *testing.T) {
	ts, _ := newTestServer(t)
	session := connect(t, ts.URL+Path)
	res := call(t, session, "get_shot", map[string]any{"id": 424242})
	if !res.IsError {
		t.Fatalf("expected isError for unknown shot id")
	}
}

func TestGetShotCurveDownsampling(t *testing.T) {
	ts, sqlDB := newTestServer(t)
	times := make([]any, 0, 250)
	pressures := make([]any, 0, 250)
	for i := 0; i < 250; i++ {
		times = append(times, float64(i*4))
		pressures = append(pressures, float64(90))
	}
	datapoints := map[string]any{"timeInShot": times, "pressure": pressures}
	insertShot(t, sqlDB, 7, 1000, map[string]any{"datapoints": datapoints}, map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "get_shot", map[string]any{"id": 7, "include_curve": true, "curve_points": 50}))
	curve := object(out, "curve")
	if curve == nil {
		t.Fatalf("expected a curve")
	}
	if got := len(objects(curve, "time_s")); got != 50 {
		t.Fatalf("time samples = %d, want 50", got)
	}
	series := objects(curve, "series")
	if len(series) == 0 {
		t.Fatalf("expected at least one series")
	}
	for i, raw := range series {
		s, _ := raw.(map[string]any)
		if got := len(objects(s, "values")); got != 50 {
			t.Fatalf("series %d has %d samples, want 50", i, got)
		}
	}
}

func TestCompareShotsDeltas(t *testing.T) {
	ts, sqlDB := newTestServer(t)
	datapoints := map[string]any{"timeInShot": []any{float64(0), float64(40)}, "shotWeight": []any{float64(350), float64(360)}}
	data := map[string]any{"datapoints": datapoints}
	insertShot(t, sqlDB, 11, 1000, data, map[string]any{"coffee": "Alpha", "dose": float64(18), "rating": float64(4)})
	insertShot(t, sqlDB, 12, 1001, data, map[string]any{"coffee": "Alpha", "dose": float64(19), "rating": float64(3)})
	session := connect(t, ts.URL+Path)
	out := structured(t, call(t, session, "compare_shots", map[string]any{"ids": []int64{11, 12}}))
	if got := len(objects(out, "shots")); got != 2 {
		t.Fatalf("shots = %d, want 2", got)
	}
	if got := len(objects(out, "deltas")); got == 0 {
		t.Fatalf("expected per-metric deltas")
	}
}

func TestInputSchemaBounds(t *testing.T) {
	ts, _ := newTestServer(t)
	session := connect(t, ts.URL+Path)
	res, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	for _, tool := range res.Tools {
		switch tool.Name {
		case "list_shots":
			limit := schemaProperty(t, tool.InputSchema, "limit")
			if got := numberField(t, limit, "maximum"); got != 100 {
				t.Fatalf("list_shots limit maximum = %v, want 100", got)
			}
			if got := numberField(t, limit, "default"); got != 20 {
				t.Fatalf("list_shots limit default = %v, want 20", got)
			}
			rating := schemaProperty(t, tool.InputSchema, "min_rating")
			if got := numberField(t, rating, "maximum"); got != 5 {
				t.Fatalf("list_shots min_rating maximum = %v, want 5", got)
			}
		case "get_shot":
			curve := schemaProperty(t, tool.InputSchema, "curve_points")
			if got := numberField(t, curve, "minimum"); got != 20 {
				t.Fatalf("get_shot curve_points minimum = %v, want 20", got)
			}
			if got := numberField(t, curve, "maximum"); got != 500 {
				t.Fatalf("get_shot curve_points maximum = %v, want 500", got)
			}
			if got := numberField(t, curve, "default"); got != 100 {
				t.Fatalf("get_shot curve_points default = %v, want 100", got)
			}
			advice := schemaProperty(t, tool.OutputSchema, "comparative_grind_advice")
			typeProps, _ := advice["properties"].(map[string]any)
			typeSchema, _ := typeProps["type"].(map[string]any)
			if got := strings.Join(stringList(typeSchema, "enum"), ","); got != "finer,coarser,ok" {
				t.Fatalf("advice type enum = %v, want finer,coarser,ok", got)
			}
		case "compare_shots":
			ids := schemaProperty(t, tool.InputSchema, "ids")
			if got := numberField(t, ids, "minItems"); got != 2 {
				t.Fatalf("compare_shots ids minItems = %v, want 2", got)
			}
			if got := numberField(t, ids, "maxItems"); got != 5 {
				t.Fatalf("compare_shots ids maxItems = %v, want 5", got)
			}
		}
	}
}

func TestOutOfRangeInputIsError(t *testing.T) {
	ts, _ := newTestServer(t)
	session := connect(t, ts.URL+Path)
	if res := call(t, session, "list_shots", map[string]any{"limit": 500}); !res.IsError {
		t.Fatalf("expected isError for limit above the schema maximum")
	}
	if res := call(t, session, "get_shot", map[string]any{"id": 1, "curve_points": 5}); !res.IsError {
		t.Fatalf("expected isError for curve_points below the schema minimum")
	}
}

func TestTruncateKeepsValidUTF8(t *testing.T) {
	s := strings.Repeat("ä", 10)
	got := truncate(s, 5)
	if !utf8.ValidString(got) {
		t.Fatalf("truncate produced invalid UTF-8: %q", got)
	}
	if len(got) >= len(s) {
		t.Fatalf("expected truncation, got %q (len %d) from len %d", got, len(got), len(s))
	}
}
