package shots

import (
	"fmt"
	"testing"
)

// TestTimestamps_ReadTheColumn (#1616) pins the light timestamp reads: every
// non-trashed shot's timestamp column, in FindAllExcludingTrash's order,
// scoped like FindAllExcludingTrashByMachine — including rows whose legacy
// data blob carries its own "timestamp" key, which hydration would read as
// 0 and the light reads deliberately do not.
func TestTimestamps_ReadTheColumn(t *testing.T) {
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
	all, err := repo.TimestampsExcludingTrash()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := fmt.Sprint(all), "[500 1000 2000 2000 3000]"; got != want {
		t.Errorf("TimestampsExcludingTrash = %s, want %s", got, want)
	}
	for m, want := range map[int64]string{0: "[]", 1: "[500 2000 3000]", 2: "[1000 2000]", 3: "[]"} {
		got, err := repo.TimestampsExcludingTrashByMachine(m)
		if err != nil {
			t.Fatal(err)
		}
		if fmt.Sprint(got) != want {
			t.Errorf("TimestampsExcludingTrashByMachine(%d) = %v, want %s", m, got, want)
		}
	}
	for _, m := range []int64{0, 1, 2, 3} {
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
