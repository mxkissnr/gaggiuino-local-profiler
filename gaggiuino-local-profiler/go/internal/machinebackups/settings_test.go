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

func putSettings(t *testing.T, h http.Handler, id int64, schedule string, keep int) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"machineId":%d,"schedule":%q,"keepAutomatic":%d}`, id, schedule, keep)
	return do(h, http.MethodPut, "/api/machine/backups/settings", body, "")
}

func decodeMachineSettings(t *testing.T, rec *httptest.ResponseRecorder) machineSettings {
	t.Helper()
	var s machineSettings
	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
		t.Fatalf("decoding settings: %v (body %s)", err, rec.Body.String())
	}
	return s
}

// setSettingsRow writes the kv row directly, as a corrupted or older build
// could have left it.
func (e *testEnv) setSettingsRow(t *testing.T, value string) {
	t.Helper()
	if _, err := e.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, settingsKVKey, value); err != nil {
		t.Fatalf("writing settings row: %v", err)
	}
}

// settingsRow returns the stored kv value and whether the row exists.
func (e *testEnv) settingsRow(t *testing.T) (string, bool) {
	t.Helper()
	var value string
	err := e.db.QueryRow(`SELECT value FROM kv WHERE key = ?`, settingsKVKey).Scan(&value)
	if err != nil {
		return "", false
	}
	return value, true
}

func assertSettingsBody(t *testing.T, rec *httptest.ResponseRecorder) {
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

// ── settings routes ─────────────────────────────────────────────────────

func TestSettings_DefaultsAndRoundTrip(t *testing.T) {
	e, h := newHandlerEnv(t, gaggiuinoMachine(1), gaggiuinoMachine(2))

	rec := do(h, http.MethodGet, "/api/machine/backups/settings?machineId=1", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET defaults: status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got, want := rec.Body.String(), `{"machineId":1,"schedule":"daily","keepAutomatic":10}`; got != want {
		t.Fatalf("GET defaults body = %s, want %s", got, want)
	}
	assertSettingsBody(t, rec)

	rec = putSettings(t, h, 1, ScheduleWeekly, 20)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT weekly: status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if got, want := rec.Body.String(), `{"machineId":1,"schedule":"weekly","keepAutomatic":20}`; got != want {
		t.Fatalf("PUT body = %s, want %s", got, want)
	}
	assertSettingsBody(t, rec)

	rec = do(h, http.MethodGet, "/api/machine/backups/settings?machineId=1", "", "")
	if got := decodeMachineSettings(t, rec); got.Schedule != ScheduleWeekly || got.KeepAutomatic != 20 || got.MachineID != 1 {
		t.Fatalf("GET after PUT = %+v, want machine 1 weekly/20", got)
	}

	rec = do(h, http.MethodGet, "/api/machine/backups/settings?machineId=2", "", "")
	if got := decodeMachineSettings(t, rec); got.Schedule != ScheduleDaily || got.KeepAutomatic != 10 || got.MachineID != 2 {
		t.Fatalf("machine 2 = %+v, want the defaults: settings are per machine", got)
	}

	if row, ok := e.settingsRow(t); !ok || row != `{"1":{"schedule":"weekly","keepAutomatic":20}}` {
		t.Fatalf("kv row = %q (exists %v), want only machine 1", row, ok)
	}

	for _, tc := range []struct {
		schedule string
		keep     int
	}{
		{ScheduleOff, 1},
		{ScheduleDaily, 100},
	} {
		if rec := putSettings(t, h, 1, tc.schedule, tc.keep); rec.Code != http.StatusOK {
			t.Fatalf("PUT %s/%d: status = %d, want 200 (body %s)", tc.schedule, tc.keep, rec.Code, rec.Body.String())
		}
		rec := do(h, http.MethodGet, "/api/machine/backups/settings?machineId=1", "", "")
		if got := decodeMachineSettings(t, rec); got.Schedule != tc.schedule || got.KeepAutomatic != tc.keep {
			t.Fatalf("GET after PUT %s/%d = %+v", tc.schedule, tc.keep, got)
		}
		assertSettingsBody(t, rec)
	}
}

func TestSettings_Errors(t *testing.T) {
	notGaggiuino := gaggiuinoMachine(3)
	notGaggiuino.Type = "gaggimate"

	cases := []struct {
		name   string
		method string
		target string
		body   string
		status int
		code   string
	}{
		{"get without machineId", http.MethodGet, "/api/machine/backups/settings", "", http.StatusBadRequest, ""},
		{"get non-numeric machineId", http.MethodGet, "/api/machine/backups/settings?machineId=abc", "", http.StatusBadRequest, ""},
		{"get machineId zero", http.MethodGet, "/api/machine/backups/settings?machineId=0", "", http.StatusBadRequest, ""},
		{"get unknown machine", http.MethodGet, "/api/machine/backups/settings?machineId=99", "", http.StatusNotFound, ""},
		{"get non-gaggiuino machine", http.MethodGet, "/api/machine/backups/settings?machineId=3", "", http.StatusNotImplemented, codeUnsupportedMachine},

		{"put broken json", http.MethodPut, "/api/machine/backups/settings", `{`, http.StatusBadRequest, ""},
		{"put empty object", http.MethodPut, "/api/machine/backups/settings", `{}`, http.StatusBadRequest, ""},
		{"put machineId zero", http.MethodPut, "/api/machine/backups/settings", `{"machineId":0,"schedule":"daily","keepAutomatic":10}`, http.StatusBadRequest, ""},
		{"put schedule missing", http.MethodPut, "/api/machine/backups/settings", `{"machineId":1,"keepAutomatic":10}`, http.StatusBadRequest, ""},
		{"put schedule hourly", http.MethodPut, "/api/machine/backups/settings", `{"machineId":1,"schedule":"hourly","keepAutomatic":10}`, http.StatusBadRequest, ""},
		{"put schedule capitalised", http.MethodPut, "/api/machine/backups/settings", `{"machineId":1,"schedule":"Daily","keepAutomatic":10}`, http.StatusBadRequest, ""},
		{"put keep missing", http.MethodPut, "/api/machine/backups/settings", `{"machineId":1,"schedule":"daily"}`, http.StatusBadRequest, ""},
		{"put keep zero", http.MethodPut, "/api/machine/backups/settings", `{"machineId":1,"schedule":"daily","keepAutomatic":0}`, http.StatusBadRequest, ""},
		{"put keep 101", http.MethodPut, "/api/machine/backups/settings", `{"machineId":1,"schedule":"daily","keepAutomatic":101}`, http.StatusBadRequest, ""},
		{"put keep 10.5", http.MethodPut, "/api/machine/backups/settings", `{"machineId":1,"schedule":"daily","keepAutomatic":10.5}`, http.StatusBadRequest, ""},
		{"put keep as string", http.MethodPut, "/api/machine/backups/settings", `{"machineId":1,"schedule":"daily","keepAutomatic":"10"}`, http.StatusBadRequest, ""},
		{"put unknown machine", http.MethodPut, "/api/machine/backups/settings", `{"machineId":99,"schedule":"daily","keepAutomatic":10}`, http.StatusNotFound, ""},
		{"put non-gaggiuino machine", http.MethodPut, "/api/machine/backups/settings", `{"machineId":3,"schedule":"daily","keepAutomatic":10}`, http.StatusNotImplemented, codeUnsupportedMachine},
		{"put body over 4 KiB", http.MethodPut, "/api/machine/backups/settings",
			`{"machineId":1,"schedule":"daily","keepAutomatic":10,"pad":"` + strings.Repeat("a", 5000) + `"}`,
			http.StatusRequestEntityTooLarge, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, h := newHandlerEnv(t, gaggiuinoMachine(1), notGaggiuino)
			rec := do(h, tc.method, tc.target, tc.body, "")
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
	rec := do(h, http.MethodGet, "/api/machine/backups/settings?machineId=1", "", "")
	if got := decodeMachineSettings(t, rec); got.Schedule != ScheduleDaily || got.KeepAutomatic != 10 {
		t.Fatalf("GET with a malformed row = %+v, want the defaults", got)
	}

	if rec := putSettings(t, h, 1, ScheduleWeekly, 5); rec.Code != http.StatusOK {
		t.Fatalf("PUT over a malformed row: status = %d (body %s)", rec.Code, rec.Body.String())
	}
	rec = do(h, http.MethodGet, "/api/machine/backups/settings?machineId=1", "", "")
	if got := decodeMachineSettings(t, rec); got.Schedule != ScheduleWeekly || got.KeepAutomatic != 5 {
		t.Fatalf("GET after replacing a malformed row = %+v, want weekly/5", got)
	}

	e.setSettingsRow(t, `{"1":{"schedule":"hourly","keepAutomatic":10},"2":{"schedule":"weekly","keepAutomatic":5}}`)
	rec = do(h, http.MethodGet, "/api/machine/backups/settings?machineId=1", "", "")
	if got := decodeMachineSettings(t, rec); got.Schedule != ScheduleDaily || got.KeepAutomatic != 10 {
		t.Fatalf("GET with an invalid entry = %+v, want the defaults", got)
	}
	rec = do(h, http.MethodGet, "/api/machine/backups/settings?machineId=2", "", "")
	if got := decodeMachineSettings(t, rec); got.Schedule != ScheduleWeekly || got.KeepAutomatic != 5 {
		t.Fatalf("GET of the valid entry = %+v, want weekly/5", got)
	}
}

func TestSettings_ConcurrentPutsKeepEveryMachine(t *testing.T) {
	list := make([]machines.Machine, 0, 20)
	for id := int64(1); id <= 20; id++ {
		list = append(list, gaggiuinoMachine(id))
	}
	e, h := newHandlerEnv(t, list...)

	// The handlers log on success; that buffer is not safe for concurrent
	// writers, and this test is about the kv row, not the log.
	log.SetOutput(io.Discard)

	var wg sync.WaitGroup
	for _, m := range list {
		wg.Add(1)
		go func(m machines.Machine) {
			defer wg.Done()
			rec := putSettings(t, h, m.ID, ScheduleWeekly, int(m.ID))
			if rec.Code != http.StatusOK {
				t.Errorf("PUT machine %d: status = %d, want 200 (body %s)", m.ID, rec.Code, rec.Body.String())
			}
		}(m)
	}
	wg.Wait()

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
		docWithSteam(150), docWithSteam(151), docWithSteam(152),
	}}
	e.clients[1] = client

	if rec := putSettings(t, h, 1, ScheduleOff, 10); rec.Code != http.StatusOK {
		t.Fatalf("PUT off: status = %d (body %s)", rec.Code, rec.Body.String())
	}
	e.tick()
	if e.clientLookups[1] != 0 || client.statusCalls != 0 || len(e.rows()) != 0 {
		t.Fatalf("off: lookups %d, status calls %d, rows %d; want no contact and no rows",
			e.clientLookups[1], client.statusCalls, len(e.rows()))
	}

	if rec := putSettings(t, h, 1, ScheduleDaily, 10); rec.Code != http.StatusOK {
		t.Fatalf("PUT daily: status = %d (body %s)", rec.Code, rec.Body.String())
	}
	e.tick()
	if e.clientLookups[1] != 1 || len(e.rows()) != 1 {
		t.Fatalf("daily: lookups %d, rows %d; want one check and one row", e.clientLookups[1], len(e.rows()))
	}
	e.tick()
	if e.clientLookups[1] != 1 {
		t.Fatalf("daily: a second tick on the same day contacted the machine")
	}

	if rec := putSettings(t, h, 1, ScheduleOff, 10); rec.Code != http.StatusOK {
		t.Fatalf("PUT off again: status = %d (body %s)", rec.Code, rec.Body.String())
	}
	e.advance(24 * time.Hour)
	e.tick()
	if e.clientLookups[1] != 1 || len(e.rows()) != 1 {
		t.Fatalf("off after a day: lookups %d, rows %d; want no contact and the row kept", e.clientLookups[1], len(e.rows()))
	}

	if rec := putSettings(t, h, 1, ScheduleWeekly, 10); rec.Code != http.StatusOK {
		t.Fatalf("PUT weekly: status = %d (body %s)", rec.Code, rec.Body.String())
	}
	// Wednesday 2026-11-04: a daily schedule would fetch now, weekly does not,
	// because the Tuesday check is in the same ISO week.
	e.tick()
	if e.clientLookups[1] != 1 {
		t.Fatalf("weekly: fetched again inside the same ISO week")
	}
	e.advance(24 * time.Hour) // Thursday 2026-11-05, still the same ISO week
	e.tick()
	if e.clientLookups[1] != 1 {
		t.Fatalf("weekly: fetched the next day of the same ISO week")
	}
	e.advance(4 * 24 * time.Hour) // Monday 2026-11-09, a new ISO week
	e.tick()
	if e.clientLookups[1] != 2 || len(e.rows()) != 2 {
		t.Fatalf("weekly in a new ISO week: lookups %d, rows %d; want one check and two rows", e.clientLookups[1], len(e.rows()))
	}
	e.advance(24 * time.Hour) // Tuesday, same ISO week
	e.tick()
	if e.clientLookups[1] != 2 {
		t.Fatalf("weekly: a second check in the same ISO week")
	}
	e.advance(5 * 24 * time.Hour) // Sunday 2026-11-15, same ISO week
	e.tick()
	if e.clientLookups[1] != 2 {
		t.Fatalf("weekly: a check later in the same ISO week")
	}
	e.advance(24 * time.Hour) // Monday 2026-11-16, a new ISO week
	e.tick()
	if e.clientLookups[1] != 3 || len(e.rows()) != 3 {
		t.Fatalf("weekly in the next ISO week: lookups %d, rows %d; want one check and three rows", e.clientLookups[1], len(e.rows()))
	}

	if rec := putSettings(t, h, 1, ScheduleDaily, 10); rec.Code != http.StatusOK {
		t.Fatalf("PUT daily again: status = %d (body %s)", rec.Code, rec.Body.String())
	}
	e.advance(24 * time.Hour) // Tuesday 2026-11-17
	e.tick()
	if e.clientLookups[1] != 4 || len(e.rows()) != 4 {
		t.Fatalf("daily again: lookups %d, rows %d; want one check and four rows", e.clientLookups[1], len(e.rows()))
	}
}

func TestSameISOWeek(t *testing.T) {
	at := func(month time.Month, day int) time.Time {
		return time.Date(2026, month, day, 9, 0, 0, 0, time.Local)
	}
	cases := []struct {
		name string
		a, b time.Time
		want bool
	}{
		{"same week", at(time.November, 3), at(time.November, 8), true},
		{"week boundary", at(time.November, 8), at(time.November, 9), false},
		{"week 53 of 2026", at(time.December, 31), time.Date(2027, time.January, 3, 9, 0, 0, 0, time.Local), true},
		{"after week 53", time.Date(2027, time.January, 3, 9, 0, 0, 0, time.Local), time.Date(2027, time.January, 4, 9, 0, 0, 0, time.Local), false},
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

	if rec := putSettings(t, h, 1, ScheduleDaily, 2); rec.Code != http.StatusOK {
		t.Fatalf("PUT daily/2: status = %d (body %s)", rec.Code, rec.Body.String())
	}
	var stored []int64
	for day := 0; day < 4; day++ {
		stored = append(stored, e.clock.Unix()*1000)
		e.tick()
		e.advance(24 * time.Hour)
	}

	scheduled := func(machineID int64) []backupRow {
		var out []backupRow
		for _, r := range e.rows() {
			if r.machineID == machineID && r.kind == KindScheduled {
				out = append(out, r)
			}
		}
		return out
	}

	rows := scheduled(1)
	if len(rows) != 2 {
		t.Fatalf("keep 2 stored %d scheduled rows, want 2", len(rows))
	}
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

	if rec := putSettings(t, h, 1, ScheduleDaily, 3); rec.Code != http.StatusOK {
		t.Fatalf("PUT daily/3: status = %d (body %s)", rec.Code, rec.Body.String())
	}
	e.tick()
	if got := scheduled(1); len(got) != 3 {
		t.Fatalf("keep 3 stored %d scheduled rows, want 3", len(got))
	}
	e.advance(24 * time.Hour)

	if rec := putSettings(t, h, 1, ScheduleDaily, 1); rec.Code != http.StatusOK {
		t.Fatalf("PUT daily/1: status = %d (body %s)", rec.Code, rec.Body.String())
	}
	if got := scheduled(1); len(got) != 3 {
		t.Fatalf("lowering the retention pruned at save time: %d rows, want 3", len(got))
	}
	last := e.clock.Unix() * 1000
	e.tick()
	rows = scheduled(1)
	if len(rows) != 1 {
		t.Fatalf("keep 1 left %d scheduled rows, want 1", len(rows))
	}
	if rows[0].createdAt != last {
		t.Fatalf("keep 1 left the row at %d, want the newest at %d", rows[0].createdAt, last)
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
	if err == nil {
		t.Fatalf("pruneScheduled(1, 0) succeeded, want an error")
	}
	if removed != 0 {
		t.Fatalf("pruneScheduled(1, 0) removed %d rows, want 0", removed)
	}
	if got := len(e.rows()); got != 2 {
		t.Fatalf("%d rows left after the refused prune, want 2", got)
	}
}
