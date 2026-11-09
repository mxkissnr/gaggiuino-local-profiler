package maintenance

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file pins the pause feature: a paused task reports status "paused"
// instead of due/soon/ok/never, and its day count leaves the paused time out.

const dayMs = 24 * 60 * 60 * 1000

// ago returns now minus d days. Fractional days keep the floor-division day
// counts below stable: a whole-day offset would land exactly on a boundary and
// a millisecond of test execution could shift the result by one day.
func ago(d float64) time.Time {
	return time.Now().Add(-time.Duration(d * float64(24*time.Hour)))
}

// pauseFixture stores a descaling task last done 100 days ago, so the
// default 60-day threshold makes it due when unpaused.
func pauseFixture(t *testing.T, repo *Repository) time.Time {
	t.Helper()
	last := ago(100.5)
	if err := repo.SaveTask(1, "descaling", Task{"lastDate": isoTS(last), "threshold_days": int64(60)}); err != nil {
		t.Fatalf("SaveTask descaling: %v", err)
	}
	return last
}

func getStat(t *testing.T, mux *http.ServeMux, path, key string) map[string]any {
	t.Helper()
	rec := doJSON(t, mux, http.MethodGet, path, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s status = %d; body=%s", path, rec.Code, rec.Body.String())
	}
	task, ok := decodeBody(t, rec.Body.Bytes())[key].(map[string]any)
	if !ok {
		t.Fatalf("GET %s: %q missing from body=%s", path, key, rec.Body.String())
	}
	return task
}

func statNumber(t *testing.T, task map[string]any, key string) float64 {
	t.Helper()
	v, ok := task[key].(float64)
	if !ok {
		t.Fatalf("%q = %v (%T), want a number", key, task[key], task[key])
	}
	return v
}

func wantStatDaysSince(t *testing.T, task map[string]any, want float64) {
	t.Helper()
	if got := statNumber(t, task, "daysSince"); got != want {
		t.Errorf("daysSince = %v, want %v", got, want)
	}
}

func wantStatStatus(t *testing.T, task map[string]any, want string) {
	t.Helper()
	if got, _ := task["status"].(string); got != want {
		t.Errorf("status = %q, want %q", got, want)
	}
}

func seedPauseShots(t *testing.T, shotsRepo *shots.Repository, after time.Time, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		shot := shots.Shot{}
		shot["id"] = int64(9000 + i)
		shot["timestamp"] = after.Add(time.Duration(i+1) * time.Hour).Unix()
		shot["machineId"] = int64(1)
		if err := shotsRepo.Upsert(shot); err != nil {
			t.Fatalf("Upsert shot %d: %v", i, err)
		}
	}
}

// TestPause_ChangesComputedStatus is the behaviour proof: pausing a due task
// makes GET report "paused", resuming makes it due again.
func TestPause_ChangesComputedStatus(t *testing.T) {
	h, repo, _, _ := newTestHandlers(t)
	mux := newMux(h)
	pauseFixture(t, repo)

	before := getStat(t, mux, "/api/maintenance", "descaling")
	wantStatStatus(t, before, "due")
	wantStatDaysSince(t, before, 100)

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/descaling/threshold",
		mustMarshal(t, map[string]any{"paused": true}))
	if rec.Code != http.StatusOK {
		t.Fatalf("pause status = %d; body=%s", rec.Code, rec.Body.String())
	}
	paused, _ := decodeBody(t, rec.Body.Bytes())["descaling"].(map[string]any)
	wantStatStatus(t, paused, "paused")

	wantStatStatus(t, getStat(t, mux, "/api/maintenance", "descaling"), "paused")

	rec = doJSON(t, mux, http.MethodPost, "/api/maintenance/descaling/threshold",
		mustMarshal(t, map[string]any{"paused": false}))
	if rec.Code != http.StatusOK {
		t.Fatalf("resume status = %d; body=%s", rec.Code, rec.Body.String())
	}
	resumed, _ := decodeBody(t, rec.Body.Bytes())["descaling"].(map[string]any)
	wantStatStatus(t, resumed, "due")
	wantStatDaysSince(t, resumed, 100)
}

// TestPause_RunningPauseExcludedFromDays: a pause that started 60 days after
// the last completion already subtracts those 60 days, although it is still
// running.
func TestPause_RunningPauseExcludedFromDays(t *testing.T) {
	h, repo, _, _ := newTestHandlers(t)
	mux := newMux(h)
	pauseFixture(t, repo)
	if err := repo.SaveTask(1, "descaling", Task{"pausedAt": ago(60).UnixMilli()}); err != nil {
		t.Fatalf("SaveTask pausedAt: %v", err)
	}

	task := getStat(t, mux, "/api/maintenance", "descaling")
	wantStatStatus(t, task, "paused")
	wantStatDaysSince(t, task, 40)
	if got := statNumber(t, task, "pct"); got < 0.66 || got > 0.67 {
		t.Errorf("pct = %v, want about 0.667", got)
	}
}

// TestResume_ExcludesPauseFromElapsedDays: resuming folds the pause into
// pausedMs, so the day count stays 40 and the task is ok, not due.
func TestResume_ExcludesPauseFromElapsedDays(t *testing.T) {
	h, repo, _, _ := newTestHandlers(t)
	mux := newMux(h)
	pauseFixture(t, repo)
	if err := repo.SaveTask(1, "descaling", Task{"pausedAt": ago(60).UnixMilli()}); err != nil {
		t.Fatalf("SaveTask pausedAt: %v", err)
	}

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/descaling/threshold",
		mustMarshal(t, map[string]any{"paused": false}))
	if rec.Code != http.StatusOK {
		t.Fatalf("resume status = %d; body=%s", rec.Code, rec.Body.String())
	}
	task, _ := decodeBody(t, rec.Body.Bytes())["descaling"].(map[string]any)
	wantStatStatus(t, task, "ok")
	wantStatDaysSince(t, task, 40)
	if at, ok := task["pausedAt"]; ok && at != nil {
		t.Errorf("pausedAt = %v, want absent or null after resume", at)
	}
	want := float64(60 * dayMs)
	if got := statNumber(t, task, "pausedMs"); got < want-float64(time.Minute.Milliseconds()) || got > want+float64(time.Minute.Milliseconds()) {
		t.Errorf("pausedMs = %v, want about %v", got, want)
	}

	wantStatStatus(t, getStat(t, mux, "/api/maintenance", "descaling"), "ok")
}

// TestPause_NeverDueEvenPastTheShotThreshold: shots keep counting during a
// pause, but the status stays "paused" until the resume — which then reports
// the task as due right away.
func TestPause_NeverDueEvenPastTheShotThreshold(t *testing.T) {
	h, repo, _, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)
	mux := newMux(h)

	last := ago(10)
	if err := repo.SaveTask(1, "backflush", Task{"lastDate": isoTS(last), "threshold_shots": int64(20)}); err != nil {
		t.Fatalf("SaveTask backflush: %v", err)
	}
	seedPauseShots(t, shotsRepo, last, 25)

	before := getStat(t, mux, "/api/maintenance", "backflush")
	wantStatStatus(t, before, "due")
	// Pause backflush.
	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/backflush/threshold",
		mustMarshal(t, map[string]any{"paused": true}))
	if rec.Code != http.StatusOK {
		t.Fatalf("pause status = %d; body=%s", rec.Code, rec.Body.String())
	}
	task := getStat(t, mux, "/api/maintenance", "backflush")
	wantStatStatus(t, task, "paused")
	if got := statNumber(t, task, "shotsSince"); got != 25 {
		t.Errorf("shotsSince = %v, want 25 (shots keep counting while paused)", got)
	}
	if got := statNumber(t, task, "pct"); got != 1 {
		t.Errorf("pct = %v, want 1", got)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/maintenance/backflush/threshold",
		mustMarshal(t, map[string]any{"paused": false}))
	if rec.Code != http.StatusOK {
		t.Fatalf("resume status = %d; body=%s", rec.Code, rec.Body.String())
	}
	resumed, _ := decodeBody(t, rec.Body.Bytes())["backflush"].(map[string]any)
	wantStatStatus(t, resumed, "due")
}

// TestPause_NeverDoneTaskIsPaused: pause wins over "never" too.
func TestPause_NeverDoneTaskIsPaused(t *testing.T) {
	h, _, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/grouphead/threshold",
		mustMarshal(t, map[string]any{"paused": true}))
	if rec.Code != http.StatusOK {
		t.Fatalf("pause status = %d; body=%s", rec.Code, rec.Body.String())
	}
	task, _ := decodeBody(t, rec.Body.Bytes())["grouphead"].(map[string]any)
	wantStatStatus(t, task, "paused")
	if task["daysSince"] != nil {
		t.Errorf("daysSince = %v, want null for a never-done task", task["daysSince"])
	}
}

// TestPause_RepeatedRequestsAreNoOps: asking for the state a task is already
// in must not restart the clock or write a pause total.
func TestPause_RepeatedRequestsAreNoOps(t *testing.T) {
	h, repo, _, _ := newTestHandlers(t)
	mux := newMux(h)
	pauseFixture(t, repo)

	startedAt := ago(3).UnixMilli()
	if err := repo.SaveTask(1, "descaling", Task{"pausedAt": startedAt}); err != nil {
		t.Fatalf("SaveTask pausedAt: %v", err)
	}
	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/descaling/threshold",
		mustMarshal(t, map[string]any{"paused": true}))
	if rec.Code != http.StatusOK {
		t.Fatalf("pause status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := statNumber(t, getStat(t, mux, "/api/maintenance", "descaling"), "pausedAt"); int64(got) != startedAt {
		t.Errorf("pausedAt = %v, want the original %d (a repeat must not restart the clock)", got, startedAt)
	}

	// Resuming an unpaused task writes nothing.
	rec = doJSON(t, mux, http.MethodPost, "/api/maintenance/gaskets/threshold",
		mustMarshal(t, map[string]any{"paused": false}))
	if rec.Code != http.StatusOK {
		t.Fatalf("resume status = %d; body=%s", rec.Code, rec.Body.String())
	}
	rows, err := repo.GetAllMaintenanceRaw()
	if err != nil {
		t.Fatalf("GetAllMaintenanceRaw: %v", err)
	}
	for _, row := range rows {
		if row.Key != "gaskets" {
			continue
		}
		var data map[string]any
		if err := json.Unmarshal(row.Data, &data); err != nil {
			t.Fatalf("unmarshal gaskets row: %v", err)
		}
		if _, ok := data["pausedMs"]; ok {
			t.Errorf("resume of an unpaused task wrote pausedMs: %s", row.Data)
		}
	}
}

// TestPause_NonBooleanIsIgnored: a non-boolean "paused" value leaves the task
// alone rather than 400ing or coercing.
func TestPause_NonBooleanIsIgnored(t *testing.T) {
	h, repo, _, _ := newTestHandlers(t)
	mux := newMux(h)
	pauseFixture(t, repo)

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/descaling/threshold",
		mustMarshal(t, map[string]any{"paused": "yes"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	task, _ := decodeBody(t, rec.Body.Bytes())["descaling"].(map[string]any)
	wantStatStatus(t, task, "due")
	if at, ok := task["pausedAt"]; ok && at != nil {
		t.Errorf("pausedAt = %v, want absent", at)
	}
}

// TestMarkDone_WhilePausedKeepsPauseAndResetsClock: completing a paused task
// clears the closed pause time (it belonged to the old lastDate), keeps the
// pause running, and the day count reads 0 until the resume.
func TestMarkDone_WhilePausedKeepsPauseAndResetsClock(t *testing.T) {
	h, repo, _, _ := newTestHandlers(t)
	mux := newMux(h)
	pauseFixture(t, repo)
	pausedAt := ago(10).UnixMilli()
	if err := repo.SaveTask(1, "descaling", Task{
		"pausedAt": pausedAt,
		"pausedMs": int64(30 * dayMs),
	}); err != nil {
		t.Fatalf("SaveTask pause state: %v", err)
	}

	rec := doJSON(t, mux, http.MethodPost, "/api/maintenance/descaling/done", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusOK {
		t.Fatalf("done status = %d; body=%s", rec.Code, rec.Body.String())
	}
	task, _ := decodeBody(t, rec.Body.Bytes())["descaling"].(map[string]any)
	wantStatStatus(t, task, "paused")
	wantStatDaysSince(t, task, 0)
	if ms, ok := task["pausedMs"]; ok && ms != nil {
		t.Errorf("pausedMs = %v, want absent or null after done", ms)
	}
	if got := statNumber(t, task, "pausedAt"); int64(got) != pausedAt {
		t.Errorf("pausedAt = %v, want the unchanged %d", got, pausedAt)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/maintenance/descaling/threshold",
		mustMarshal(t, map[string]any{"paused": false}))
	if rec.Code != http.StatusOK {
		t.Fatalf("resume status = %d; body=%s", rec.Code, rec.Body.String())
	}
	resumed, _ := decodeBody(t, rec.Body.Bytes())["descaling"].(map[string]any)
	wantStatStatus(t, resumed, "ok")
	wantStatDaysSince(t, resumed, 0)
}

// TestApplyMachineServiceLog_PausedTaskStaysPaused: a machine-reported service
// event moves lastDate, drops the closed pause time, and leaves the pause
// running, so the day count restarts at zero.
func TestApplyMachineServiceLog_PausedTaskStaysPaused(t *testing.T) {
	h, repo, _, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)
	registry := h.registry
	mux := newMux(h)

	if err := repo.SaveTask(1, "descaling", Task{
		"lastDate": isoTS(ago(30)),
		"pausedAt": ago(20).UnixMilli(),
		"pausedMs": int64(2 * dayMs),
	}); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}

	at := ago(5)
	marked, err := ApplyMachineServiceLog(repo, shotsRepo, registry, 1, "descaling", at)
	if err != nil {
		t.Fatalf("ApplyMachineServiceLog: %v", err)
	}
	if !marked {
		t.Fatal("marked = false, want true for a newer machine timestamp")
	}

	task := getStat(t, mux, "/api/maintenance", "descaling")
	wantStatStatus(t, task, "paused")
	wantStatDaysSince(t, task, 0)
	if ms, ok := task["pausedMs"]; ok && ms != nil {
		t.Errorf("pausedMs = %v, want absent or null after lastDate moved", ms)
	}
}

// TestPause_PerMachineAndSharedEquipment: a pause is per machine for
// machine-scoped tasks and shared for shared equipment, like `disabled`.
func TestPause_PerMachineAndSharedEquipment(t *testing.T) {
	h, repo, libRepo, _ := newTestHandlers(t)
	mux := newMux(h)

	if _, err := h.registry.GetDefaultMachine(); err != nil { // seed machine 1
		t.Fatalf("seed default machine: %v", err)
	}
	m2, err := h.registry.CreateMachine(machines.MachineInput{
		Name: strPtr("Second"), Type: strPtr("gaggiuino"), Host: strPtr("http://secondmachine.local"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	if err := libRepo.SaveLibrary(library.Library{
		Grinders: []library.Entity{{"id": int64(1), "name": "Niche Zero"}},
	}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
	pauseFixture(t, repo)

	path := "/api/maintenance/descaling/threshold?machineId=" + formatFloatID(float64(m2.ID))
	rec := doJSON(t, mux, http.MethodPost, path, mustMarshal(t, map[string]any{"paused": true}))
	if rec.Code != http.StatusOK {
		t.Fatalf("pause status = %d; body=%s", rec.Code, rec.Body.String())
	}
	wantStatStatus(t, getStat(t, mux, "/api/maintenance", "descaling"), "due")
	wantStatStatus(t, getStat(t, mux, "/api/maintenance?machineId="+formatFloatID(float64(m2.ID)), "descaling"), "paused")

	// grinder_1 is shared equipment, so a pause through machine 2 shows up on
	// machine 1 too — including the synthesized task's pausedAt.
	rec = doJSON(t, mux, http.MethodPost, "/api/maintenance/grinder_1/threshold?machineId="+formatFloatID(float64(m2.ID)),
		mustMarshal(t, map[string]any{"paused": true}))
	if rec.Code != http.StatusOK {
		t.Fatalf("grinder pause status = %d; body=%s", rec.Code, rec.Body.String())
	}
	grinder := getStat(t, mux, "/api/maintenance", "grinder_1")
	wantStatStatus(t, grinder, "paused")
	if at, ok := grinder["pausedAt"].(float64); !ok || at <= 0 {
		t.Errorf("grinder_1 pausedAt = %v, want the stored pause timestamp", grinder["pausedAt"])
	}
}

// TestPause_OldRowHasNoPauseKeys: a row written before the pause keys existed
// behaves exactly as before.
func TestPause_OldRowHasNoPauseKeys(t *testing.T) {
	h, repo, _, _ := newTestHandlers(t)
	mux := newMux(h)
	pauseFixture(t, repo)

	task := getStat(t, mux, "/api/maintenance", "descaling")
	wantStatStatus(t, task, "due")
	if at, ok := task["pausedAt"]; ok && at != nil {
		t.Errorf("pausedAt = %v, want absent", at)
	}
}

// TestPausedMsSince_ClampsBadValues covers the arithmetic bounds: a pause can
// never drive the day count below zero, negative totals are ignored, a pause
// in the future adds nothing, and one older than lastDate counts from
// lastDate.
func TestPausedMsSince_ClampsBadValues(t *testing.T) {
	_, repo, _, sqlDB := newTestHandlers(t)
	shotsRepo := shots.NewRepository(sqlDB)

	last := ago(100)
	lastTS := isoTS(last)

	statFor := func(t *testing.T, extra Task) Stat {
		t.Helper()
		task := Task{"lastDate": lastTS, "threshold_days": int64(60), "threshold_shots": int64(200)}
		for k, v := range extra {
			task[k] = v
		}
		stats, err := ComputeMaintenanceStats(shotsRepo, repo.libRepo, map[string]Task{"descaling": task}, 1)
		if err != nil {
			t.Fatalf("ComputeMaintenanceStats: %v", err)
		}
		return stats["descaling"]
	}

	if got, _ := statFor(t, Task{"pausedMs": int64(500 * dayMs)})["daysSince"].(int64); got != 0 {
		t.Errorf("daysSince with pausedMs beyond the elapsed time = %d, want 0 (never negative)", got)
	}
	if got, _ := statFor(t, Task{"pausedMs": int64(-5 * dayMs)})["daysSince"].(int64); got != 100 {
		t.Errorf("daysSince with negative pausedMs = %d, want the unmodified 100", got)
	}
	if got, _ := statFor(t, Task{"pausedAt": ago(-5).UnixMilli()})["daysSince"].(int64); got != 100 {
		t.Errorf("daysSince with a future pausedAt = %d, want the unmodified 100", got)
	}
	if got, _ := statFor(t, Task{"pausedAt": ago(200).UnixMilli()})["daysSince"].(int64); got != 0 {
		t.Errorf("daysSince with pausedAt before lastDate = %d, want 0 (the pause counts from lastDate)", got)
	}

	// The helper itself: a running pause counts only from lastMs.
	lastMs := last.UnixMilli()
	if got := PausedMsSince(Task{"pausedAt": ago(200).UnixMilli()}, lastMs, time.Now().UnixMilli()); got < 100*dayMs-int64(time.Minute.Milliseconds()) {
		t.Errorf("PausedMsSince with pausedAt before lastMs = %d, want about %d", got, 100*dayMs)
	}
}
