package library

import (
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// ComputeGrinderWearFrom is the pre-#1616 wear path, kept for tests as the
// reference over an already-hydrated shot list: it reduces each shot to the GrinderUse the
// wear fold reads and hands them to ComputeGrinderWearFromUses.
func ComputeGrinderWearFrom(allShots []shots.Shot, grinder Entity) (shotsSinceBurrs int, gramsSinceBurrs float64) {
	uses := make([]shots.GrinderUse, len(allShots))
	for i, shot := range allShots {
		ann, _ := shot["annotation"].(map[string]any)
		u := shots.GrinderUse{}
		u.Timestamp, _ = shot["timestamp"].(int64)
		if ann != nil {
			u.Grinder, _ = ann["grinder"].(string)
			u.Dose = ann["dose"]
		}
		uses[i] = u
	}
	return ComputeGrinderWearFromUses(uses, grinder)
}

// TestGrinderUses_MatchesHydratedWear (#1616) pins that the SQL-side
// GrinderUses read folds to exactly the wear the hydrate-every-shot path
// computes, on rows built to hit each hydration rule it has to mirror: a
// data blob whose own "timestamp" key overrides the column (read as 0), a
// legacy annotation stored in the data blob, a null annotation, a
// non-string grinder, string and missing doses, and a trashed shot.
func TestGrinderUses_MatchesHydratedWear(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	rows := []struct {
		id, ts int64
		data   string
		ann    string // "" = no annotations row
	}{
		{1, 1000, `{"datapoints":{}}`, `{"grinder":"Niche Zero","dose":18}`},
		{2, 2000, `{"datapoints":{},"timestamp":5}`, `{"grinder":"Niche Zero","dose":18.25}`},
		{3, 3000, `{"timestamp":null}`, `{"grinder":"niche zero","dose":"17.5g"}`},
		{4, 4000, `{"annotation":{"grinder":"NICHE ZERO","dose":"19.1"}}`, ``},
		{5, 5000, `{"annotation":null}`, ``},
		{6, 6000, `{"annotation":"text"}`, ``},
		{7, 7000, `{}`, `{"grinder":42,"dose":18}`},
		{8, 8000, `{}`, `null`},
		{9, 9000, `{}`, `{"grinder":"Niche Zero"}`},
		{10, 10000, `{}`, `{"grinder":"Niche Zero","dose":true}`},
		{11, 11000, `{}`, `{"grinder":"Niche Zero","dose":[18]}`},
		{12, 12000, `{}`, `{"grinder":"Niche Zero","dose":17.6}`},
		{13, 13000, `{"note":"\"timestamp\" appears only inside a string"}`, `{"grinder":"Niche Zero","dose":16}`},
		{14, 14000, `{}`, `{"grinder":"Mühle","dose":0.1}`},
		{15, 15000, `{}`, `{"grinder":"MÜHLE","dose":0.2}`},
		{16, 16000, `{}`, `{"grinder":"Niche Zero","dose":99}`}, // trashed below
	}
	for _, r := range rows {
		if _, err := sqlDB.Exec(`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,280,'V60',?,1)`, r.id, r.ts, r.data); err != nil {
			t.Fatal(err)
		}
		if r.ann != "" {
			if _, err := sqlDB.Exec(`INSERT INTO annotations (shot_id, data) VALUES (?, ?)`, r.id, r.ann); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := sqlDB.Exec(`INSERT INTO trash (shot_id, deleted_at) VALUES (16, 1)`); err != nil {
		t.Fatal(err)
	}

	allShots, err := h.shotsRepo.FindAllExcludingTrash()
	if err != nil {
		t.Fatal(err)
	}
	uses, err := h.shotsRepo.GrinderUses()
	if err != nil {
		t.Fatal(err)
	}
	if len(uses) != len(allShots) {
		t.Fatalf("GrinderUses returned %d rows, FindAllExcludingTrash %d", len(uses), len(allShots))
	}
	for _, g := range []Entity{
		{"name": "Niche Zero"},
		{"name": "niche zero", "burrsResetAt": "1970-01-01T00:00:02.500Z"},
		{"name": "Niche Zero", "burrsResetAt": "1970-01-01"},
		{"name": "mühle"},
		{"name": ""},
		{"name": "Niche Zero", "burrsResetAt": "garbage"},
	} {
		wantShots, wantGrams := ComputeGrinderWearFrom(allShots, g)
		gotShots, gotGrams := ComputeGrinderWearFromUses(uses, g)
		if gotShots != wantShots || gotGrams != wantGrams {
			t.Errorf("grinder %v: uses = (%d, %v), hydrated = (%d, %v)", g, gotShots, gotGrams, wantShots, wantGrams)
		}
	}
}
