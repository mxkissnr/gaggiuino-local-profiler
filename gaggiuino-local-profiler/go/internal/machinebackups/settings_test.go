package machinebackups

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// ── settings helpers ────────────────────────────────────────────────────

// docWithSteam returns the fixture with another steam set point, so every
// fetched document has a distinct content hash.
func docWithSteam(n int) string {
	return strings.Replace(fixtureDoc, `"steamSetPoint": 145`, fmt.Sprintf(`"steamSetPoint": %d`, n), 1)
}

// assertSettingsResponse checks that a settings response carries only the three
// settings fields and no secret.
func assertSettingsResponse(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	b := rec.Body.Bytes()
	assertNoSecrets(t, "settings response", b)
	var keys map[string]any
	if err := json.Unmarshal(b, &keys); err != nil {
		t.Fatalf("decoding settings response: %v (body %s)", err, b)
	}
	for _, forbidden := range []string{"data", "document"} {
		if _, ok := keys[forbidden]; ok {
			t.Errorf("settings response carries a %q key: %s", forbidden, b)
		}
	}
}

func decodeSettings(t *testing.T, rec *httptest.ResponseRecorder) machineSettings {
	t.Helper()
	var s machineSettings
	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
		t.Fatalf("decoding settings: %v (body %s)", err, rec.Body.String())
	}
	return s
}

// putSettings PUTs one machine's settings and fails unless the route answered
// 200 with exactly those values.
func putSettings(t *testing.T, h http.Handler, id int64, schedule string, keep int) {
	t.Helper()
	body := fmt.Sprintf(`{"machineId":%d,"schedule":%q,"keepAutomatic":%d}`, id, schedule, keep)
	rec := do(h, http.MethodPut, "/api/machine/backups/settings", body, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT %s/%d: status = %d (body %s)", schedule, keep, rec.Code, rec.Body.String())
	}
	assertSettingsResponse(t, rec)
	if got := decodeSettings(t, rec); got.MachineID != id || got.Schedule != schedule || got.KeepAutomatic != keep {
		t.Fatalf("PUT %s/%d response = %+v", schedule, keep, got)
	}
}

func getSettings(t *testing.T, h http.Handler, id int64) machineSettings {
	t.Helper()
	rec := do(h, http.MethodGet, fmt.Sprintf("/api/machine/backups/settings?machineId=%d", id), "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %d: status = %d (body %s)", id, rec.Code, rec.Body.String())
	}
	assertSettingsResponse(t, rec)
	return decodeSettings(t, rec)
}

func (e *testEnv) settingsRow(t *testing.T) (string, bool) {
	t.Helper()
	var value string
	if err := e.db.QueryRow(`SELECT value FROM kv WHERE key = ?`, settingsKVKey).Scan(&value); err != nil {
		return "", false
	}
	return value, true
}

// setSettingsRow writes the kv row directly, as a corrupted or older build
// could have left it.
func (e *testEnv) setSettingsRow(t *testing.T, value string) {
	t.Helper()
	if _, err := e.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, settingsKVKey, value); err != nil {
		t.Fatalf("writing settings row: %v", err)
	}
}

// ── settings routes ─────────────────────────────────────────────────────

func TestSettings_DefaultsAndRoundTrip(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1), gaggiuinoMachine(2))

	rec := do(h, http.MethodGet, "/api/machine/backups/settings?machineId=1", "", "")
	if got, want := rec.Body.String(), `{"machineId":1,"schedule":"daily","keepAutomatic":10}`; rec.Code != http.StatusOK || got != want {
		t.Fatalf("GET defaults = %d %s, want 200 %s", rec.Code, got, want)
	}
	assertSettingsResponse(t, rec)

	putSettings(t, h, 1, ScheduleWeekly, 20)
	if got := getSettings(t, h, 1); got.Schedule != ScheduleWeekly || got.KeepAutomatic != 20 {
		t.Fatalf("machine 1 after PUT = %+v, want weekly/20", got)
	}
	if got := getSettings(t, h, 2); got.Schedule != ScheduleDaily || got.KeepAutomatic != 10 {
		t.Fatalf("machine 2 = %+v, want the defaults: settings are per machine", got)
	}
	if row, ok := e.settingsRow(t); !ok || row != `{"1":{"schedule":"weekly","keepAutomatic":20}}` {
		t.Fatalf("kv row = %q (exists %v), want only machine 1", row, ok)
	}

	for _, tc := range []struct {
		schedule string
		keep     int
	}{{ScheduleOff, 1}, {ScheduleDaily, 100}} {
		putSettings(t, h, 1, tc.schedule, tc.keep)
		if got := getSettings(t, h, 1); got.Schedule != tc.schedule || got.KeepAutomatic != tc.keep {
			t.Fatalf("machine 1 after PUT %s/%d = %+v", tc.schedule, tc.keep, got)
		}
	}
}

func TestSettings_Errors(t *testing.T) {
	target := "/api/machine/backups/settings"
	cases := []struct {
		name          string
		method, query string
		body          string
		status        int
		code          string
	}{
		{"get without machineId", http.MethodGet, "", "", http.StatusBadRequest, ""},
		{"get non-numeric machineId", http.MethodGet, "?machineId=abc", "", http.StatusBadRequest, ""},
		{"get machineId zero", http.MethodGet, "?machineId=0", "", http.StatusBadRequest, ""},
		{"get unknown machine", http.MethodGet, "?machineId=99", "", http.StatusNotFound, ""},
		{"get non-gaggiuino machine", http.MethodGet, "?machineId=3", "", http.StatusNotImplemented, codeUnsupportedMachine},

		{"put broken json", http.MethodPut, "", `{`, http.StatusBadRequest, ""},
		{"put empty object", http.MethodPut, "", `{}`, http.StatusBadRequest, ""},
		{"put machineId zero", http.MethodPut, "", `{"machineId":0,"schedule":"daily","keepAutomatic":10}`, http.StatusBadRequest, ""},
		{"put schedule missing", http.MethodPut, "", `{"machineId":1,"keepAutomatic":10}`, http.StatusBadRequest, ""},
		{"put schedule hourly", http.MethodPut, "", `{"machineId":1,"schedule":"hourly","keepAutomatic":10}`, http.StatusBadRequest, ""},
		{"put schedule capitalised", http.MethodPut, "", `{"machineId":1,"schedule":"Daily","keepAutomatic":10}`, http.StatusBadRequest, ""},
		{"put keep missing", http.MethodPut, "", `{"machineId":1,"schedule":"daily"}`, http.StatusBadRequest, ""},
		{"put keep zero", http.MethodPut, "", `{"machineId":1,"schedule":"daily","keepAutomatic":0}`, http.StatusBadRequest, ""},
		{"put keep 101", http.MethodPut, "", `{"machineId":1,"schedule":"daily","keepAutomatic":101}`, http.StatusBadRequest, ""},
		{"put keep 10.5", http.MethodPut, "", `{"machineId":1,"schedule":"daily","keepAutomatic":10.5}`, http.StatusBadRequest, ""},
		{"put keep as string", http.MethodPut, "", `{"machineId":1,"schedule":"daily","keepAutomatic":"10"}`, http.StatusBadRequest, ""},
		{"put unknown machine", http.MethodPut, "", `{"machineId":99,"schedule":"daily","keepAutomatic":10}`, http.StatusNotFound, ""},
		{"put non-gaggiuino machine", http.MethodPut, "", `{"machineId":3,"schedule":"daily","keepAutomatic":10}`, http.StatusNotImplemented, codeUnsupportedMachine},
		{"put body over 4 KiB", http.MethodPut, "", `{"machineId":1,"schedule":"daily","keepAutomatic":10,"pad":"` + strings.Repeat("a", 5000) + `"}`, http.StatusRequestEntityTooLarge, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			other := gaggiuinoMachine(3)
			other.Type = "gaggimate"
			e, h := newHandlerEnv(t, gaggiuinoMachine(1), other)
			rec := do(h, tc.method, target+tc.query, tc.body, "")
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.status, rec.Body.String())
			}
			if tc.code != "" {
				if got := errorCode(t, rec.Body.Bytes()); got != tc.code {
					t.Fatalf("code = %q, want %q (body %s)", got, tc.code, rec.Body.String())
				}
			}
			assertNoSecrets(t, "error response", rec.Body.Bytes())
			if row, ok := e.settingsRow(t); ok {
				t.Fatalf("a rejected request wrote the kv row: %q", row)
			}
		})
	}
}

func TestSettings_StoredValueFallbacks(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1), gaggiuinoMachine(2))

	e.setSettingsRow(t, `{not json`)
	if got := getSettings(t, h, 1); got.Schedule != ScheduleDaily || got.KeepAutomatic != 10 {
		t.Fatalf("GET with a malformed row = %+v, want the defaults", got)
	}
	putSettings(t, h, 1, ScheduleWeekly, 5)
	if got := getSettings(t, h, 1); got.Schedule != ScheduleWeekly || got.KeepAutomatic != 5 {
		t.Fatalf("GET after replacing a malformed row = %+v, want weekly/5", got)
	}

	e.setSettingsRow(t, `{"1":{"schedule":"hourly","keepAutomatic":10},"2":{"schedule":"weekly","keepAutomatic":5}}`)
	if got := getSettings(t, h, 1); got.Schedule != ScheduleDaily || got.KeepAutomatic != 10 {
		t.Fatalf("GET with an invalid entry = %+v, want the defaults", got)
	}
	if got := getSettings(t, h, 2); got.Schedule != ScheduleWeekly || got.KeepAutomatic != 5 {
		t.Fatalf("GET of the valid entry = %+v, want weekly/5", got)
	}
}

func TestSettings_ConcurrentPutsKeepEveryMachine(t *testing.T) {
	list := make([]machines.Machine, 0, 20)
	for id := int64(1); id <= 20; id++ {
		list = append(list, gaggiuinoMachine(id))
	}
	e, h := newHandlerEnv(t, list...)
	// The handlers log on success and that buffer is not safe for concurrent
	// writers; this test is about the kv row, not the log.
	log.SetOutput(io.Discard)

	var wg sync.WaitGroup
	statuses := make([]int, len(list))
	bodies := make([]string, len(list))
	for i, m := range list {
		wg.Add(1)
		go func(i int, m machines.Machine) {
			defer wg.Done()
			body := fmt.Sprintf(`{"machineId":%d,"schedule":"weekly","keepAutomatic":%d}`, m.ID, m.ID)
			rec := do(h, http.MethodPut, "/api/machine/backups/settings", body, "")
			statuses[i], bodies[i] = rec.Code, rec.Body.String()
		}(i, m)
	}
	wg.Wait()

	for i := range list {
		if statuses[i] != http.StatusOK {
			t.Fatalf("PUT machine %d: status = %d (body %s)", list[i].ID, statuses[i], bodies[i])
		}
	}

	all, err := e.repo.allSettings()
	if err != nil {
		t.Fatalf("allSettings: %v", err)
	}
	if len(all) != len(list) {
		t.Fatalf("stored settings for %d machines, want %d: a concurrent PUT lost an update", len(all), len(list))
	}
	for _, m := range list {
		if got := all.forMachine(m.ID); got.Schedule != ScheduleWeekly || got.KeepAutomatic != int(m.ID) {
			t.Errorf("machine %d settings = %+v, want weekly/%d", m.ID, got, m.ID)
		}
	}
}

// ── scheduler and retention ─────────────────────────────────────────────

func TestScheduler_ScheduleOffDailyWeekly(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1))
	client := &fakeClient{docs: []string{
		docWithSteam(146), docWithSteam(147), docWithSteam(148), docWithSteam(149),
	}}
	e.clients[1] = client

	steps := []struct {
		name     string
		schedule string // empty: keep the current setting
		advance  time.Duration
		lookups  int
		rows     int
	}{
		{"off never contacts", ScheduleOff, 0, 0, 0},
		{"daily stores the first backup", ScheduleDaily, 0, 1, 1},
		{"daily skips the same day", "", 0, 1, 1},
		{"off leaves the rows alone", ScheduleOff, 24 * time.Hour, 1, 1},
		{"weekly skips the same ISO week", ScheduleWeekly, 0, 1, 1},
		{"weekly skips the next day", "", 24 * time.Hour, 1, 1},
		{"weekly stores in a new ISO week", "", 4 * 24 * time.Hour, 2, 2},
		{"weekly skips Tuesday", "", 24 * time.Hour, 2, 2},
		{"weekly skips Sunday", "", 5 * 24 * time.Hour, 2, 2},
		{"weekly stores in the next ISO week", "", 24 * time.Hour, 3, 3},
		{"daily stores the next day", ScheduleDaily, 24 * time.Hour, 4, 4},
	}
	for i, st := range steps {
		if st.schedule != "" {
			putSettings(t, h, 1, st.schedule, 10)
		}
		e.advance(st.advance)
		e.tick()
		if i == 0 && client.statusCalls != 0 {
			t.Fatalf("off: the scheduler made a status call")
		}
		if e.clientLookups[1] != st.lookups || len(e.rows()) != st.rows {
			t.Fatalf("%s: lookups %d, rows %d; want %d and %d",
				st.name, e.clientLookups[1], len(e.rows()), st.lookups, st.rows)
		}
	}
}

func TestSameISOWeek(t *testing.T) {
	at := func(year int, month time.Month, day int) time.Time {
		return time.Date(year, month, day, 9, 0, 0, 0, time.Local)
	}
	cases := []struct {
		name string
		a, b time.Time
		want bool
	}{
		{"same week", at(2026, time.November, 3), at(2026, time.November, 8), true},
		{"week boundary", at(2026, time.November, 8), at(2026, time.November, 9), false},
		{"week 53 of 2026", at(2026, time.December, 31), at(2027, time.January, 3), true},
		{"after week 53", at(2027, time.January, 3), at(2027, time.January, 4), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sameISOWeek(tc.a, tc.b); got != tc.want {
				t.Fatalf("sameISOWeek(%s, %s) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

func TestScheduler_RetentionPrunesOnlyScheduledRows(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1))
	p, err := prepare([]byte(fixtureDoc))
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	// The other kinds of machine 1, and the automatic rows of a deleted machine.
	for i, kind := range []string{KindManual, KindPreUpdate, KindUploaded} {
		if _, err := e.repo.insert(1, kind, "", p, e.clock.Add(time.Duration(i-3)*time.Hour)); err != nil {
			t.Fatalf("inserting %s row: %v", kind, err)
		}
	}
	for i := 0; i < 3; i++ {
		if _, err := e.repo.insert(7, KindScheduled, "", p, e.clock.Add(-time.Duration(i+1)*time.Hour)); err != nil {
			t.Fatalf("inserting the deleted machine's row: %v", err)
		}
	}
	e.clients[1] = &fakeClient{docs: []string{
		docWithSteam(146), docWithSteam(147), docWithSteam(148),
		docWithSteam(149), docWithSteam(150), docWithSteam(151),
	}}
	scheduled := func(machineID int64) []backupRow {
		var out []backupRow
		for _, r := range e.rows() {
			if r.machineID == machineID && r.kind == KindScheduled {
				out = append(out, r)
			}
		}
		return out
	}
	wantScheduled := func(want int) {
		t.Helper()
		if got := scheduled(1); len(got) != want {
			t.Fatalf("%d scheduled rows of machine 1, want %d", len(got), want)
		}
	}

	putSettings(t, h, 1, ScheduleDaily, 2)
	var stored []int64
	for day := 0; day < 4; day++ {
		stored = append(stored, e.clock.Unix()*1000)
		e.tick()
		e.advance(24 * time.Hour)
	}

	wantScheduled(2)
	rows := scheduled(1)
	if rows[0].createdAt != stored[2] || rows[1].createdAt != stored[3] {
		t.Fatalf("kept rows at %d and %d; want the two newest %d and %d",
			rows[0].createdAt, rows[1].createdAt, stored[2], stored[3])
	}
	kept := map[string]int{}
	for _, r := range e.rows() {
		if r.machineID == 1 {
			kept[r.kind]++
		}
	}
	if kept[KindManual] != 1 || kept[KindPreUpdate] != 1 || kept[KindUploaded] != 1 {
		t.Fatalf("retention touched other kinds: %v", kept)
	}
	if got := scheduled(7); len(got) != 3 {
		t.Fatalf("retention deleted rows of a deleted machine: %d left, want 3", len(got))
	}

	putSettings(t, h, 1, ScheduleDaily, 3)
	e.tick()
	wantScheduled(3)
	e.advance(24 * time.Hour)

	putSettings(t, h, 1, ScheduleDaily, 1)
	wantScheduled(3) // lowering the retention prunes nothing at save time
	last := e.clock.Unix() * 1000
	e.tick()
	wantScheduled(1)
	if got := scheduled(1)[0].createdAt; got != last {
		t.Fatalf("keep 1 left the row at %d, want the newest at %d", got, last)
	}

	logs := e.logs.String()
	if !strings.Contains(logs, "removed") || !strings.Contains(logs, "old automatic backups of machine 1") {
		t.Fatalf("no prune log line: %s", logs)
	}
	if bytes.Contains(e.logs.Bytes(), []byte("192.168.1.50")) {
		t.Fatalf("log carries the machine host: %s", logs)
	}
	assertNoSecrets(t, "log", e.logs.Bytes())
}

func TestScheduler_SettingsReadErrorSkipsTick(t *testing.T) {
	e, _ := newHandlerEnv(t, gaggiuinoMachine(1))
	e.clients[1] = &fakeClient{docs: []string{fixtureDoc}}

	e.closeDB()
	e.tick()

	if e.clientLookups[1] != 0 {
		t.Fatalf("the scheduler contacted a machine after a settings read error")
	}
	if !strings.Contains(e.logs.String(), "reading backup settings") {
		t.Fatalf("no settings error logged: %s", e.logs.String())
	}
}

func TestPruneScheduled_RefusesKeepBelowOne(t *testing.T) {
	e, _ := newHandlerEnv(t, gaggiuinoMachine(1))
	p, err := prepare([]byte(fixtureDoc))
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	for i := 0; i < 2; i++ {
		if _, err := e.repo.insert(1, KindScheduled, "", p, e.clock.Add(-time.Duration(i)*time.Hour)); err != nil {
			t.Fatalf("inserting row: %v", err)
		}
	}

	removed, err := e.repo.pruneScheduled(1, 0)
	if err == nil || removed != 0 {
		t.Fatalf("pruneScheduled(1, 0) = %d, %v; want 0 and an error", removed, err)
	}
	if got := len(e.rows()); got != 2 {
		t.Fatalf("%d rows left after the refused prune, want 2", got)
	}
}
