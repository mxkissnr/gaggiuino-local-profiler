package orders

import (
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// TestService_OnQueueChanged_FiresOnEveryLifecycleMethod pins the callback
// internal/web's OrdersHandlers wires (#901) to publish a live orders-update
// SSE event: OnQueueChanged must fire after PlaceOrder, AcceptOrder,
// CompleteOrder, and DeclineOrder each successfully change the active
// queue — regardless of caller, this package's own REST Handlers included,
// not just internal/web's htmx actions (see Service.OnQueueChanged's own
// doc comment for why this lives here, not as a direct internal/web
// import).
func TestService_OnQueueChanged_FiresOnEveryLifecycleMethod(t *testing.T) {
	t.Setenv("GLP_ENABLE_ORDERS", "true")
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	repo := NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)
	haClient := ha.NewClientFromEnv()

	svc := NewService(repo, shotsRepo, libRepo, registry, haClient)
	calls := 0
	svc.OnQueueChanged = func() { calls++ }

	order, err := svc.PlaceOrder(PlaceOrderInput{Item: "Espresso", Customer: "Alice"})
	if err != nil {
		t.Fatalf("PlaceOrder: %v", err)
	}
	if calls != 1 {
		t.Errorf("calls after PlaceOrder = %d, want 1", calls)
	}
	id, _ := order["id"].(string)

	if _, err := svc.AcceptOrder(id, nil); err != nil {
		t.Fatalf("AcceptOrder: %v", err)
	}
	if calls != 2 {
		t.Errorf("calls after AcceptOrder = %d, want 2", calls)
	}

	if _, err := svc.CompleteOrder(id); err != nil {
		t.Fatalf("CompleteOrder: %v", err)
	}
	if calls != 3 {
		t.Errorf("calls after CompleteOrder = %d, want 3", calls)
	}

	order2, err := svc.PlaceOrder(PlaceOrderInput{Item: "Latte", Customer: "Bob"})
	if err != nil {
		t.Fatalf("PlaceOrder (2nd): %v", err)
	}
	id2, _ := order2["id"].(string)
	if calls != 4 {
		t.Errorf("calls after 2nd PlaceOrder = %d, want 4", calls)
	}

	if _, err := svc.DeclineOrder(id2, ""); err != nil {
		t.Fatalf("DeclineOrder: %v", err)
	}
	if calls != 5 {
		t.Errorf("calls after DeclineOrder = %d, want 5", calls)
	}
}

// TestService_OnQueueChanged_NilIsSafe verifies a Service built without ever
// setting OnQueueChanged (every other test in this package, and any caller
// that predates this field) doesn't panic — the common, expected case.
func TestService_OnQueueChanged_NilIsSafe(t *testing.T) {
	t.Setenv("GLP_ENABLE_ORDERS", "true")
	dbPath := filepath.Join(t.TempDir(), "glp.db")
	sqlDB, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })

	repo := NewRepository(sqlDB)
	shotsRepo := shots.NewRepository(sqlDB)
	libRepo := library.NewRepository(sqlDB)
	registry := machines.NewRegistry(sqlDB)
	haClient := ha.NewClientFromEnv()

	svc := NewService(repo, shotsRepo, libRepo, registry, haClient)
	if _, err := svc.PlaceOrder(PlaceOrderInput{Item: "Espresso", Customer: "Alice"}); err != nil {
		t.Fatalf("PlaceOrder with nil OnQueueChanged: %v", err)
	}
}
