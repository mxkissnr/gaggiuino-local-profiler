package library

import (
	"database/sql"
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// threeBagBean is the plan's canonical shape for #1606: a past bag already
// emptied by its doses, the bag actually being drawn from (partly consumed),
// and a still-queued bag — with the queued bag LAST in the array, the ordering
// the old array-last / "lowest sortOrder with positive stock_g" convention got
// wrong once the past bag had been used up.
func threeBagBean() Entity {
	return Entity{
		"id": int64(1), "name": "Test Bean",
		"bags": []any{
			Entity{"id": int64(101), "stock_g": float64(250), "openedAt": int64(1000), "sortOrder": int64(0)},
			Entity{"id": int64(102), "stock_g": float64(250), "openedAt": int64(2000), "sortOrder": int64(1)},
			Entity{"id": int64(103), "stock_g": float64(250), "openedAt": int64(3000), "sortOrder": int64(2)},
		},
	}
}

func ptrFloat(v float64) *float64 { return &v }

// threeBagDoses empties bag 101 (the past bag) and partly consumes bag 102:
// 250g drawn first (exhausts the queue head), then 100g from the next bag.
func threeBagDoses() []shots.AnnotatedDose {
	beanID := int64(1)
	return []shots.AnnotatedDose{
		{BeanID: &beanID, Dose: ptrFloat(250), Timestamp: 1},
		{BeanID: &beanID, Dose: ptrFloat(100), Timestamp: 2},
	}
}

func bagIDOf(t *testing.T, bag Entity) int64 {
	t.Helper()
	id, ok := idOf(bag, "id")
	if !ok {
		t.Fatalf("bag has no id: %+v", bag)
	}
	return id
}

func TestCurrentBag_ReturnsBagActuallyBeingDrawnFrom(t *testing.T) {
	bean := threeBagBean()
	got := currentBag(bean, threeBagDoses(), []Entity{bean})
	if got == nil {
		t.Fatal("currentBag = nil, want the partly-consumed bag 102")
	}
	if id := bagIDOf(t, got); id != 102 {
		t.Fatalf("currentBag id = %d, want 102 (the past bag 101 is emptied, 103 is still queued)", id)
	}
}

func TestCurrentBag_UntrackedBeanFallsBackToArrayLast(t *testing.T) {
	// No stock_g anywhere (not even bean-level), so SimulateBagQueue resolves
	// nothing — the old array-last convention still applies.
	bean := Entity{
		"id": int64(1), "name": "Test Bean",
		"bags": []any{
			Entity{"id": int64(101)},
			Entity{"id": int64(102)},
			Entity{"id": int64(103)},
		},
	}
	got := currentBag(bean, nil, []Entity{bean})
	if got == nil {
		t.Fatal("currentBag = nil, want the array-last (untracked) bag 103")
	}
	if id := bagIDOf(t, got); id != 103 {
		t.Fatalf("currentBag id = %d, want 103 (array-last fallback for an untracked bean)", id)
	}
}

func TestCurrentBag_AllBagsConsumedReturnsNil(t *testing.T) {
	bean := threeBagBean()
	beanID := int64(1)
	doses := []shots.AnnotatedDose{{BeanID: &beanID, Dose: ptrFloat(750), Timestamp: 1}}
	if got := currentBag(bean, doses, []Entity{bean}); got != nil {
		t.Fatalf("currentBag = %+v, want nil when every tracked bag is empty", got)
	}
}

// insertDose writes one annotated dose straight into the shots/annotations
// tables, the shape GetAnnotatedDoses reads back.
func insertDose(t *testing.T, sqlDB *sql.DB, shotID int64, coffee string, beanID int64, dose float64, timestamp int64) {
	t.Helper()
	if _, err := sqlDB.Exec(
		`INSERT INTO shots (id,timestamp,duration,profile_name,data,machine_id) VALUES (?,?,30,'Default','{}',1)`,
		shotID, timestamp); err != nil {
		t.Fatalf("insert shot: %v", err)
	}
	ann := mustMarshal(t, map[string]any{"coffee": coffee, "beanId": beanID, "dose": dose})
	if _, err := sqlDB.Exec(`INSERT INTO annotations (shot_id,data) VALUES (?,?)`, shotID, string(ann)); err != nil {
		t.Fatalf("insert annotation: %v", err)
	}
}

// seedCurrentBagBean seeds a bean with four tracked bags — past (emptied by
// its doses), current (partly consumed), and two queued bags — and the doses
// that produce that split. IDs: 101 past, 102 current, 103/104 queued.
func seedCurrentBagBean(t *testing.T, repo *Repository, sqlDB *sql.DB) {
	t.Helper()
	bean := Entity{
		"id": int64(1), "name": "Test Bean",
		"bags": []any{
			Entity{"id": int64(101), "stock_g": float64(250), "openedAt": int64(1000), "sortOrder": int64(0)},
			Entity{"id": int64(102), "stock_g": float64(250), "openedAt": int64(2000), "sortOrder": int64(1)},
			Entity{"id": int64(103), "stock_g": float64(250), "openedAt": int64(3000), "sortOrder": int64(2)},
			Entity{"id": int64(104), "stock_g": float64(250), "openedAt": int64(4000), "sortOrder": int64(3)},
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

func seededBagByID(t *testing.T, bean map[string]any, id int64) map[string]any {
	t.Helper()
	bags, _ := bean["bags"].([]any)
	for _, raw := range bags {
		bg, _ := raw.(map[string]any)
		if bid, ok := idOf(Entity(bg), "id"); ok && bid == id {
			return bg
		}
	}
	t.Fatalf("bag %d not found in %+v", id, bean["bags"])
	return nil
}

// TestReorderBags_UpcomingIsTrackedNotCurrentWithStock covers the #1606
// reorder fix over HTTP: with an emptied past bag, only the still-stocked
// queued bags are reorderable. The client may move the second queued bag
// ahead of the first (200), but may not send the current bag (400).
func TestReorderBags_UpcomingIsTrackedNotCurrentWithStock(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	seedCurrentBagBean(t, repo, sqlDB)

	// Move queued bag 104 ahead of queued bag 103.
	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/1/reorder-bags",
		mustMarshal(t, map[string]any{"bagIds": []any{int64(104), int64(103)}}))
	if rec.Code != http.StatusOK {
		t.Fatalf("reorder-bags [104,103] status = %d; body=%s", rec.Code, rec.Body.String())
	}
	bean := decodeBody(t, rec.Body.Bytes())
	q2 := seededBagByID(t, bean, 104)
	q1 := seededBagByID(t, bean, 103)
	if q2["sortOrder"].(float64) >= q1["sortOrder"].(float64) {
		t.Fatalf("sortOrder after reorder: bag104=%v bag103=%v; want 104 before 103", q2["sortOrder"], q1["sortOrder"])
	}
	// The current bag must stay ahead of the reordered queue.
	cur := seededBagByID(t, bean, 102)
	if q2["sortOrder"].(float64) <= cur["sortOrder"].(float64) {
		t.Fatalf("sortOrder after reorder: bag102=%v bag104=%v; want current ahead of the queue", cur["sortOrder"], q2["sortOrder"])
	}

	// Sending the current bag is rejected.
	rec = doJSON(t, mux, http.MethodPost, "/api/library/bean/1/reorder-bags",
		mustMarshal(t, map[string]any{"bagIds": []any{int64(102)}}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("reorder-bags [current] status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestFreezePortions_AttachesToCurrentBag covers the #1606 freeze fix over
// HTTP: the frozen portion lands on the bag actually being drawn from, not
// the emptied past bag and not the array-last queued one.
func TestFreezePortions_AttachesToCurrentBag(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	seedCurrentBagBean(t, repo, sqlDB)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/1/freeze-portions",
		mustMarshal(t, map[string]any{"portionCount": 4, "portionWeight_g": 18}))
	if rec.Code != http.StatusOK {
		t.Fatalf("freeze-portions status = %d; body=%s", rec.Code, rec.Body.String())
	}
	bean := decodeBody(t, rec.Body.Bytes())
	cur := seededBagByID(t, bean, 102)
	fps, _ := cur["frozenPortions"].([]any)
	if len(fps) != 1 {
		t.Fatalf("current bag 102 frozenPortions = %+v, want one batch", cur["frozenPortions"])
	}
	if past := seededBagByID(t, bean, 101); past["frozenPortions"] != nil {
		t.Fatalf("past bag 101 got frozenPortions: %+v", past["frozenPortions"])
	}
	if queued := seededBagByID(t, bean, 103); queued["frozenPortions"] != nil {
		t.Fatalf("queued bag 103 got frozenPortions: %+v", queued["frozenPortions"])
	}
}

// TestUpdateBean_WritesIntoCurrentBag covers the #1606 edit fix: a bean-level
// roastDate change lands on the bag being drawn from and leaves the past and
// queued bags alone (the old code wrote into the array-last, queued bag).
func TestUpdateBean_WritesIntoCurrentBag(t *testing.T) {
	_, repo, _ := newTestHandlers(t)

	bean := threeBagBean()
	if err := repo.Update(func(lib *Library) error {
		lib.Beans = append(lib.Beans, bean)
		return nil
	}); err != nil {
		t.Fatalf("seeding bean: %v", err)
	}

	updated, _, found, err := UpdateBean(repo, 1, Entity{"roastDate": "2026-09-01"}, threeBagDoses())
	if err != nil {
		t.Fatalf("UpdateBean: %v", err)
	}
	if !found {
		t.Fatal("UpdateBean: found = false")
	}
	bags, _ := updated["bags"].([]any)
	byID := make(map[int64]map[string]any, len(bags))
	for _, raw := range bags {
		bg, _ := raw.(map[string]any)
		id, _ := idOf(Entity(bg), "id")
		byID[id] = bg
	}
	if byID[102]["roastDate"] != "2026-09-01" {
		t.Fatalf("current bag 102 roastDate = %v, want 2026-09-01", byID[102]["roastDate"])
	}
	if byID[103]["roastDate"] != nil {
		t.Fatalf("queued bag 103 roastDate = %v, want unchanged (the bug wrote here)", byID[103]["roastDate"])
	}
	if byID[101]["roastDate"] != nil {
		t.Fatalf("past bag 101 roastDate = %v, want unchanged", byID[101]["roastDate"])
	}
}

// TestGetBeansInfo_ReportsCurrentBagsRoastDate covers the #1606 beans-info
// fix: the reported roastDate is the current bag's, not the emptied past
// bag's and not the array-last queued bag's.
func TestGetBeansInfo_ReportsCurrentBagsRoastDate(t *testing.T) {
	bean := threeBagBean()
	bags := bean["bags"].([]any)
	bags[0].(Entity)["roastDate"] = "2026-01-01" // past bag
	bags[1].(Entity)["roastDate"] = "2026-09-10" // current bag
	// queued bag keeps no roastDate

	info := GetBeansInfo(Library{Beans: []Entity{bean}}, threeBagDoses())
	if len(info) != 1 {
		t.Fatalf("GetBeansInfo returned %d beans, want 1", len(info))
	}
	if info[0]["roastDate"] != "2026-09-10" {
		t.Fatalf("roastDate = %v, want 2026-09-10 (the current bag 102's)", info[0]["roastDate"])
	}
}
