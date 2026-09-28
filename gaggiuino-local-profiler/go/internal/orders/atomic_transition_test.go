package orders

import (
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// newAtomicService wires a Service over a throwaway file-backed SQLite DB and
// hands back the library repository too, so the atomic-transition tests below
// can seed a milk and assert its stock was deducted exactly once.
func newAtomicService(t *testing.T) (*Service, *Repository, *library.Repository) {
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
	return NewService(repo, shotsRepo, libRepo, registry, haClient), repo, libRepo
}

// seedLatte wires the one menu item and one milk stock CompleteOrder's milk
// deduction needs: order item "Latte", variant "Whole Milk", 150 ml per shot.
func seedLatte(t *testing.T, repo *Repository, libRepo *library.Repository) {
	t.Helper()
	if err := repo.SaveMenu([]MenuItem{{"id": "latte", "name": "Latte", "milkMl": 150.0}}); err != nil {
		t.Fatalf("SaveMenu: %v", err)
	}
	if err := libRepo.SaveLibrary(library.Library{Milks: []library.Entity{
		{"id": int64(1), "name": "Whole Milk", "stockMl": 1000.0},
	}}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
}

func milkStock(t *testing.T, libRepo *library.Repository) float64 {
	t.Helper()
	lib, err := libRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	for _, m := range lib.Milks {
		if name, _ := m["name"].(string); name == "Whole Milk" {
			f, _ := m["stockMl"].(float64)
			return f
		}
	}
	t.Fatal("Whole Milk not found in library")
	return 0
}

func placeLatte(t *testing.T, svc *Service) string {
	t.Helper()
	order, err := svc.PlaceOrder(PlaceOrderInput{Item: "Latte", Variant: "Whole Milk", Customer: "Alice"})
	if err != nil {
		t.Fatalf("PlaceOrder: %v", err)
	}
	id, _ := order["id"].(string)
	return id
}

func requireOrderError(t *testing.T, err error, status int) {
	t.Helper()
	var oe *OrderError
	if !errors.As(err, &oe) {
		t.Fatalf("error = %v (%T), want *OrderError", err, err)
	}
	if oe.Status != status {
		t.Fatalf("OrderError.Status = %d, want %d (%v)", oe.Status, status, oe)
	}
}

// TestCompleteOrder_ConcurrentCompleteDeductsMilkOnce is the #1199 regression:
// 20 simultaneous completes of one accepted order must produce exactly one
// winner and one milk deduction, not one deduction per caller.
func TestCompleteOrder_ConcurrentCompleteDeductsMilkOnce(t *testing.T) {
	svc, repo, libRepo := newAtomicService(t)
	seedLatte(t, repo, libRepo)
	id := placeLatte(t, svc)
	if _, err := svc.AcceptOrder(id, 5); err != nil {
		t.Fatalf("AcceptOrder: %v", err)
	}

	const n = 20
	errs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = svc.CompleteOrder(id)
		}(i)
	}
	close(start)
	wg.Wait()

	wins := 0
	for _, err := range errs {
		if err == nil {
			wins++
			continue
		}
		requireOrderError(t, err, 400)
	}
	if wins != 1 {
		t.Fatalf("successful completes = %d, want exactly 1", wins)
	}
	if got := milkStock(t, libRepo); got != 850 {
		t.Fatalf("milk stock = %v, want 850 (150 ml deducted exactly once)", got)
	}
}

// TestCompleteOrder_AlreadyDoneDeductsNothing pins the second half of #1199:
// completing an order that is already done (still inside the 7-day active
// window) returns 400 and must not deduct the milk again.
func TestCompleteOrder_AlreadyDoneDeductsNothing(t *testing.T) {
	svc, repo, libRepo := newAtomicService(t)
	seedLatte(t, repo, libRepo)
	id := placeLatte(t, svc)
	if _, err := svc.AcceptOrder(id, 5); err != nil {
		t.Fatalf("AcceptOrder: %v", err)
	}
	if _, err := svc.CompleteOrder(id); err != nil {
		t.Fatalf("first CompleteOrder: %v", err)
	}
	if got := milkStock(t, libRepo); got != 850 {
		t.Fatalf("milk stock after first complete = %v, want 850", got)
	}

	_, err := svc.CompleteOrder(id)
	requireOrderError(t, err, 400)
	if got := milkStock(t, libRepo); got != 850 {
		t.Fatalf("milk stock after re-complete = %v, want 850 (no second deduction)", got)
	}
}

// TestAcceptOrder_ConcurrentAcceptOnlyOneWins: 20 simultaneous accepts of one
// pending order must leave a single winner; every loser gets the 400.
func TestAcceptOrder_ConcurrentAcceptOnlyOneWins(t *testing.T) {
	svc, _, _ := newAtomicService(t)
	id := placeLatte(t, svc)

	const n = 20
	errs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = svc.AcceptOrder(id, 5)
		}(i)
	}
	close(start)
	wg.Wait()

	wins := 0
	for _, err := range errs {
		if err == nil {
			wins++
			continue
		}
		requireOrderError(t, err, 400)
	}
	if wins != 1 {
		t.Fatalf("successful accepts = %d, want exactly 1", wins)
	}
}

// TestDeclineOrder_ConcurrentDeclineOnlyOneWins: 20 simultaneous declines of
// one pending order must leave a single winner.
func TestDeclineOrder_ConcurrentDeclineOnlyOneWins(t *testing.T) {
	svc, _, _ := newAtomicService(t)
	id := placeLatte(t, svc)

	const n = 20
	errs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = svc.DeclineOrder(id, "gone")
		}(i)
	}
	close(start)
	wg.Wait()

	wins := 0
	for _, err := range errs {
		if err == nil {
			wins++
			continue
		}
		requireOrderError(t, err, 400)
	}
	if wins != 1 {
		t.Fatalf("successful declines = %d, want exactly 1", wins)
	}
}

// TestAcceptDeclineOrder_ConcurrentNeverDoubles fires accepts and declines at
// one pending order together. Decline is legal from both pending and accepted,
// so exactly one decline wins; accept can win at most once (it must beat that
// decline). The pre-fix check-then-write let every racer pass its in-memory
// status check, so several could report success.
func TestAcceptDeclineOrder_ConcurrentNeverDoubles(t *testing.T) {
	svc, _, _ := newAtomicService(t)
	id := placeLatte(t, svc)

	const n = 20
	acceptErrs := make([]error, n)
	declineErrs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, acceptErrs[i] = svc.AcceptOrder(id, 5)
		}(i)
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, declineErrs[i] = svc.DeclineOrder(id, "gone")
		}(i)
	}
	close(start)
	wg.Wait()

	acceptWins, declineWins := 0, 0
	for _, err := range acceptErrs {
		if err == nil {
			acceptWins++
		} else {
			requireOrderError(t, err, 400)
		}
	}
	for _, err := range declineErrs {
		if err == nil {
			declineWins++
		} else {
			requireOrderError(t, err, 400)
		}
	}
	if acceptWins > 1 {
		t.Fatalf("successful accepts = %d, want at most 1", acceptWins)
	}
	if declineWins != 1 {
		t.Fatalf("successful declines = %d, want exactly 1", declineWins)
	}
}

// TestCompleteOrder_ConcurrentAcceptKeepsAcceptedFields pins the review
// scenario: when AcceptOrder and CompleteOrder race on one pending order and
// both win their claims, CompleteOrder must not replay a pre-accept snapshot,
// so the acceptedAt/eta the accept wrote survive. A full-row Save here used to
// erase them (and could mis-derive the shot tolerance from a missing acceptedAt).
func TestCompleteOrder_ConcurrentAcceptKeepsAcceptedFields(t *testing.T) {
	svc, repo, _ := newAtomicService(t)
	for i := 0; i < 50; i++ {
		id := placeLatte(t, svc)
		var acceptErr, completeErr error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, acceptErr = svc.AcceptOrder(id, 7)
		}()
		go func() {
			defer wg.Done()
			_, completeErr = svc.CompleteOrder(id)
		}()
		wg.Wait()

		if acceptErr != nil {
			requireOrderError(t, acceptErr, 400)
		}
		if completeErr != nil {
			requireOrderError(t, completeErr, 400)
		}
		if acceptErr != nil || completeErr != nil {
			continue
		}

		row, err := repo.FindByID(id)
		if err != nil {
			t.Fatalf("FindByID: %v", err)
		}
		if row["status"] != "done" {
			t.Fatalf("iteration %d: status = %v, want done", i, row["status"])
		}
		if _, ok := jsNumber(row["acceptedAt"]); !ok {
			t.Fatalf("iteration %d: acceptedAt lost after concurrent accept+complete: %v", i, row)
		}
		if eta, ok := jsNumber(row["eta"]); !ok || eta != 7 {
			t.Fatalf("iteration %d: eta lost after concurrent accept+complete: %v", i, row["eta"])
		}
	}
}
