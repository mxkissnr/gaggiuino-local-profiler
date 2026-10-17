package library

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestEquivalence1616_GrinderWear pins GET /api/library's grinder wear and
// ComputeGrinderWearStats on the #1616 equivalence dataset, captured before
// the wear computation stopped hydrating every shot. Extra grinder entities
// cover the matching rules the library itself does not exercise: an unset
// reset date, an ISO reset timestamp, a case/Unicode-folded name, and a
// name no shot uses.
func TestEquivalence1616_GrinderWear(t *testing.T) {
	sqlDB, _ := perfseed.OpenEquivalence(t)
	shotsRepo := shots.NewRepository(sqlDB)
	h := NewHandlers(NewRepository(sqlDB), shotsRepo)
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/library", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/library: status = %d", rec.Code)
	}
	var lib struct {
		Grinders []map[string]any `json:"grinders"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &lib); err != nil {
		t.Fatal(err)
	}

	extra := []Entity{
		{"name": "Niche Zero"},
		{"name": "niche zero", "burrsResetAt": "2025-03-04T05:06:07.890Z"},
		{"name": "mühle pro", "burrsResetAt": "2023-01-01"},
		{"name": "DF64", "burrsResetAt": "2099-01-01"},
		{"name": "Nobody Uses This"},
		{"name": ""},
	}
	type wear struct {
		Grinder Entity  `json:"grinder"`
		Shots   int     `json:"shotsSinceBurrs"`
		Grams   float64 `json:"gramsSinceBurrs"`
	}
	var stats []wear
	for _, g := range extra {
		s, gr, err := ComputeGrinderWearStats(shotsRepo, g)
		if err != nil {
			t.Fatal(err)
		}
		stats = append(stats, wear{g, s, gr})
	}

	perfseed.AssertGolden(t, "library_grinders", map[string]any{
		"getLibraryGrinders": lib.Grinders,
		"wearStats":          stats,
	})
}
