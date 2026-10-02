package orders

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newCompleteOrderService wires a Service over a throwaway SQLite DB — the
// same cross-domain wiring callback_test.go uses — so CompleteOrder's shot
// matching (#1197) can be exercised end to end.
func newCompleteOrderService(t *testing.T) (*Service, *Repository, *shots.Repository) {
	t.Helper()
	t.Setenv("GLP_ENABLE_ORDERS", "true")
	sqlDB, err := db.Open(filepath.Join(t.TempDir(), "glp.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	repo := NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)
	haClient := ha.NewClientFromEnv()
	return NewService(repo, shotsRepo, libRepo, registry, haClient), repo, shotsRepo
}

// seedShotOnMachine1 stores a machine-1 shot with an existing annotation, so
// a test can assert CompleteOrder neither steals it nor overwrites its
// annotation when it is not the order's shot.
func seedShotOnMachine1(t *testing.T, repo *shots.Repository, id, timestamp int64) {
	t.Helper()
	if err := repo.Upsert(shots.Shot{
		"id":         id,
		"timestamp":  timestamp,
		"datapoints": []any{},
		"machineId":  int64(1),
		"annotation": map[string]any{"rating": 4},
	}); err != nil {
		t.Fatalf("seeding shot %d: %v", id, err)
	}
}

// completeOrderAt places a fresh order, stamps acceptedAt (when non-zero) the
// way AcceptOrder would, and completes it.
func completeOrderAt(t *testing.T, svc *Service, repo *Repository, acceptedMs int64) Order {
	t.Helper()
	order, err := svc.PlaceOrder(PlaceOrderInput{Item: "Espresso", Customer: "Alice"})
	if err != nil {
		t.Fatalf("PlaceOrder: %v", err)
	}
	if acceptedMs != 0 {
		order["acceptedAt"] = acceptedMs
		if err := repo.SaveAll([]Order{order}); err != nil {
			t.Fatalf("SaveAll order with acceptedAt: %v", err)
		}
	}
	done, err := svc.CompleteOrder(order["id"].(string))
	if err != nil {
		t.Fatalf("CompleteOrder: %v", err)
	}
	return done
}

// TestCompleteOrder_NoShotForOrderLeavesOlderShotAlone is the #1197
// regression: with no shot pulled for the order, an older shot must not be
// attached, and its annotation must keep whatever it already had.
func TestCompleteOrder_NoShotForOrderLeavesOlderShotAlone(t *testing.T) {
	svc, repo, shotsRepo := newCompleteOrderService(t)
	now := time.Now()
	seedShotOnMachine1(t, shotsRepo, 1, now.Unix()-300) // 5 min before the order

	done := completeOrderAt(t, svc, repo, now.UnixMilli())
	if done["shotId"] != nil {
		t.Fatalf("shotId = %v, want nil (no shot was pulled for this order)", done["shotId"])
	}
	ann, err := shotsRepo.GetAnnotation(1)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	if _, ok := ann["orderedBy"]; ok {
		t.Fatalf("older shot's annotation got orderedBy = %v, want none", ann["orderedBy"])
	}
	if ann["rating"] != float64(4) {
		t.Fatalf("older shot's existing annotation was changed: %v", ann)
	}
}

// TestCompleteOrder_ShotAfterAcceptIsLinked pins the happy path: a shot
// pulled after the order was accepted is the order's and gets the orderedBy
// annotation.
func TestCompleteOrder_ShotAfterAcceptIsLinked(t *testing.T) {
	svc, repo, shotsRepo := newCompleteOrderService(t)
	now := time.Now()
	seedShotOnMachine1(t, shotsRepo, 7, now.Unix()+5)

	done := completeOrderAt(t, svc, repo, now.UnixMilli())
	id, ok := jsNumber(done["shotId"])
	if !ok || int64(id) != 7 {
		t.Fatalf("shotId = %v, want 7", done["shotId"])
	}
	ann, err := shotsRepo.GetAnnotation(7)
	if err != nil {
		t.Fatalf("GetAnnotation: %v", err)
	}
	orderedBy, ok := ann["orderedBy"].(map[string]any)
	if !ok {
		t.Fatalf("orderedBy = %v, want a map", ann["orderedBy"])
	}
	if orderedBy["orderId"] != done["id"] {
		t.Fatalf("orderedBy.orderId = %v, want %v", orderedBy["orderId"], done["id"])
	}
}

// TestCompleteOrder_ShotWithinToleranceIsLinked covers the 120s grace: a shot
// pulled just before the barista taps accept still belongs to the order.
func TestCompleteOrder_ShotWithinToleranceIsLinked(t *testing.T) {
	svc, repo, shotsRepo := newCompleteOrderService(t)
	now := time.Now()
	seedShotOnMachine1(t, shotsRepo, 3, now.Unix()-60) // inside the tolerance

	done := completeOrderAt(t, svc, repo, now.UnixMilli())
	id, ok := jsNumber(done["shotId"])
	if !ok || int64(id) != 3 {
		t.Fatalf("shotId = %v, want 3 (within the %ds tolerance)", done["shotId"], orderShotToleranceSec)
	}
}

// TestCompleteOrder_NoAcceptedAtUsesCreatedAt covers an order completed
// straight from pending: the reference time falls back to createdAt.
func TestCompleteOrder_NoAcceptedAtUsesCreatedAt(t *testing.T) {
	svc, repo, shotsRepo := newCompleteOrderService(t)
	now := time.Now()
	seedShotOnMachine1(t, shotsRepo, 9, now.Unix()) // at/after createdAt

	done := completeOrderAt(t, svc, repo, 0) // no acceptedAt
	id, ok := jsNumber(done["shotId"])
	if !ok || int64(id) != 9 {
		t.Fatalf("shotId = %v, want 9 (createdAt reference)", done["shotId"])
	}

	// A shot well before createdAt is excluded, proving the createdAt floor
	// is applied rather than a sinceSec of 0.
	svc2, repo2, shotsRepo2 := newCompleteOrderService(t)
	now2 := time.Now()
	seedShotOnMachine1(t, shotsRepo2, 11, now2.Unix()-300)
	done2 := completeOrderAt(t, svc2, repo2, 0)
	if done2["shotId"] != nil {
		t.Fatalf("shotId = %v, want nil (createdAt floor must exclude the old shot)", done2["shotId"])
	}
}
