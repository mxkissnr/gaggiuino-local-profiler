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

// newWriteServer mirrors newReadServer but wires the write tools' allow flag,
// so the same DB backs the handler and the assertions.
func newWriteServer(t *testing.T, allowWrite bool) (*httptest.Server, *sql.DB, *library.Repository, *maintenance.Repository, *machines.Registry) {
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
		Poller:      fakePoller{},
		Version:     "test",
		Settings:    settingsSource(true, allowWrite, false),
	}))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, sqlDB, libRepo, maintRepo, registry
}

func toolNames(t *testing.T, session *mcpsdk.ClientSession) []string {
	t.Helper()
	res, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	names := make([]string, 0, len(res.Tools))
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
	}
	return names
}

func listToolsByName(t *testing.T, session *mcpsdk.ClientSession) map[string]*mcpsdk.Tool {
	t.Helper()
	res, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	out := make(map[string]*mcpsdk.Tool, len(res.Tools))
	for _, tool := range res.Tools {
		out[tool.Name] = tool
	}
	return out
}

func errorText(t *testing.T, res *mcpsdk.CallToolResult) string {
	t.Helper()
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcpsdk.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String()
}

func checkWriteAnnotations(t *testing.T, tool *mcpsdk.Tool, idempotent bool) {
	t.Helper()
	if tool == nil {
		t.Fatalf("write tool is missing from tools/list")
	}
	a := tool.Annotations
	if a == nil {
		t.Fatalf("tool %s has no annotations", tool.Name)
	}
	if a.ReadOnlyHint {
		t.Fatalf("tool %s should not be read-only", tool.Name)
	}
	if a.OpenWorldHint == nil || *a.OpenWorldHint {
		t.Fatalf("tool %s should be closed-world", tool.Name)
	}
	if a.DestructiveHint == nil || *a.DestructiveHint {
		t.Fatalf("tool %s should be non-destructive", tool.Name)
	}
	if a.IdempotentHint != idempotent {
		t.Fatalf("tool %s idempotentHint = %v, want %v", tool.Name, a.IdempotentHint, idempotent)
	}
	if tool.OutputSchema == nil {
		t.Fatalf("tool %s has no output schema", tool.Name)
	}
}

func TestWriteToolsHiddenWithoutOptIn(t *testing.T) {
	ts, _, _, _, _ := newWriteServer(t, false)
	session := connect(t, ts.URL+Path)
	names := toolNames(t, session)
	want := "compare_shots,get_analytics_summary,get_library,get_machine_status,get_maintenance_status,get_shot,list_beans,list_shots"
	if got := strings.Join(names, ","); got != want {
		t.Fatalf("tool list = %v, want exactly the 8 read tools %v", names, want)
	}
	for _, name := range []string{"annotate_shot", "set_known_grind", "mark_maintenance_done"} {
		if strings.Contains(","+strings.Join(names, ",")+",", ","+name+",") {
			t.Fatalf("write tool %s is listed without the write opt-in", name)
		}
	}
}

func TestWriteToolsListedWithOptIn(t *testing.T) {
	ts, _, _, _, _ := newWriteServer(t, true)
	session := connect(t, ts.URL+Path)
	names := toolNames(t, session)
	if len(names) != 11 {
		t.Fatalf("tool count = %d, want 11", len(names))
	}
	// The SDK lists tools sorted by name (featureSet.all), so the write tools
	// interleave with the read tools rather than trailing them.
	want := "annotate_shot,compare_shots,get_analytics_summary,get_library,get_machine_status,get_maintenance_status,get_shot,list_beans,list_shots,mark_maintenance_done,set_known_grind"
	if got := strings.Join(names, ","); got != want {
		t.Fatalf("tool order = %v, want %v", names, want)
	}
	byName := listToolsByName(t, session)
	checkWriteAnnotations(t, byName["annotate_shot"], true)
	checkWriteAnnotations(t, byName["set_known_grind"], true)
	checkWriteAnnotations(t, byName["mark_maintenance_done"], false)

	// The task enum is derived from the maintenance package's static keys.
	task := schemaProperty(t, byName["mark_maintenance_done"].InputSchema, "task")
	if got := strings.Join(stringList(task, "enum"), ","); got != "backflush,descaling,gaskets,grouphead,waterfilter" {
		t.Fatalf("mark_maintenance_done task enum = %v", got)
	}
}

func TestAnnotateShotMergesAndKeepsForeignKeys(t *testing.T) {
	ts, sqlDB, _, _, _ := newWriteServer(t, true)
	insertShot(t, sqlDB, 21, 1000, nil, map[string]any{
		"coffee":    "Alpha",
		"rating":    float64(4),
		"beanId":    float64(7),
		"recipeId":  float64(3),
		"orderedBy": map[string]any{"customer": "Sam", "item": "Flat White"},
	})
	session := connect(t, ts.URL+Path)

	res := call(t, session, "annotate_shot", map[string]any{"id": 21, "notes": "bright", "grind_setting": "12.5"})
	if res.IsError {
		t.Fatalf("annotate_shot failed: %s", errorText(t, res))
	}
	out := structured(t, res)
	if got := numberField(t, out, "id"); got != 21 {
		t.Fatalf("output id = %v, want 21", got)
	}
	if notes, _ := out["notes"].(string); notes != "bright" {
		t.Fatalf("output notes = %v, want bright", out["notes"])
	}
	// rating was not passed, so the stored 4 is reported unchanged.
	if got := numberField(t, out, "rating"); got != 4 {
		t.Fatalf("output rating = %v, want 4", got)
	}

	ann, err := shots.NewRepository(sqlDB).GetAnnotation(21)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if notes, _ := ann["notes"].(string); notes != "bright" {
		t.Fatalf("stored notes = %v, want bright", ann["notes"])
	}
	if setting, _ := ann["grindSetting"].(string); setting != "12.5" {
		t.Fatalf("stored grindSetting = %v, want 12.5", ann["grindSetting"])
	}
	if rating, _ := ann["rating"].(float64); rating != 4 {
		t.Fatalf("stored rating = %v, want 4", ann["rating"])
	}
	// Keys the tool does not manage must survive the merge untouched.
	orderedBy, _ := ann["orderedBy"].(map[string]any)
	if orderedBy == nil || orderedBy["customer"] != "Sam" {
		t.Fatalf("orderedBy not preserved: %v", ann["orderedBy"])
	}
	if beanID, _ := ann["beanId"].(float64); beanID != 7 {
		t.Fatalf("beanId not preserved: %v", ann["beanId"])
	}
	if recipeID, _ := ann["recipeId"].(float64); recipeID != 3 {
		t.Fatalf("recipeId not preserved: %v", ann["recipeId"])
	}
}

func TestAnnotateShotErrors(t *testing.T) {
	ts, sqlDB, _, _, _ := newWriteServer(t, true)
	insertShot(t, sqlDB, 22, 1000, nil, map[string]any{"coffee": "Alpha"})
	session := connect(t, ts.URL+Path)

	if res := call(t, session, "annotate_shot", map[string]any{"id": 22}); !res.IsError {
		t.Fatalf("expected isError for an empty update")
	}
	for _, rating := range []int{0, 6} {
		if res := call(t, session, "annotate_shot", map[string]any{"id": 22, "rating": rating}); !res.IsError {
			t.Fatalf("expected isError for out-of-range rating %d", rating)
		}
	}
	res := call(t, session, "annotate_shot", map[string]any{"id": 424242, "rating": 3})
	if !res.IsError {
		t.Fatalf("expected isError for an unknown shot id")
	}
	if msg := errorText(t, res); !strings.Contains(msg, "not found; use list_shots") {
		t.Fatalf("unknown-shot error = %q, want it to mention list_shots", msg)
	}
}

func TestAnnotateShotRunsStockHook(t *testing.T) {
	ts, sqlDB, _, _, _ := newWriteServer(t, true)
	insertShot(t, sqlDB, 23, 1000, nil, map[string]any{"rating": float64(2)})
	var (
		calls int
		prev  map[string]any
		next  map[string]any
	)
	shots.SetAnnotationStockHook(func(p, n map[string]any) error {
		calls++
		prev, next = p, n
		return nil
	})
	t.Cleanup(func() { shots.SetAnnotationStockHook(nil) })
	session := connect(t, ts.URL+Path)
	res := call(t, session, "annotate_shot", map[string]any{"id": 23, "rating": 5})
	if res.IsError {
		t.Fatalf("annotate_shot failed: %s", errorText(t, res))
	}
	if calls != 1 {
		t.Fatalf("stock hook calls = %d, want 1", calls)
	}
	if prev["rating"] != float64(2) {
		t.Errorf("hook prev rating = %v, want 2", prev["rating"])
	}
	if next["rating"] != float64(5) {
		t.Errorf("hook next rating = %v, want 5", next["rating"])
	}
}

func TestSetKnownGrindUpsert(t *testing.T) {
	ts, _, libRepo, _, _ := newWriteServer(t, true)
	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	lib.Beans = []library.Entity{{"id": int64(1), "name": "Alpha", "enabled": true}}
	if err := libRepo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	session := connect(t, ts.URL+Path)

	res := call(t, session, "set_known_grind", map[string]any{"bean_id": 1, "grinder": "Niche", "grind_setting": "12"})
	if res.IsError {
		t.Fatalf("set_known_grind failed: %s", errorText(t, res))
	}
	settings := objects(structured(t, res), "known_grind_settings")
	if len(settings) != 1 {
		t.Fatalf("known_grind_settings = %d, want 1", len(settings))
	}
	first, _ := settings[0].(map[string]any)
	if grinder, _ := first["grinder"].(string); grinder != "Niche" {
		t.Fatalf("grinder = %v, want Niche", first["grinder"])
	}
	if setting, _ := first["grind_setting"].(string); setting != "12" {
		t.Fatalf("grind_setting = %v, want 12", first["grind_setting"])
	}

	// Same grinder, different casing: overwrite the entry, do not duplicate it.
	res = call(t, session, "set_known_grind", map[string]any{"bean_id": 1, "grinder": "niche", "grind_setting": "14"})
	if res.IsError {
		t.Fatalf("set_known_grind overwrite failed: %s", errorText(t, res))
	}
	settings = objects(structured(t, res), "known_grind_settings")
	if len(settings) != 1 {
		t.Fatalf("known_grind_settings after overwrite = %d, want 1", len(settings))
	}
	second, _ := settings[0].(map[string]any)
	if setting, _ := second["grind_setting"].(string); setting != "14" {
		t.Fatalf("grind_setting after overwrite = %v, want 14", second["grind_setting"])
	}

	if res := call(t, session, "set_known_grind", map[string]any{"bean_id": 999, "grinder": "Niche", "grind_setting": "12"}); !res.IsError {
		t.Fatalf("expected isError for an unknown bean")
	}
}

func TestMarkMaintenanceDoneLogsAndRejectsUnknownTask(t *testing.T) {
	ts, _, _, maintRepo, registry := newWriteServer(t, true)
	if err := registry.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	defaultMachine, err := registry.GetDefaultMachine()
	if err != nil || defaultMachine == nil {
		t.Fatalf("GetDefaultMachine: %v", err)
	}
	session := connect(t, ts.URL+Path)

	res := call(t, session, "mark_maintenance_done", map[string]any{"task": "descaling", "notes": "integration test"})
	if res.IsError {
		t.Fatalf("mark_maintenance_done failed: %s", errorText(t, res))
	}
	out := structured(t, res)
	if task, _ := out["task"].(string); task != "descaling" {
		t.Fatalf("task = %v, want descaling", out["task"])
	}
	if status, _ := out["status"].(string); status != "ok" {
		t.Fatalf("status = %v, want ok right after marking done", out["status"])
	}

	logs, err := maintRepo.GetMaintenanceLog(defaultMachine.ID)
	if err != nil {
		t.Fatalf("GetMaintenanceLog: %v", err)
	}
	found := false
	for _, entry := range logs {
		if entry.Task == "descaling" && entry.Notes == "integration test" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("no maintenance_log entry for descaling: %+v", logs)
	}

	if res := call(t, session, "mark_maintenance_done", map[string]any{"task": "bogus"}); !res.IsError {
		t.Fatalf("expected isError for an unknown task")
	}
}
