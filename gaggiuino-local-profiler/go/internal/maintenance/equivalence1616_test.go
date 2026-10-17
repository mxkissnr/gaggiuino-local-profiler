package maintenance

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/perfseed"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestEquivalence1616_Maintenance pins GET /api/maintenance (each machine
// and ?machine=all) and ShotCountFor on the #1616 equivalence dataset,
// captured before the stats stopped loading every shot with its curve.
// lastDate is a seed-day-relative passthrough and is left out.
func TestEquivalence1616_Maintenance(t *testing.T) {
	sqlDB, _ := perfseed.OpenEquivalence(t)
	libRepo := library.NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	h := NewHandlers(NewRepository(sqlDB, libRepo), shotsRepo, libRepo, machines.NewRegistry(sqlDB))
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	got := map[string]any{}
	for _, path := range []string{"/api/maintenance", "/api/maintenance?machine=1", "/api/maintenance?machine=2", "/api/maintenance?machine=all"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status = %d", path, rec.Code)
		}
		got[path] = perfseed.Strip(perfseed.DecodeJSON(t, rec.Body.Bytes()), "lastDate")
	}
	counts := map[string]int64{}
	for _, task := range []string{"descaling", "backflush", "grouphead", "gaskets", "waterfilter", "grinder_101", "custom_x"} {
		for _, machineID := range []int64{1, 2, 3} {
			counts[fmt.Sprintf("%s@%d", task, machineID)] = ShotCountFor(shotsRepo, task, machineID)
		}
	}
	got["shotCountFor"] = counts
	perfseed.AssertGolden(t, "maintenance", got)
}
