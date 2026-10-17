package shots

import (
	"fmt"
	"strings"
	"testing"
)

// TestWritersStripLegacyBlobKeys (#1616) pins the invariant lightColumnsSQL's
// per-database memo relies on: no writer stores a top-level "timestamp" or
// "annotation" key in a shot's data blob, so a database checked once and
// found free of them stays free of them.
func TestWritersStripLegacyBlobKeys(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	shot := Shot{
		"id": int64(1), "timestamp": int64(1000), "duration": int64(280),
		"profileName": "V60", "machineId": int64(1),
		"annotation": map[string]any{"grinder": "Niche Zero"},
		"datapoints": map[string]any{"timeInShot": []any{1.0}},
	}
	if err := repo.Upsert(shot); err != nil {
		t.Fatal(err)
	}
	restored := shot.clone()
	restored["id"] = int64(2)
	if err := repo.RestoreShots(RestoreInput{Shots: func(yield func(Shot) error) error {
		for _, s := range []Shot{shot, restored} {
			if err := yield(s); err != nil {
				return err
			}
		}
		return nil
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetImage(2, "jpg"); err != nil {
		t.Fatal(err)
	}
	rows, err := sqlDB.Query(`SELECT id, data FROM shots`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var data string
		if err := rows.Scan(&id, &data); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{`"timestamp"`, `"annotation"`, `"id"`, `"profileName"`} {
			if strings.Contains(data, key) {
				t.Errorf("shot %d: data blob carries %s: %s", id, key, data)
			}
		}
	}
	ts, ann, err := repo.lightColumnsSQL()
	if err != nil {
		t.Fatal(err)
	}
	if ts != "s.timestamp" || ann != "a.data" {
		t.Errorf("lightColumnsSQL = %q, %q; want the plain columns on a clean database", ts, ann)
	}
}

// TestTimestampsMatchHydratedShots (#1616) pins that the light timestamp
// reads return exactly what an int64 read of each hydrated shot sees, in
// the same order, on rows whose data blob overrides the timestamp column.
func TestTimestampsMatchHydratedShots(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	for _, r := range []struct {
		id, ts, machine int64
		data            string
	}{
		{1, 3000, 1, `{}`},
		{2, 1000, 2, `{"timestamp":17}`},
		{3, 2000, 1, `{"timestamp":null,"annotation":{"dose":18}}`},
		{4, 2000, 2, `{"note":"timestamp"}`},
		{5, 500, 1, `{}`},
		{6, 4000, 1, `{}`}, // trashed below
	} {
		if _, err := sqlDB.Exec(`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,280,'V60',?,?)`, r.id, r.ts, r.data, r.machine); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := sqlDB.Exec(`INSERT INTO trash (shot_id, deleted_at) VALUES (6, 1)`); err != nil {
		t.Fatal(err)
	}
	hydratedTS := func(list []Shot) []int64 {
		var out []int64
		for _, s := range list {
			ts, _ := s["timestamp"].(int64)
			out = append(out, ts)
		}
		return out
	}
	all, err := repo.FindAllExcludingTrash()
	if err != nil {
		t.Fatal(err)
	}
	got, err := repo.TimestampsExcludingTrash()
	if err != nil {
		t.Fatal(err)
	}
	if want := hydratedTS(all); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("TimestampsExcludingTrash = %v, hydrated %v", got, want)
	}
	for _, m := range []int64{0, 1, 2, 3} {
		byMachine, err := repo.FindAllExcludingTrashByMachine(m)
		if err != nil {
			t.Fatal(err)
		}
		got, err := repo.TimestampsExcludingTrashByMachine(m)
		if err != nil {
			t.Fatal(err)
		}
		if want := hydratedTS(byMachine); fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("machine %d: TimestampsExcludingTrashByMachine = %v, hydrated %v", m, got, want)
		}
		n, err := repo.CountByMachine(m)
		if err != nil {
			t.Fatal(err)
		}
		var want int
		if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM shots WHERE machine_id = ?`, m).Scan(&want); err != nil {
			t.Fatal(err)
		}
		if n != want {
			t.Errorf("CountByMachine(%d) = %d, want %d", m, n, want)
		}
	}
}

// TestForgetLegacyKeyProbe (#1616): after the memo is dropped, a light read
// probes again and sees a legacy key written behind its back (as a DB file
// replaced under the open handle would bring).
func TestForgetLegacyKeyProbe(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	if _, err := sqlDB.Exec(`INSERT INTO shots (id, timestamp, data, machine_id) VALUES (1, 1000, '{}', 1)`); err != nil {
		t.Fatal(err)
	}
	if ts, _, err := repo.lightColumnsSQL(); err != nil || ts != "s.timestamp" {
		t.Fatalf("clean database: ts = %q, err = %v", ts, err)
	}
	if _, err := sqlDB.Exec(`UPDATE shots SET data = '{"timestamp":5}' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	ForgetLegacyKeyProbe(sqlDB)
	if ts, _, err := repo.lightColumnsSQL(); err != nil || ts != hydratedTimestampSQL {
		t.Fatalf("after ForgetLegacyKeyProbe: ts = %q, err = %v; want the per-row expression", ts, err)
	}
}
