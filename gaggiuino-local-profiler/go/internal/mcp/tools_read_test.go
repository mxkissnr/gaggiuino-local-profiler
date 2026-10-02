package mcp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/system"
)

type fakePoller struct {
	reachable   *bool
	lastErr     *string
	lastSuccess *int64
	version     *string
	ready       bool
	remaining   int
}

func (f fakePoller) StatusInfo() system.StatusInfo {
	return system.StatusInfo{
		MachineReachable:     f.reachable,
		LastMachineError:     f.lastErr,
		LastMachineSuccess:   f.lastSuccess,
		CachedMachineVersion: f.version,
	}
}

func (f fakePoller) PreheatInfo() (bool, int) { return f.ready, f.remaining }

func newReadServer(t *testing.T, poller MachineStatus) (*httptest.Server, *library.Repository, *maintenance.Repository, *machines.Registry) {
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
		Version:     "test",
		Settings:    settingsSource(true, false, false),
	}))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, libRepo, maintRepo, registry
}

func strptr(s string) *string { return &s }
func boolptr(b bool) *bool    { return &b }

func TestReadToolsListed(t *testing.T) {
	ts, _, _, _ := newReadServer(t, fakePoller{})
	session := connect(t, ts.URL+Path)
	res, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	names := make([]string, 0, len(res.Tools))
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
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
	want := "compare_shots,get_analytics_summary,get_library,get_machine_status,get_maintenance_status,get_shot,list_beans,list_shots"
	if got := strings.Join(names, ","); got != want {
		t.Fatalf("tool order = %v, want %v", names, want)
	}
}

func TestReadToolSchemas(t *testing.T) {
	ts, _, _, _ := newReadServer(t, fakePoller{})
	session := connect(t, ts.URL+Path)
	res, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	for _, tool := range res.Tools {
		switch tool.Name {
		case "list_beans":
			limit := schemaProperty(t, tool.InputSchema, "limit")
			if got := numberField(t, limit, "maximum"); got != 100 {
				t.Fatalf("list_beans limit maximum = %v, want 100", got)
			}
			if got := numberField(t, limit, "default"); got != 20 {
				t.Fatalf("list_beans limit default = %v, want 20", got)
			}
			active := schemaProperty(t, tool.InputSchema, "active_only")
			if active["default"] != true {
				t.Fatalf("list_beans active_only default = %v, want true", active["default"])
			}
		case "get_library":
			section := schemaProperty(t, tool.InputSchema, "section")
			if got := strings.Join(stringList(section, "enum"), ","); got != "grinders,baskets,puck_screens,milks,recipes" {
				t.Fatalf("get_library section enum = %v", got)
			}
		}
	}
}

func TestListBeansFilterAndPaging(t *testing.T) {
	ts, libRepo, _, _ := newReadServer(t, fakePoller{})
	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	lib.Beans = []library.Entity{
		{"id": int64(1), "name": "Alpha", "roaster": "Acme", "origin": "ET", "enabled": true, "stock_g": float64(100), "bags": []any{map[string]any{"stock_g": float64(100)}}},
		{"id": int64(2), "name": "Beta", "roaster": "Brew", "origin": "BR", "enabled": false},
		{"id": int64(3), "name": "Gamma", "roaster": "Acme", "origin": "CO", "enabled": true},
	}
	if err := libRepo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	session := connect(t, ts.URL+Path)

	// active_only defaults to true.
	out := structured(t, call(t, session, "list_beans", map[string]any{}))
	if got := len(objects(out, "beans")); got != 2 {
		t.Fatalf("default list_beans = %d beans, want 2 (active only)", got)
	}

	// Query matches roaster as well as name.
	filtered := structured(t, call(t, session, "list_beans", map[string]any{"query": "acme"}))
	if got := len(objects(filtered, "beans")); got != 2 {
		t.Fatalf("query=acme = %d beans, want 2", got)
	}

	// Disabled beans included when asked.
	all := structured(t, call(t, session, "list_beans", map[string]any{"active_only": false}))
	if got := len(objects(all, "beans")); got != 3 {
		t.Fatalf("active_only=false = %d beans, want 3", got)
	}

	// Paging over the full set.
	first := structured(t, call(t, session, "list_beans", map[string]any{"limit": 1, "active_only": false}))
	if got := len(objects(first, "beans")); got != 1 {
		t.Fatalf("first page = %d beans, want 1", got)
	}
	cursor, _ := first["next_cursor"].(string)
	if cursor == "" {
		t.Fatalf("expected a next_cursor")
	}
	second := structured(t, call(t, session, "list_beans", map[string]any{"limit": 1, "active_only": false, "cursor": cursor}))
	beans := objects(second, "beans")
	if len(beans) != 1 {
		t.Fatalf("second page = %d beans, want 1", len(beans))
	}
	secondBean := beans[0].(map[string]any)
	if name, _ := secondBean["name"].(string); name != "Beta" {
		t.Fatalf("second page bean = %v, want Beta (name order)", name)
	}

	// Stock-tracked bean reports its remaining grams.
	alpha := findBean(objects(all, "beans"), "Alpha")
	if alpha == nil {
		t.Fatalf("Alpha not found in bean list")
	}
	if got := numberField(t, alpha, "remaining_g"); got != 100 {
		t.Fatalf("Alpha remaining_g = %v, want 100", got)
	}
}

func findBean(beans []any, name string) map[string]any {
	for _, raw := range beans {
		b, _ := raw.(map[string]any)
		if n, _ := b["name"].(string); n == name {
			return b
		}
	}
	return nil
}

func TestGetLibrarySection(t *testing.T) {
	ts, libRepo, _, _ := newReadServer(t, fakePoller{})
	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	lib.Grinders = []library.Entity{{
		"id": int64(1), "name": "Niche", "burrType": "conical",
		"zeroPointHistory": []any{map[string]any{"zeroPoint": float64(4.5), "since": int64(100)}},
	}}
	lib.Baskets = []library.Entity{{"id": int64(2), "name": "18g", "wallType": "straight"}}
	lib.Milks = []library.Entity{{"id": int64(3), "name": "Oat", "stockMl": float64(750)}}
	lib.Recipes = []library.Entity{{"id": int64(4), "name": "Flat White", "brewMethod": "espresso"}}
	if err := libRepo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	session := connect(t, ts.URL+Path)

	only := structured(t, call(t, session, "get_library", map[string]any{"section": "grinders"}))
	grinders := objects(only, "grinders")
	if len(grinders) != 1 {
		t.Fatalf("grinders = %d, want 1", len(grinders))
	}
	if got := len(objects(only, "baskets")); got != 0 {
		t.Fatalf("section=grinders returned %d baskets, want 0", got)
	}
	g := grinders[0].(map[string]any)
	if got := numberField(t, g, "zero_point"); got != 4.5 {
		t.Fatalf("grinder zero_point = %v, want 4.5", got)
	}

	full := structured(t, call(t, session, "get_library", map[string]any{}))
	if got := len(objects(full, "baskets")); got != 1 {
		t.Fatalf("full get_library baskets = %d, want 1", got)
	}
	if got := len(objects(full, "milks")); got != 1 {
		t.Fatalf("full get_library milks = %d, want 1", got)
	}
	if got := len(objects(full, "recipes")); got != 1 {
		t.Fatalf("full get_library recipes = %d, want 1", got)
	}

	// Unknown section is a tool error, not a silent empty result.
	if res := call(t, session, "get_library", map[string]any{"section": "spoons"}); !res.IsError {
		t.Fatalf("expected isError for unknown section")
	}
}

func TestGetMachineStatusFakePoller(t *testing.T) {
	lastSuccess := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC).UnixMilli()
	poller := fakePoller{
		reachable:   boolptr(true),
		version:     strptr("1.2.3"),
		lastSuccess: &lastSuccess,
		ready:       true,
		remaining:   7,
	}
	ts, _, _, registry := newReadServer(t, poller)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	session := connect(t, ts.URL+Path)

	out := structured(t, call(t, session, "get_machine_status", map[string]any{}))
	machines := objects(out, "machines")
	if len(machines) != 1 {
		t.Fatalf("machines = %d, want 1", len(machines))
	}
	m := machines[0].(map[string]any)
	if name, _ := m["name"].(string); name != "Gaggiuino" {
		t.Fatalf("machine name = %v, want Gaggiuino", m["name"])
	}
	if reachable, _ := m["reachable"].(bool); !reachable {
		t.Fatalf("machine should be reachable")
	}
	if ver, _ := m["firmware_version"].(string); ver != "1.2.3" {
		t.Fatalf("firmware_version = %v, want 1.2.3", m["firmware_version"])
	}
	if success, _ := m["last_success"].(string); success != "2026-01-02T03:04:05Z" {
		t.Fatalf("last_success = %v, want RFC 3339", m["last_success"])
	}
	if ready, _ := m["preheat_ready"].(bool); !ready {
		t.Fatalf("preheat_ready = %v, want true", m["preheat_ready"])
	}
	if got := numberField(t, m, "preheat_remaining_min"); got != 7 {
		t.Fatalf("preheat_remaining_min = %v, want 7", got)
	}

	if res := call(t, session, "get_machine_status", map[string]any{"machine_id": 4242}); !res.IsError {
		t.Fatalf("expected isError for unknown machine id")
	}
}

func TestGetMaintenanceStatus(t *testing.T) {
	ts, _, _, registry := newReadServer(t, fakePoller{})
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	session := connect(t, ts.URL+Path)

	out := structured(t, call(t, session, "get_maintenance_status", map[string]any{}))
	if got := len(objects(out, "machines")); got == 0 {
		t.Fatalf("expected at least one machine's maintenance tasks")
	}
	global := objects(out, "global")
	if !hasTask(global, "waterfilter") {
		t.Fatalf("expected the global waterfilter task, got %v", global)
	}

	single := structured(t, call(t, session, "get_maintenance_status", map[string]any{"machine_id": 1}))
	if got := len(objects(single, "machines")); got != 1 {
		t.Fatalf("machine_id=1 returned %d machines, want 1", got)
	}
	if got := len(objects(single, "global")); got == 0 {
		t.Fatalf("machine_id=1 should still report the global tasks")
	}

	if res := call(t, session, "get_maintenance_status", map[string]any{"machine_id": 999}); !res.IsError {
		t.Fatalf("expected isError for unknown machine id")
	}
}

func hasTask(tasks []any, name string) bool {
	for _, raw := range tasks {
		m, _ := raw.(map[string]any)
		if t, _ := m["task"].(string); t == name {
			return true
		}
	}
	return false
}

func TestAggregateAnalytics(t *testing.T) {
	// 2026-01-05 is a Monday; +2d stays in the same ISO week, +8d moves to
	// the next one.
	monday := time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC).Unix()
	day := int64(86400)
	samples := []analyticsSample{
		{Timestamp: monday, Score: intptr(80), Rating: intptr(4), Ratio: floatptr(2.0), DurationS: floatptr(30), Bean: "Alpha"},
		{Timestamp: monday + day, Score: intptr(90), Rating: intptr(5), Ratio: floatptr(2.5), DurationS: floatptr(28), Bean: "Alpha"},
		{Timestamp: monday + 2*day, Score: intptr(70), Bean: "Beta"},
		{Timestamp: monday + 8*day, Score: intptr(60), Bean: "Beta"},
		{Timestamp: monday - 100, Score: intptr(10), Bean: "Ignored"},
	}
	out := aggregateAnalytics(samples, monday, monday+10*day)

	if out.ShotCount != 4 {
		t.Fatalf("shot_count = %d, want 4", out.ShotCount)
	}
	if out.AverageScore == nil || *out.AverageScore != 75 {
		t.Fatalf("average_score = %v, want 75", out.AverageScore)
	}
	if out.MedianScore == nil || *out.MedianScore != 75 {
		t.Fatalf("median_score = %v, want 75", out.MedianScore)
	}
	if out.AverageRating == nil || *out.AverageRating != 4.5 {
		t.Fatalf("average_rating = %v, want 4.5", out.AverageRating)
	}
	if out.AverageRatio == nil || *out.AverageRatio != 2.25 {
		t.Fatalf("average_ratio = %v, want 2.25", out.AverageRatio)
	}
	if out.AverageDurationS == nil || *out.AverageDurationS != 29 {
		t.Fatalf("average_duration_s = %v, want 29", out.AverageDurationS)
	}
	if len(out.TopBeans) != 2 {
		t.Fatalf("top_beans = %d, want 2", len(out.TopBeans))
	}
	if out.TopBeans[0].Bean != "Alpha" || out.TopBeans[0].Shots != 2 || *out.TopBeans[0].AverageScore != 85 {
		t.Fatalf("top bean[0] = %+v, want Alpha 2 shots avg 85", out.TopBeans[0])
	}
	if out.TopBeans[1].Bean != "Beta" || *out.TopBeans[1].AverageScore != 65 {
		t.Fatalf("top bean[1] = %+v, want Beta avg 65", out.TopBeans[1])
	}
	if len(out.Weekly) != 2 {
		t.Fatalf("weekly = %d weeks, want 2", len(out.Weekly))
	}
	if out.Weekly[0].WeekStart != "2026-01-05" || out.Weekly[0].Shots != 3 || *out.Weekly[0].AverageScore != 80 {
		t.Fatalf("week[0] = %+v, want 2026-01-05 3 shots avg 80", out.Weekly[0])
	}
	if out.Weekly[1].WeekStart != "2026-01-12" || out.Weekly[1].Shots != 1 {
		t.Fatalf("week[1] = %+v, want 2026-01-12 1 shot", out.Weekly[1])
	}
}

func intptr(v int) *int           { return &v }
func floatptr(v float64) *float64 { return &v }
