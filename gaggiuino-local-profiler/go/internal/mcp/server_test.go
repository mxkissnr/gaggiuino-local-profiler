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
	session, err := client.Connect(context.Background(), &mcpsdk.StreamableClientTransport{
		Endpoint:             endpoint,
		DisableStandaloneSSE: true,
	}, nil)
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

func structured[T any](t *testing.T, res *mcpsdk.CallToolResult) T {
	t.Helper()
	var out T
	b, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatalf("marshal structured content: %v", err)
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal structured content: %v", err)
	}
	return out
}

type listOut struct {
	Shots      []map[string]any `json:"shots"`
	NextCursor string           `json:"next_cursor"`
}

type getOut struct {
	ID    int64 `json:"id"`
	Curve *struct {
		Points int       `json:"points"`
		TimeS  []float64 `json:"time_s"`
		Series []struct {
			Name   string    `json:"name"`
			Values []float64 `json:"values"`
		} `json:"series"`
	} `json:"curve"`
}

type cmpOut struct {
	Shots  []map[string]any `json:"shots"`
	Deltas []struct {
		ShotID int64   `json:"shot_id"`
		Metric string  `json:"metric"`
		Delta  float64 `json:"delta"`
	} `json:"deltas"`
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
	// The SDK registry lists tools sorted by name (featureSet.all in the
	// SDK's features.go), not in registration order; that ordering is still
	// deterministic.
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

	first := structured[listOut](t, call(t, session, "list_shots", map[string]any{"limit": 2}))
	if len(first.Shots) != 2 {
		t.Fatalf("first page = %d shots, want 2", len(first.Shots))
	}
	if first.NextCursor == "" {
		t.Fatalf("expected a next_cursor")
	}
	second := structured[listOut](t, call(t, session, "list_shots", map[string]any{"limit": 2, "cursor": first.NextCursor}))
	if len(second.Shots) != 1 {
		t.Fatalf("second page = %d shots, want 1", len(second.Shots))
	}

	filtered := structured[listOut](t, call(t, session, "list_shots", map[string]any{"bean": "alpha"}))
	if len(filtered.Shots) != 2 {
		t.Fatalf("bean filter = %d shots, want 2", len(filtered.Shots))
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
	insertShot(t, sqlDB, 7, 1000, map[string]any{"datapoints": map[string]any{
		"timeInShot": times,
		"pressure":   pressures,
	}}, map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)
	out := structured[getOut](t, call(t, session, "get_shot", map[string]any{"id": 7, "include_curve": true, "curve_points": 50}))
	if out.Curve == nil {
		t.Fatalf("expected a curve")
	}
	if len(out.Curve.TimeS) != 50 {
		t.Fatalf("time samples = %d, want 50", len(out.Curve.TimeS))
	}
	if len(out.Curve.Series) == 0 {
		t.Fatalf("expected at least one series")
	}
	for _, s := range out.Curve.Series {
		if len(s.Values) != 50 {
			t.Fatalf("series %s has %d samples, want 50", s.Name, len(s.Values))
		}
	}
}

func TestCompareShotsDeltas(t *testing.T) {
	ts, sqlDB := newTestServer(t)
	// Series live under the shot data blob's nested "datapoints" object —
	// that is the shape hydrateRow keeps as raw JSON and shots.DatapointsMap reads.
	data := map[string]any{"datapoints": map[string]any{
		"timeInShot": []any{float64(0), float64(40)},
		"shotWeight": []any{float64(350), float64(360)},
	}}
	insertShot(t, sqlDB, 11, 1000, data, map[string]any{"coffee": "Alpha", "dose": float64(18), "rating": float64(4)})
	insertShot(t, sqlDB, 12, 1001, data, map[string]any{"coffee": "Alpha", "dose": float64(19), "rating": float64(3)})
	session := connect(t, ts.URL+Path)
	out := structured[cmpOut](t, call(t, session, "compare_shots", map[string]any{"ids": []int64{11, 12}}))
	if len(out.Shots) != 2 {
		t.Fatalf("shots = %d, want 2", len(out.Shots))
	}
	if len(out.Deltas) == 0 {
		t.Fatalf("expected per-metric deltas")
	}
}

func TestForeignOriginRejected(t *testing.T) {
	ts, _ := newTestServer(t)
	req, err := http.NewRequest(http.MethodPost, ts.URL+Path, strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Origin", "http://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}


func mustUnmarshal(t *testing.T, v any, out any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal schema: %v", err)
	}
	if err := json.Unmarshal(b, out); err != nil {
		t.Fatalf("unmarshal schema: %v", err)
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
			var schema struct {
				Properties map[string]struct {
					Maximum *float64 `json:"maximum"`
					Default *float64 `json:"default"`
				} `json:"properties"`
			}
			mustUnmarshal(t, tool.InputSchema, &schema)
			if p := schema.Properties["limit"]; p.Maximum == nil || *p.Maximum != 100 || p.Default == nil || *p.Default != 20 {
				t.Fatalf("list_shots limit schema = %+v, want maximum 100 default 20", p)
			}
		case "get_shot":
			var in struct {
				Properties map[string]struct {
					Minimum *float64 `json:"minimum"`
					Maximum *float64 `json:"maximum"`
					Default *float64 `json:"default"`
				} `json:"properties"`
			}
			mustUnmarshal(t, tool.InputSchema, &in)
			if p := in.Properties["curve_points"]; p.Minimum == nil || *p.Minimum != 20 || p.Maximum == nil || *p.Maximum != 500 || p.Default == nil || *p.Default != 100 {
				t.Fatalf("get_shot curve_points schema = %+v, want 20..500 default 100", p)
			}
			var out struct {
				Properties map[string]struct {
					Properties map[string]struct {
						Enum []string `json:"enum"`
					} `json:"properties"`
				} `json:"properties"`
			}
			mustUnmarshal(t, tool.OutputSchema, &out)
			enum := out.Properties["comparative_grind_advice"].Properties["type"].Enum
			if strings.Join(enum, ",") != "finer,coarser,ok" {
				t.Fatalf("advice type enum = %v, want [finer coarser ok]", enum)
			}
		case "compare_shots":
			var schema struct {
				Properties map[string]struct {
					MinItems *int `json:"minItems"`
					MaxItems *int `json:"maxItems"`
				} `json:"properties"`
			}
			mustUnmarshal(t, tool.InputSchema, &schema)
			if p := schema.Properties["ids"]; p.MinItems == nil || *p.MinItems != 2 || p.MaxItems == nil || *p.MaxItems != 5 {
				t.Fatalf("compare_shots ids schema = %+v, want minItems 2 maxItems 5", p)
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
