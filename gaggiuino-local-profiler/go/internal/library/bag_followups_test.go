package library

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"
)

// seedDeletableBagBean seeds a bean with an emptied past bag, a current bag
// whose roast date is A, and two still-queued bags ending in the array-last
// bag with a different roast date — the shape where the old deleteBag synced
// the bean-level roast date from the array-last (queued) bag rather than the
// current one. Bag ids: 101 past, 102 current, 103/104 queued.
func seedDeletableBagBean(t *testing.T, repo *Repository, sqlDB *sql.DB) {
	t.Helper()
	bean := Entity{
		"id": int64(1), "name": "Test Bean", "roastDate": "2026-09-10",
		"bags": []any{
			Entity{"id": int64(101), "stock_g": float64(250), "openedAt": int64(1000), "sortOrder": int64(0), "roastDate": "2026-08-01"},
			Entity{"id": int64(102), "stock_g": float64(250), "openedAt": int64(2000), "sortOrder": int64(1), "roastDate": "2026-09-10"},
			Entity{"id": int64(103), "stock_g": float64(250), "openedAt": int64(3000), "sortOrder": int64(2), "roastDate": "2026-09-20"},
			Entity{"id": int64(104), "stock_g": float64(250), "openedAt": int64(4000), "sortOrder": int64(3), "roastDate": "2026-09-25"},
		},
	}
	if err := repo.Update(func(lib *Library) error {
		lib.Beans = append(lib.Beans, bean)
		return nil
	}); err != nil {
		t.Fatalf("seeding bean: %v", err)
	}
	insertDose(t, sqlDB, 1, "Test Bean", 1, 250, 1) // empties the past bag
	insertDose(t, sqlDB, 2, "Test Bean", 1, 100, 2) // partly consumes the current bag
}

// TestDeleteBag_UnknownBagReturns404 covers #1606: deleting a bag id that
// matches nothing must 404 and leave the bean untouched, not answer 200 as if
// something happened.
func TestDeleteBag_UnknownBagReturns404(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	seedDeletableBagBean(t, repo, sqlDB)

	rec := doJSON(t, mux, http.MethodDelete, "/api/library/bean/1/bag/999", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete unknown bag status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Beans) != 1 {
		t.Fatalf("beans = %d, want 1", len(lib.Beans))
	}
	bags, _ := lib.Beans[0]["bags"].([]any)
	if len(bags) != 4 {
		t.Fatalf("bags after unknown delete = %d, want the original 4 unchanged", len(bags))
	}
}

// TestDeleteBag_SyncsBeanRoastDateFromCurrentBag covers #1606: after deleting
// a queued bag the bean-level roast date must come from the bag being drawn
// from (102, 2026-09-10), not the array-last queued bag (103, 2026-09-20) the
// old code synced from.
func TestDeleteBag_SyncsBeanRoastDateFromCurrentBag(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	seedDeletableBagBean(t, repo, sqlDB)

	rec := doJSON(t, mux, http.MethodDelete, "/api/library/bean/1/bag/104", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete queued bag status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	bean := decodeBody(t, rec.Body.Bytes())
	if bean["roastDate"] != "2026-09-10" {
		t.Fatalf("bean roastDate = %v, want 2026-09-10 (the current bag 102's, not the queued 103's 2026-09-20)", bean["roastDate"])
	}
	if bags, _ := bean["bags"].([]any); len(bags) != 3 {
		t.Fatalf("bags after delete = %d, want 3", len(bags))
	}
}

// TestFreezePortions_UniqueIDsForSameFrozenAt covers #1606: two freezes with
// the same frozenAt must still get distinct server-side ids, so thaw/adjust
// never hit the wrong batch.
func TestFreezePortions_UniqueIDsForSameFrozenAt(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	seedCurrentBagBean(t, repo, sqlDB)

	body := mustMarshal(t, map[string]any{"frozenAt": 111, "portionCount": 4, "portionWeight_g": 18})
	for i := 0; i < 2; i++ {
		rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/1/freeze-portions", body)
		if rec.Code != http.StatusOK {
			t.Fatalf("freeze #%d status = %d; body=%s", i+1, rec.Code, rec.Body.String())
		}
	}

	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	var cur Entity
	for _, raw := range bagsOf(lib.Beans[0]) {
		bg, _ := raw.(Entity)
		if id, ok := idOf(bg, "id"); ok && id == 102 {
			cur = bg
		}
	}
	if cur == nil {
		t.Fatal("current bag 102 not found after freezing")
	}
	fps, _ := cur["frozenPortions"].([]any)
	if len(fps) != 2 {
		t.Fatalf("frozenPortions = %+v, want two batches", cur["frozenPortions"])
	}
	ids := make(map[int64]bool, len(fps))
	for _, raw := range fps {
		fp, _ := raw.(Entity)
		id, ok := idOf(fp, "id")
		if !ok {
			t.Fatalf("frozen portion has no id: %+v", fp)
		}
		if ids[id] {
			t.Fatalf("duplicate frozen portion id %d across same-frozenAt freezes", id)
		}
		ids[id] = true
	}
}

// TestWriteEnrichedBean_DegradesTo200WhenReadFails covers #1606: a read
// failure while decorating a bean response must not turn a saved mutation
// into a 500 the client would retry — it answers 200 with the undecorated
// bean. There is no fake shots repository in this package (shotsRepo is a
// concrete *shots.Repository sharing the library's *sql.DB), so a closed DB
// is used to fail the decoration read: the library read fails first, which is
// the same fall-back branch a failing dose read takes.
func TestWriteEnrichedBean_DegradesTo200WhenReadFails(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	if err := sqlDB.Close(); err != nil {
		t.Fatalf("closing db: %v", err)
	}
	rec := httptest.NewRecorder()
	h.writeEnrichedBean(rec, Entity{"id": int64(1), "name": "Test Bean"})
	if rec.Code != http.StatusOK {
		t.Fatalf("writeEnrichedBean status = %d, want 200", rec.Code)
	}
	bean := decodeBody(t, rec.Body.Bytes())
	if bean["name"] != "Test Bean" {
		t.Fatalf("undecorated bean name = %v, want Test Bean", bean["name"])
	}
}

// TestDeleteBag_SkipsSyncWhenDoseReadFails covers #1606: when the shots read
// that feeds currentBag fails, deleteBag must leave the bean-level
// roastDate/stock_g unchanged rather than guess the current bag from no dose
// history and overwrite them with the wrong bag's values.
func TestDeleteBag_SkipsSyncWhenDoseReadFails(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	seedDeletableBagBean(t, repo, sqlDB)
	// Make the bean-level date differ from the current bag's (2026-09-10) so a
	// skipped sync is observable: a sync would change it, a skip leaves it.
	if err := repo.Update(func(lib *Library) error {
		lib.Beans[0]["roastDate"] = "2026-01-01"
		return nil
	}); err != nil {
		t.Fatalf("setting bean-level roast date: %v", err)
	}
	// Fail the shots read (GetAnnotatedDoses joins annotations) while leaving
	// the library DB — and thus repo.Update/GetLibrary — working.
	if _, err := sqlDB.Exec(`DROP TABLE annotations`); err != nil {
		t.Fatalf("dropping annotations: %v", err)
	}

	rec := doJSON(t, mux, http.MethodDelete, "/api/library/bean/1/bag/104", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	bean := decodeBody(t, rec.Body.Bytes())
	if bean["roastDate"] != "2026-01-01" {
		t.Fatalf("bean roastDate = %v, want 2026-01-01 unchanged (sync must be skipped on a dose-read failure)", bean["roastDate"])
	}
}
