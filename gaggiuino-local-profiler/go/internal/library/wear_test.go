package library

import (
	"database/sql"
	"encoding/json"
	"testing"
)

// wear_test.go covers #951's single-scan grinder-wear enrichment: GET
// /api/library folded every grinder through a fresh full shot scan
// (ComputeGrinderWearStats per grinder); it now loads the shots once and
// runs ComputeGrinderWearFrom per grinder. Both must yield identical
// numbers.

func insertWearShot(t testing.TB, sqlDB *sql.DB, id, ts int64, grinder string, dose float64) {
	t.Helper()
	if _, err := sqlDB.Exec(
		`INSERT INTO shots (id, timestamp, duration, profile_name, data, machine_id) VALUES (?,?,?,?,?,1)`,
		id, ts, 280, "V60", `{"datapoints":{}}`,
	); err != nil {
		t.Fatalf("insert shot %d: %v", id, err)
	}
	ann, _ := json.Marshal(map[string]any{"grinder": grinder, "dose": dose})
	if _, err := sqlDB.Exec(`INSERT INTO annotations (shot_id, data) VALUES (?, ?)`, id, string(ann)); err != nil {
		t.Fatalf("insert annotation %d: %v", id, err)
	}
}

func TestGrinderWear_SinglePassMatchesPerGrinder(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)

	insertWearShot(t, sqlDB, 1, 1000, "Niche Zero", 18.0)
	insertWearShot(t, sqlDB, 2, 2000, "niche zero", 18.5) // case-insensitive match
	insertWearShot(t, sqlDB, 3, 3000, "Eureka Mignon", 20.0)
	insertWearShot(t, sqlDB, 4, 4000, "Unknown Grinder", 17.0)

	grinders := []Entity{
		{"name": "Niche Zero"},
		{"name": "Eureka Mignon"},
		{"name": "DF64"},
	}

	allShots, err := h.shotsRepo.FindAllExcludingTrash()
	if err != nil {
		t.Fatal(err)
	}

	for _, g := range grinders {
		wantShots, wantGrams, err := ComputeGrinderWearStats(h.shotsRepo, g)
		if err != nil {
			t.Fatal(err)
		}
		gotShots, gotGrams := ComputeGrinderWearFrom(allShots, g)
		if gotShots != wantShots || gotGrams != wantGrams {
			t.Errorf("%s: single-pass wear = (%d, %g), per-grinder = (%d, %g)",
				g["name"], gotShots, gotGrams, wantShots, wantGrams)
		}
	}

	want := map[string][2]float64{
		"Niche Zero":    {2, 36.5},
		"Eureka Mignon": {1, 20},
		"DF64":          {0, 0},
	}
	for _, g := range grinders {
		s, gr := ComputeGrinderWearFrom(allShots, g)
		name := g["name"].(string)
		if got := ([2]float64{float64(s), gr}); got != want[name] {
			t.Errorf("%s wear = %v, want %v", name, got, want[name])
		}
	}
}

func benchGrinderWear(b *testing.B, singlePass bool) {
	h, _, sqlDB := newTestHandlers(b)
	names := []string{"Niche", "Eureka", "DF64", "Kafatek"}
	grinders := make([]Entity, len(names))
	for i, n := range names {
		grinders[i] = Entity{"name": n}
	}
	for i := int64(1); i <= 213; i++ {
		insertWearShot(b, sqlDB, i, 1000+i, names[i%4], 18.0)
	}

	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		if singlePass {
			allShots, err := h.shotsRepo.FindAllExcludingTrash()
			if err != nil {
				b.Fatal(err)
			}
			for _, g := range grinders {
				ComputeGrinderWearFrom(allShots, g)
			}
		} else {
			for _, g := range grinders {
				if _, _, err := ComputeGrinderWearStats(h.shotsRepo, g); err != nil {
					b.Fatal(err)
				}
			}
		}
	}
}

func BenchmarkGrinderWear_SinglePass(b *testing.B) { benchGrinderWear(b, true) }
func BenchmarkGrinderWear_PerGrinder(b *testing.B) { benchGrinderWear(b, false) }
