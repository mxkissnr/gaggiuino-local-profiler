package library

import (
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// libraryBeanByID reads the bean with the given id back through the real
// GET /api/library route, so every assertion runs on the shape a client sees.
func libraryBeanByID(t *testing.T, mux *http.ServeMux, id int64) map[string]any {
	t.Helper()
	rec := doJSON(t, mux, http.MethodGet, "/api/library", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/library status = %d; body=%s", rec.Code, rec.Body.String())
	}
	for _, raw := range decodeBody(t, rec.Body.Bytes())["beans"].([]any) {
		bean, _ := raw.(map[string]any)
		if bid, ok := bean["id"].(float64); ok && int64(bid) == id {
			return bean
		}
	}
	t.Fatalf("bean %d not found in GET /api/library", id)
	return nil
}

func emptyOfferBagID(t *testing.T, bean map[string]any) (int64, bool) {
	t.Helper()
	// The marker is an int64 in memory (SanitizeBeanFields) and a float64
	// after a JSON round trip.
	switch v := bean["emptyOfferBagId"].(type) {
	case float64:
		return int64(v), true
	case int64:
		return v, true
	case int:
		return int64(v), true
	}
	return 0, false
}

func beanBagIDs(t *testing.T, bean map[string]any) []int64 {
	t.Helper()
	bags, _ := bean["bags"].([]any)
	out := make([]int64, 0, len(bags))
	for _, raw := range bags {
		bag, _ := raw.(map[string]any)
		id, _ := bag["id"].(float64)
		out = append(out, int64(id))
	}
	return out
}

// seedArchivedBean writes one archived bean straight into the library blob.
// bean is the entity to store; callers pass the bags/keys they care about.
func seedArchivedBean(t *testing.T, repo *Repository, bean Entity) {
	t.Helper()
	if err := repo.SaveLibrary(Library{Beans: []Entity{bean}}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}
}

// ── the resolved-offer marker ───────────────────────────────────────────

func TestUpdateBean_EmptyOfferBagId_StoredAndKept(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{"name": "Test Bean"}))
	bean := decodeBody(t, rec.Body.Bytes())
	id := int64(bean["id"].(float64))

	rec = doJSON(t, mux, http.MethodPut, "/api/library/bean/"+itoa(id), mustMarshal(t, map[string]any{"emptyOfferBagId": 101}))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got, ok := emptyOfferBagID(t, decodeBody(t, rec.Body.Bytes())); !ok || got != 101 {
		t.Fatalf("emptyOfferBagId = %v (present %v), want 101", got, ok)
	}

	// A later PUT that omits the key must not clear it.
	rec = doJSON(t, mux, http.MethodPut, "/api/library/bean/"+itoa(id), mustMarshal(t, map[string]any{"notes": "still here"}))
	if got, ok := emptyOfferBagID(t, decodeBody(t, rec.Body.Bytes())); !ok || got != 101 {
		t.Fatalf("emptyOfferBagId after an unrelated PUT = %v (present %v), want 101", got, ok)
	}

	// And it is part of what GET /api/library returns.
	if got, ok := emptyOfferBagID(t, libraryBeanByID(t, mux, id)); !ok || got != 101 {
		t.Fatalf("emptyOfferBagId in GET /api/library = %v (present %v), want 101", got, ok)
	}
}

func TestUpdateBean_EmptyOfferBagId_NeverMovesBack(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{"name": "Test Bean"}))
	bean := decodeBody(t, rec.Body.Bytes())
	id := int64(bean["id"].(float64))
	path := "/api/library/bean/" + itoa(id)

	rec = doJSON(t, mux, http.MethodPut, path, mustMarshal(t, map[string]any{"emptyOfferBagId": 101}))
	if got, ok := emptyOfferBagID(t, decodeBody(t, rec.Body.Bytes())); !ok || got != 101 {
		t.Fatalf("emptyOfferBagId = %v, want 101", got)
	}
	rec = doJSON(t, mux, http.MethodPut, path, mustMarshal(t, map[string]any{"emptyOfferBagId": 50}))
	if got, _ := emptyOfferBagID(t, decodeBody(t, rec.Body.Bytes())); got != 101 {
		t.Fatalf("emptyOfferBagId = %d after a lower write, want 101 (it only moves forward)", got)
	}
	rec = doJSON(t, mux, http.MethodPut, path, mustMarshal(t, map[string]any{"emptyOfferBagId": 102}))
	if got, _ := emptyOfferBagID(t, decodeBody(t, rec.Body.Bytes())); got != 102 {
		t.Fatalf("emptyOfferBagId = %d after a higher write, want 102", got)
	}
}

func TestUpdateBean_EmptyOfferBagId_InvalidIgnored(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{"name": "Test Bean"}))
	bean := decodeBody(t, rec.Body.Bytes())
	id := int64(bean["id"].(float64))
	path := "/api/library/bean/" + itoa(id)
	doJSON(t, mux, http.MethodPut, path, mustMarshal(t, map[string]any{"emptyOfferBagId": 101}))

	for _, bad := range []any{-1, "abc", nil} {
		rec = doJSON(t, mux, http.MethodPut, path, mustMarshal(t, map[string]any{"emptyOfferBagId": bad, "notes": "saved anyway"}))
		if rec.Code != http.StatusOK {
			t.Fatalf("PUT %v status = %d; body=%s", bad, rec.Code, rec.Body.String())
		}
		updated := decodeBody(t, rec.Body.Bytes())
		if got, _ := emptyOfferBagID(t, updated); got != 101 {
			t.Errorf("emptyOfferBagId = %d after writing %v, want the stored 101", got, bad)
		}
		if updated["notes"] != "saved anyway" {
			t.Errorf("notes = %v after writing emptyOfferBagId %v, want the rest of the body saved", updated["notes"], bad)
		}
	}
}

func TestSanitizeBeanFields_KeepsEmptyOfferBagId(t *testing.T) {
	restored := SanitizeBeanFields(Entity{
		"id": int64(1), "name": "Test Bean", "enabled": false, "emptyOfferBagId": int64(100),
	})
	if got, ok := emptyOfferBagID(t, restored); !ok || got != 100 {
		t.Fatalf("emptyOfferBagId = %v (present %v) after SanitizeBeanFields, want 100", got, ok)
	}
	if enabled, _ := restored["enabled"].(bool); enabled {
		t.Fatalf("enabled = %v after SanitizeBeanFields, want false", restored["enabled"])
	}
}

// ── archiving does not touch stock, doses or bean resolution ─────────────

func TestUpdateBean_ArchiveKeepsShotsAndStock(t *testing.T) {
	h, repo, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	seedArchivedBean(t, repo, Entity{
		"id": float64(1), "name": "Test Bean",
		"bags": []any{Entity{"id": float64(101), "stock_g": float64(18), "openedAt": float64(1000), "sortOrder": float64(0)}},
	})
	insertDose(t, sqlDB, 1, "Test Bean", 1, 18, 1700000000)

	before := libraryBeanByID(t, mux, 1)
	if before["remainingG"] != float64(0) || before["consumedG"] != float64(18) {
		t.Fatalf("seeded remainingG/consumedG = %v/%v, want 0/18", before["remainingG"], before["consumedG"])
	}

	rec := doJSON(t, mux, http.MethodPut, "/api/library/bean/1", mustMarshal(t, map[string]any{"enabled": false, "emptyOfferBagId": 101}))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d; body=%s", rec.Code, rec.Body.String())
	}

	after := libraryBeanByID(t, mux, 1)
	if enabled, _ := after["enabled"].(bool); enabled {
		t.Fatalf("enabled = %v after archiving, want false", after["enabled"])
	}
	if after["remainingG"] != before["remainingG"] || after["consumedG"] != before["consumedG"] {
		t.Errorf("remainingG/consumedG = %v/%v after archiving, want %v/%v",
			after["remainingG"], after["consumedG"], before["remainingG"], before["consumedG"])
	}
	if got, want := beanBagIDs(t, after), beanBagIDs(t, before); len(got) != len(want) || got[0] != want[0] {
		t.Errorf("bags = %v after archiving, want %v", got, want)
	}
	if got, ok := emptyOfferBagID(t, after); !ok || got != 101 {
		t.Errorf("emptyOfferBagId = %v (present %v), want 101", got, ok)
	}

	doses, err := h.shotsRepo.GetAnnotatedDoses()
	if err != nil {
		t.Fatalf("GetAnnotatedDoses: %v", err)
	}
	if len(doses) != 1 || doses[0].Dose == nil || *doses[0].Dose != 18 {
		t.Fatalf("GetAnnotatedDoses = %+v after archiving, want the one 18 g row", doses)
	}

	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	resolved := ResolveBeanForShot(shots.Shot{"annotation": map[string]any{"beanId": float64(1)}}, lib.Beans)
	if resolved == nil {
		t.Fatal("ResolveBeanForShot returned nil for an archived bean's shot")
	}
}

// ── a new bag reactivates an archived bean ──────────────────────────────

// archivedBy lists the ways a bean can end up archived and the request that
// archives it, so the reactivation test proves the new-bag rule is
// independent of how the flag got set.
func archivedBy(t *testing.T, mux *http.ServeMux, repo *Repository, id int64, how string) {
	t.Helper()
	switch how {
	case "toggle-active":
		rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/toggle-active", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("toggle-active status = %d; body=%s", rec.Code, rec.Body.String())
		}
	case "put":
		rec := doJSON(t, mux, http.MethodPut, "/api/library/bean/"+itoa(id), mustMarshal(t, map[string]any{"enabled": false}))
		if rec.Code != http.StatusOK {
			t.Fatalf("PUT enabled:false status = %d; body=%s", rec.Code, rec.Body.String())
		}
	case "seeded":
		seedArchivedBean(t, repo, Entity{
			"id": float64(1), "name": "Test Bean", "enabled": false, "emptyOfferBagId": float64(101),
			"bags": []any{},
		})
	default:
		t.Fatalf("unknown archive path %q", how)
	}
}

func TestNewBag_ReactivatesArchivedBean(t *testing.T) {
	for _, how := range []string{"toggle-active", "put", "seeded"} {
		t.Run(how, func(t *testing.T) {
			h, repo, _ := newTestHandlers(t)
			mux := newMux(h)

			var id int64
			if how == "seeded" {
				id = 1
			} else {
				rec := doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{"name": "Test Bean", "stock_g": 250}))
				created := decodeBody(t, rec.Body.Bytes())
				id = int64(created["id"].(float64))
				// The marker to prove reactivation leaves it alone.
				doJSON(t, mux, http.MethodPut, "/api/library/bean/"+itoa(id), mustMarshal(t, map[string]any{"emptyOfferBagId": 101}))
			}
			archivedBy(t, mux, repo, id, how)

			rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/new-bag", mustMarshal(t, map[string]any{"stock_g": 250}))
			if rec.Code != http.StatusOK {
				t.Fatalf("new-bag status = %d; body=%s", rec.Code, rec.Body.String())
			}
			bean := decodeBody(t, rec.Body.Bytes())
			if enabled, _ := bean["enabled"].(bool); !enabled {
				t.Fatalf("enabled = %v after a new bag with stock, want true", bean["enabled"])
			}
			if got, ok := emptyOfferBagID(t, bean); !ok || got != 101 {
				t.Errorf("emptyOfferBagId = %v (present %v) after reactivation, want the earlier 101", got, ok)
			}

			lib, err := repo.GetLibrary()
			if err != nil {
				t.Fatalf("GetLibrary: %v", err)
			}
			doses, err := h.shotsRepo.GetAnnotatedDoses()
			if err != nil {
				t.Fatalf("GetAnnotatedDoses: %v", err)
			}
			active := GetActiveBeans(lib, doses)
			found := false
			for _, b := range active {
				if bid, ok := idOf(b, "id"); ok && bid == id {
					found = true
				}
			}
			if !found {
				t.Fatalf("GetActiveBeans = %+v after reactivation, want bean %d listed", active, id)
			}
		})
	}
}

func TestNewBag_WithoutStockDoesNotReactivate(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
	}{
		{name: "absent", body: map[string]any{"batchNumber": "B-1"}},
		{name: "zero", body: map[string]any{"stock_g": 0}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, repo, _ := newTestHandlers(t)
			mux := newMux(h)
			seedArchivedBean(t, repo, Entity{"id": float64(1), "name": "Test Bean", "enabled": false, "bags": []any{}})

			rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/1/new-bag", mustMarshal(t, tc.body))
			if rec.Code != http.StatusOK {
				t.Fatalf("new-bag status = %d; body=%s", rec.Code, rec.Body.String())
			}
			bean := decodeBody(t, rec.Body.Bytes())
			if enabled, _ := bean["enabled"].(bool); enabled {
				t.Fatalf("enabled = %v after a stockless new bag, want false", bean["enabled"])
			}
			if got := beanBagIDs(t, bean); len(got) != 1 {
				t.Fatalf("bags = %v after a stockless new bag, want exactly one appended bag", got)
			}
		})
	}
}

func TestNewBag_PlaceholderFillDoesNotReactivate(t *testing.T) {
	h, repo, _ := newTestHandlers(t)
	mux := newMux(h)
	seedArchivedBean(t, repo, Entity{
		"id": float64(1), "name": "Test Bean", "enabled": false,
		"bags": []any{Entity{"id": float64(101), "roastDate": "2024-01-01", "openedAt": float64(1000), "sortOrder": float64(0)}},
	})

	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/1/new-bag", mustMarshal(t, map[string]any{"stock_g": 250}))
	if rec.Code != http.StatusOK {
		t.Fatalf("new-bag status = %d; body=%s", rec.Code, rec.Body.String())
	}
	bean := decodeBody(t, rec.Body.Bytes())
	if enabled, _ := bean["enabled"].(bool); enabled {
		t.Fatalf("enabled = %v after filling the placeholder, want false", bean["enabled"])
	}
	ids := beanBagIDs(t, bean)
	if len(ids) != 1 || ids[0] != 101 {
		t.Fatalf("bags = %v after filling the placeholder, want the same single bag 101", ids)
	}
}

func TestNewBag_ActiveBeanUntouched(t *testing.T) {
	t.Run("no enabled key", func(t *testing.T) {
		h, repo, _ := newTestHandlers(t)
		mux := newMux(h)
		seedArchivedBean(t, repo, Entity{"id": float64(1), "name": "Test Bean", "bags": []any{}})

		rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/1/new-bag", mustMarshal(t, map[string]any{"stock_g": 250}))
		bean := decodeBody(t, rec.Body.Bytes())
		if v, present := bean["enabled"]; present {
			t.Fatalf("enabled = %v after a new bag on a bean without the key, want the key to stay absent", v)
		}
	})

	t.Run("enabled true", func(t *testing.T) {
		h, repo, _ := newTestHandlers(t)
		mux := newMux(h)
		seedArchivedBean(t, repo, Entity{"id": float64(1), "name": "Test Bean", "enabled": true, "bags": []any{}})

		rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/1/new-bag", mustMarshal(t, map[string]any{"stock_g": 250}))
		bean := decodeBody(t, rec.Body.Bytes())
		if enabled, ok := bean["enabled"].(bool); !ok || !enabled {
			t.Fatalf("enabled = %v after a new bag on an active bean, want true", bean["enabled"])
		}
	})
}

func TestEditingExistingBagDoesNotReactivate(t *testing.T) {
	h, repo, _ := newTestHandlers(t)
	mux := newMux(h)
	seedArchivedBean(t, repo, Entity{
		"id": float64(1), "name": "Test Bean", "enabled": false,
		"bags": []any{Entity{"id": float64(101), "stock_g": float64(10), "openedAt": float64(1000), "sortOrder": float64(0)}},
	})

	rec := doJSON(t, mux, http.MethodPut, "/api/library/bean/1/bag/101", mustMarshal(t, map[string]any{"stock_g": 250}))
	if rec.Code != http.StatusOK {
		t.Fatalf("bag PUT status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if enabled, _ := decodeBody(t, rec.Body.Bytes())["enabled"].(bool); enabled {
		t.Fatal("editing an existing bag reactivated the bean; only a genuinely new bag may")
	}
}

func TestUnrelatedBeanUpdateDoesNotReactivate(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
	}{
		{name: "notes", body: map[string]any{"notes": "a note"}},
		{name: "stock_g", body: map[string]any{"stock_g": 250}},
		{name: "emptyOfferBagId", body: map[string]any{"emptyOfferBagId": 101}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, repo, _ := newTestHandlers(t)
			mux := newMux(h)
			seedArchivedBean(t, repo, Entity{
				"id": float64(1), "name": "Test Bean", "enabled": false,
				"bags": []any{Entity{"id": float64(101), "stock_g": float64(10), "openedAt": float64(1000), "sortOrder": float64(0)}},
			})

			rec := doJSON(t, mux, http.MethodPut, "/api/library/bean/1", mustMarshal(t, tc.body))
			if rec.Code != http.StatusOK {
				t.Fatalf("PUT status = %d; body=%s", rec.Code, rec.Body.String())
			}
			if enabled, _ := decodeBody(t, rec.Body.Bytes())["enabled"].(bool); enabled {
				t.Fatalf("a bean update with %s reactivated the bean; only a new bag may", tc.name)
			}
		})
	}
}

func TestReArchivedBeanStaysArchivedUntilNextNewBag(t *testing.T) {
	h, repo, _ := newTestHandlers(t)
	mux := newMux(h)
	seedArchivedBean(t, repo, Entity{
		"id": float64(1), "name": "Test Bean", "enabled": false,
		"bags": []any{Entity{"id": float64(101), "stock_g": float64(10), "openedAt": float64(1000), "sortOrder": float64(0)}},
	})
	const path = "/api/library/bean/1"

	rec := doJSON(t, mux, http.MethodPost, path+"/new-bag", mustMarshal(t, map[string]any{"stock_g": 250}))
	if enabled, _ := decodeBody(t, rec.Body.Bytes())["enabled"].(bool); !enabled {
		t.Fatal("first new bag did not reactivate the bean")
	}
	rec = doJSON(t, mux, http.MethodPost, path+"/toggle-active", nil)
	if enabled, _ := decodeBody(t, rec.Body.Bytes())["enabled"].(bool); enabled {
		t.Fatal("toggle-active did not archive the bean again")
	}
	rec = doJSON(t, mux, http.MethodPut, path+"/bag/101", mustMarshal(t, map[string]any{"stock_g": 300}))
	if enabled, _ := decodeBody(t, rec.Body.Bytes())["enabled"].(bool); enabled {
		t.Fatal("a bag edit re-armed the bean; it must stay archived until the next new bag")
	}
	rec = doJSON(t, mux, http.MethodPut, path, mustMarshal(t, map[string]any{"notes": "still archived"}))
	if enabled, _ := decodeBody(t, rec.Body.Bytes())["enabled"].(bool); enabled {
		t.Fatal("a bean update re-armed the bean; it must stay archived until the next new bag")
	}
	rec = doJSON(t, mux, http.MethodPost, path+"/new-bag", mustMarshal(t, map[string]any{"stock_g": 250}))
	if enabled, _ := decodeBody(t, rec.Body.Bytes())["enabled"].(bool); !enabled {
		t.Fatal("the next new bag with stock did not reactivate the bean")
	}
}
