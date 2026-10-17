package shots

import (
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
		for _, key := range []string{`"timestamp"`, `"annotation"`} {
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
