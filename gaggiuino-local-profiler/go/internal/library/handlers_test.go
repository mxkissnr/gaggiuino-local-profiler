package library

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func doJSON(t *testing.T, mux *http.ServeMux, method, path string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != nil {
		r = httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	return rec
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// ── GET /api/library, /api/library/beans-info ──────────────────────────────

func TestGetLibrary_EmptyInstall(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/library", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	for _, key := range []string{"beans", "grinders", "recipes", "milks", "baskets", "puckScreens"} {
		v, ok := body[key]
		if !ok {
			t.Fatalf("missing key %q", key)
		}
		arr, ok := v.([]any)
		if !ok || len(arr) != 0 {
			t.Errorf("expected %q to be an empty array, got %+v", key, v)
		}
	}
}

func TestGetBeansInfo_EmptyInstall(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/library/beans-info", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rec.Code, rec.Body.String())
	}
	arr := decodeBodyArray(t, rec.Body.Bytes())
	if len(arr) != 0 {
		t.Errorf("expected empty array, got %+v", arr)
	}
}

// ── Beans ───────────────────────────────────────────────────────────────

func TestBean_CreateRequiresName(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// TestBean_CreateRequiresName_EmptyBody guards against a Go-migration
// regression (#901): a genuinely empty request body (no bytes at all,
// distinct from TestBean_CreateRequiresName's literal `{}` above) must
// still 400 with "name required" -- httputil.DecodeJSONBody's io.EOF
// tolerance must not let the required-field check get skipped just
// because there was nothing to parse.
func TestBean_CreateRequiresName_EmptyBody(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a bodyless create; body=%s", rec.Code, rec.Body.String())
	}
}

// TestBean_Update_NoBodyIsNotAnError guards the flip side: PUT
// /api/library/bean/{id} is a partial-update merge with no required
// fields, so a genuinely empty body must tolerate as {} (a no-op update)
// rather than 400ing on it -- see maintenance's
// TestTaskDone_NoBodyIsNotAnError (#901) for the original instance of this
// bug and httputil.DecodeJSONBody's doc comment for the shared fix.
func TestBean_Update_NoBodyIsNotAnError(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{"name": "Kenya AA"}))
	bean := decodeBody(t, rec.Body.Bytes())
	id := int64(bean["id"].(float64))

	rec = doJSON(t, mux, http.MethodPut, "/api/library/bean/"+itoa(id), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for a bodyless update; body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeBody(t, rec.Body.Bytes())
	if updated["name"] != "Kenya AA" {
		t.Fatalf("unexpected bean after bodyless update: %+v", updated)
	}
}

func TestBean_CreateUpdateDeleteLifecycle(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{
		"name": "Kenya AA", "roaster": "Test Roasters", "origin": "KE", "stock_g": 250, "decaf": false,
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	bean := decodeBody(t, rec.Body.Bytes())
	if bean["name"] != "Kenya AA" || bean["origin"] != "KE" {
		t.Fatalf("unexpected created bean: %+v", bean)
	}
	if bean["stock_g"] != float64(250) {
		t.Errorf("stock_g = %v, want 250", bean["stock_g"])
	}
	bags, ok := bean["bags"].([]any)
	if !ok || len(bags) != 1 {
		t.Fatalf("expected exactly one bag, got %+v", bean["bags"])
	}
	id := int64(bean["id"].(float64))

	// GET beans-info should now surface it.
	rec = doJSON(t, mux, http.MethodGet, "/api/library/beans-info", nil)
	info := decodeBodyArray(t, rec.Body.Bytes())
	if len(info) != 1 || info[0]["name"] != "Kenya AA" || info[0]["origin"] != "KE" {
		t.Fatalf("unexpected beans-info: %+v", info)
	}

	// Update: partial, only roaster changes.
	rec = doJSON(t, mux, http.MethodPut, "/api/library/bean/"+itoa(id), mustMarshal(t, map[string]any{"roaster": "New Roasters"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d; body=%s", rec.Code, rec.Body.String())
	}
	updated := decodeBody(t, rec.Body.Bytes())
	if updated["roaster"] != "New Roasters" || updated["name"] != "Kenya AA" {
		t.Fatalf("unexpected updated bean: %+v", updated)
	}

	// stock_g: 0 collapses to null (JS `parseFloat(v) || null` quirk).
	rec = doJSON(t, mux, http.MethodPut, "/api/library/bean/"+itoa(id), mustMarshal(t, map[string]any{"stock_g": 0}))
	updated = decodeBody(t, rec.Body.Bytes())
	if updated["stock_g"] != nil {
		t.Errorf("stock_g after PUT 0 = %v, want nil", updated["stock_g"])
	}

	// toggle-active flips enabled.
	rec = doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/toggle-active", nil)
	toggled := decodeBody(t, rec.Body.Bytes())
	if toggled["enabled"] != false {
		t.Errorf("enabled after first toggle = %v, want false", toggled["enabled"])
	}
	rec = doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/toggle-active", nil)
	toggled = decodeBody(t, rec.Body.Bytes())
	if toggled["enabled"] != true {
		t.Errorf("enabled after second toggle = %v, want true", toggled["enabled"])
	}

	// known-grind
	rec = doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/known-grind",
		mustMarshal(t, map[string]any{"grinder": "Niche Zero", "grindSetting": "22"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("known-grind status = %d; body=%s", rec.Code, rec.Body.String())
	}
	kg := decodeBody(t, rec.Body.Bytes())
	settings, _ := kg["knownGrindSettings"].([]any)
	if len(settings) != 1 {
		t.Fatalf("expected one known grind setting, got %+v", kg["knownGrindSettings"])
	}

	// delete
	rec = doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/delete", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}
	deleteResp := decodeBody(t, rec.Body.Bytes())
	if deleteResp["ok"] != true {
		t.Errorf("delete response = %+v", deleteResp)
	}
	rec = doJSON(t, mux, http.MethodGet, "/api/library/beans-info", nil)
	info = decodeBodyArray(t, rec.Body.Bytes())
	if len(info) != 0 {
		t.Errorf("expected library empty after delete, got %+v", info)
	}
}

func TestBean_UpdateNotFound(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPut, "/api/library/bean/999999", mustMarshal(t, map[string]any{"name": "x"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
}

func TestBean_UpdateInvalidIDIsNotFound(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPut, "/api/library/bean/not-a-number", mustMarshal(t, map[string]any{"name": "x"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (invalid id treated as no-match, not 400); body=%s", rec.Code, rec.Body.String())
	}
}

// TestBean_ToggleActiveInvalidIDIsNotFound mirrors
// TestBean_UpdateInvalidIDIsNotFound for toggle-active: a malformed {id}
// against a healthy DB is a 404, same as a well-formed id matching no bean.
func TestBean_ToggleActiveInvalidIDIsNotFound(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/not-a-number/toggle-active", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
}

// TestBean_ToggleActive_DBErrorOutranksInvalidID guards against a #901
// review regression: toggleBeanActive briefly 404'd a malformed {id} before
// ever touching the DB, so a genuine DB outage could hide behind a
// false-negative 404 whenever the request also happened to carry a
// malformed id. The pre-#901 handler (and internal/library.ToggleBeanActive,
// which this handler now calls) always reads the library first — a DB error
// must still surface as 500 regardless of whether the id is well-formed.
func TestBean_ToggleActive_DBErrorOutranksInvalidID(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	if err := sqlDB.Close(); err != nil {
		t.Fatalf("closing db to simulate an outage: %v", err)
	}
	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/not-a-number/toggle-active", nil)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (DB error must outrank a malformed id); body=%s", rec.Code, rec.Body.String())
	}
}

func createTestBean(t *testing.T, mux *http.ServeMux, extra map[string]any) (int64, map[string]any) {
	t.Helper()
	body := map[string]any{"name": "Test Bean"}
	for k, v := range extra {
		body[k] = v
	}
	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, body))
	if rec.Code != http.StatusOK {
		t.Fatalf("create bean status = %d; body=%s", rec.Code, rec.Body.String())
	}
	bean := decodeBody(t, rec.Body.Bytes())
	return int64(bean["id"].(float64)), bean
}

func TestBean_BagFreezeThawAdjustLifecycle(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	id, _ := createTestBean(t, mux, map[string]any{"stock_g": 300, "roastDate": "2026-08-01"})

	// new-bag
	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/new-bag",
		mustMarshal(t, map[string]any{"roastDate": "2026-08-15", "stock_g": 250}))
	if rec.Code != http.StatusOK {
		t.Fatalf("new-bag status = %d; body=%s", rec.Code, rec.Body.String())
	}
	bean := decodeBody(t, rec.Body.Bytes())
	bags, _ := bean["bags"].([]any)
	if len(bags) != 2 {
		t.Fatalf("expected 2 bags after new-bag, got %d", len(bags))
	}

	// freeze-portions
	rec = doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/freeze-portions",
		mustMarshal(t, map[string]any{"portionCount": 5, "portionWeight_g": 18.5}))
	if rec.Code != http.StatusOK {
		t.Fatalf("freeze-portions status = %d; body=%s", rec.Code, rec.Body.String())
	}
	bean = decodeBody(t, rec.Body.Bytes())
	bags, _ = bean["bags"].([]any)
	lastBag, _ := bags[len(bags)-1].(map[string]any)
	fps, _ := lastBag["frozenPortions"].([]any)
	if len(fps) != 1 {
		t.Fatalf("expected one frozen-portion batch, got %+v", lastBag["frozenPortions"])
	}
	portion, _ := fps[0].(map[string]any)
	portionID := int64(portion["id"].(float64))
	if portion["remainingCount"] != float64(5) {
		t.Errorf("remainingCount = %v, want 5", portion["remainingCount"])
	}

	// thaw-portion: thaw 2 of 5
	rec = doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/thaw-portion",
		mustMarshal(t, map[string]any{"portionId": portionID, "count": 2}))
	if rec.Code != http.StatusOK {
		t.Fatalf("thaw-portion status = %d; body=%s", rec.Code, rec.Body.String())
	}
	bean = decodeBody(t, rec.Body.Bytes())
	bags, _ = bean["bags"].([]any)
	lastBag, _ = bags[len(bags)-1].(map[string]any)
	fps, _ = lastBag["frozenPortions"].([]any)
	portion, _ = fps[0].(map[string]any)
	if portion["remainingCount"] != float64(3) {
		t.Errorf("remainingCount after thaw = %v, want 3", portion["remainingCount"])
	}
	if _, thawed := portion["thawedAt"]; thawed {
		t.Errorf("batch should not be fully thawed yet")
	}

	// adjust-frozen-portion: set remainingCount to 0 -> thawedAt set
	rec = doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/adjust-frozen-portion",
		mustMarshal(t, map[string]any{"portionId": portionID, "remainingCount": 0}))
	if rec.Code != http.StatusOK {
		t.Fatalf("adjust-frozen-portion status = %d; body=%s", rec.Code, rec.Body.String())
	}
	bean = decodeBody(t, rec.Body.Bytes())
	bags, _ = bean["bags"].([]any)
	lastBag, _ = bags[len(bags)-1].(map[string]any)
	fps, _ = lastBag["frozenPortions"].([]any)
	portion, _ = fps[0].(map[string]any)
	if _, thawed := portion["thawedAt"]; !thawed {
		t.Errorf("expected thawedAt to be set once remainingCount reaches 0")
	}

	// delete-bag: cannot delete the last remaining bag
	firstBag, _ := bags[0].(map[string]any)
	firstBagID := int64(firstBag["id"].(float64))
	secondBag, _ := bags[1].(map[string]any)
	secondBagID := int64(secondBag["id"].(float64))
	rec = doJSON(t, mux, http.MethodDelete, "/api/library/bean/"+itoa(id)+"/bag/"+itoa(firstBagID), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete-bag status = %d; body=%s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, mux, http.MethodDelete, "/api/library/bean/"+itoa(id)+"/bag/"+itoa(secondBagID), nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 deleting the last bag, got %d; body=%s", rec.Code, rec.Body.String())
	}
}

func TestBean_FreezePortionsNoActiveBag(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	id, _ := createTestBean(t, mux, nil) // no stock_g/roastDate/batchNumber -> no bag
	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/freeze-portions",
		mustMarshal(t, map[string]any{"portionCount": 1, "portionWeight_g": 18}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (no active bag); body=%s", rec.Code, rec.Body.String())
	}
}

func TestBean_Image_RoundTrip(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	id, _ := createTestBean(t, mux, nil)

	rec := doJSON(t, mux, http.MethodGet, "/api/library/bean/"+itoa(id)+"/image", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 before upload, got %d", rec.Code)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/library/bean/"+itoa(id)+"/image", bytes.NewReader(makeJPEG(t, 64, 48)))
	req.Header.Set("Content-Type", "image/jpeg")
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusOK {
		t.Fatalf("upload status = %d; body=%s", rec2.Code, rec2.Body.String())
	}
	bean := decodeBody(t, rec2.Body.Bytes())
	if bean["image"] != "jpg" {
		t.Fatalf("image ext = %v, want jpg", bean["image"])
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/library/bean/"+itoa(id)+"/image", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 after upload, got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("Content-Type = %q, want image/jpeg", ct)
	}
}

func TestBean_PostImage_UnsupportedType(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	id, _ := createTestBean(t, mux, nil)
	req := httptest.NewRequest(http.MethodPost, "/api/library/bean/"+itoa(id)+"/image", bytes.NewReader([]byte("not an image")))
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestGrinder_Image_ThumbnailServed(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{"name": "Niche"}))
	id := int64(decodeBody(t, rec.Body.Bytes())["id"].(float64))

	req := httptest.NewRequest(http.MethodPost, "/api/library/grinder/"+itoa(id)+"/image", bytes.NewReader(makeJPEG(t, 1700, 1300)))
	req.Header.Set("Content-Type", "image/jpeg")
	up := httptest.NewRecorder()
	mux.ServeHTTP(up, req)
	if up.Code != http.StatusOK {
		t.Fatalf("upload status = %d; body=%s", up.Code, up.Body.String())
	}
	if _, err := os.Stat(filepath.Join(h.imageDir, "grinder-"+itoa(id)+".thumb.jpg")); err != nil {
		t.Fatalf("thumbnail not generated: %v", err)
	}

	full := doJSON(t, mux, http.MethodGet, "/api/library/grinder/"+itoa(id)+"/image", nil)
	thumb := doJSON(t, mux, http.MethodGet, "/api/library/grinder/"+itoa(id)+"/image?thumb=1", nil)
	if full.Code != http.StatusOK || thumb.Code != http.StatusOK {
		t.Fatalf("GET codes: full=%d thumb=%d", full.Code, thumb.Code)
	}
	if thumb.Body.Len() >= full.Body.Len() {
		t.Errorf("thumb (%d B) not smaller than full (%d B)", thumb.Body.Len(), full.Body.Len())
	}
}

func TestBean_Image_WebPUploadStoredAsJPEG(t *testing.T) {
	webp, err := os.ReadFile("testdata/sample.webp")
	if err != nil {
		t.Fatal(err)
	}
	h, repo, _ := newTestHandlers(t)
	mux := newMux(h)
	id, _ := createTestBean(t, mux, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/library/bean/"+itoa(id)+"/image", bytes.NewReader(webp))
	req.Header.Set("Content-Type", "image/webp")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("upload status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := decodeBody(t, rec.Body.Bytes())["image"]; got != "jpg" {
		t.Errorf("response image ext = %v, want jpg", got)
	}
	lib, _ := repo.GetLibrary()
	if lib.Beans[0]["image"] != "jpg" {
		t.Errorf("persisted bean image ext = %v, want jpg", lib.Beans[0]["image"])
	}
	if _, err := os.Stat(filepath.Join(h.imageDir, itoa(id)+".jpg")); err != nil {
		t.Errorf("converted file missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(h.imageDir, itoa(id)+".webp")); !os.IsNotExist(err) {
		t.Errorf("source webp not cleaned up: %v", err)
	}
}

// ── Grinders ────────────────────────────────────────────────────────────

func TestGrinder_CreateUpdateResetBurrsDelete(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{"name": "Niche Zero"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	grinder := decodeBody(t, rec.Body.Bytes())
	id := int64(grinder["id"].(float64))

	rec = doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(id), mustMarshal(t, map[string]any{"burrType": "64mm conical"}))
	updated := decodeBody(t, rec.Body.Bytes())
	if updated["burrType"] != "64mm conical" {
		t.Fatalf("unexpected updated grinder: %+v", updated)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/library/grinder/"+itoa(id)+"/reset-burrs", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("reset-burrs status = %d; body=%s", rec.Code, rec.Body.String())
	}
	reset := decodeBody(t, rec.Body.Bytes())
	wear, ok := reset["wear"].(map[string]any)
	if !ok {
		t.Fatalf("expected wear object, got %+v", reset["wear"])
	}
	if _, ok := wear["shotsSinceBurrs"]; !ok {
		t.Errorf("expected wear.shotsSinceBurrs, got %+v", wear)
	}
	if _, ok := wear["gramsSinceBurrs"]; !ok {
		t.Errorf("expected wear.gramsSinceBurrs, got %+v", wear)
	}

	// GET /api/library also enriches grinders with wear.
	rec = doJSON(t, mux, http.MethodGet, "/api/library", nil)
	lib := decodeBody(t, rec.Body.Bytes())
	grinders, _ := lib["grinders"].([]any)
	if len(grinders) != 1 {
		t.Fatalf("expected 1 grinder, got %+v", grinders)
	}
	g0, _ := grinders[0].(map[string]any)
	if _, ok := g0["wear"]; !ok {
		t.Errorf("expected GET /api/library grinders to carry computed wear, got %+v", g0)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/library/grinder/"+itoa(id)+"/delete", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}
}

func TestGrinder_CreateRequiresName(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// ── Baskets ─────────────────────────────────────────────────────────────

func TestBasket_CRUD(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/library/baskets", nil)
	arr := decodeBodyArray(t, rec.Body.Bytes())
	if len(arr) != 0 {
		t.Fatalf("expected empty baskets, got %+v", arr)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/library/basket", mustMarshal(t, map[string]any{"name": "VST 18g", "wallType": "precision-machined"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	basket := decodeBody(t, rec.Body.Bytes())
	id := int64(basket["id"].(float64))

	rec = doJSON(t, mux, http.MethodPost, "/api/library/basket", mustMarshal(t, map[string]any{"name": "x", "wallType": "bogus"}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid wallType, got %d", rec.Code)
	}

	rec = doJSON(t, mux, http.MethodPut, "/api/library/basket/"+itoa(id), mustMarshal(t, map[string]any{"shape": "tapered"}))
	updated := decodeBody(t, rec.Body.Bytes())
	if updated["shape"] != "tapered" {
		t.Fatalf("unexpected updated basket: %+v", updated)
	}

	rec = doJSON(t, mux, http.MethodDelete, "/api/library/basket/"+itoa(id), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}
}

// TestBasket_EnumFieldsRejectNonStringValues guards #901: a wallType/shape
// value that decodes to something other than a JSON string (e.g. a number)
// used to silently fall back to Go's zero value "" and sail past
// validation instead of getting rejected like the Node original rejects any
// truthy, non-matching value.
func TestBasket_EnumFieldsRejectNonStringValues(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/basket", mustMarshal(t, map[string]any{"name": "x", "wallType": 5}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("create with non-string wallType: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, mux, http.MethodPost, "/api/library/basket", mustMarshal(t, map[string]any{"name": "x", "shape": 5}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("create with non-string shape: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/library/basket", mustMarshal(t, map[string]any{"name": "VST 18g", "wallType": "precision-machined"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	basket := decodeBody(t, rec.Body.Bytes())
	id := int64(basket["id"].(float64))

	rec = doJSON(t, mux, http.MethodPut, "/api/library/basket/"+itoa(id), mustMarshal(t, map[string]any{"wallType": 5}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("update with non-string wallType: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	rec = doJSON(t, mux, http.MethodPut, "/api/library/basket/"+itoa(id), mustMarshal(t, map[string]any{"shape": 5}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("update with non-string shape: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}

	// The rejected updates above must not have overwritten wallType with "".
	rec = doJSON(t, mux, http.MethodGet, "/api/library/baskets", nil)
	arr := decodeBodyArray(t, rec.Body.Bytes())
	if len(arr) != 1 {
		t.Fatalf("expected 1 basket, got %+v", arr)
	}
	if arr[0]["wallType"] != "precision-machined" {
		t.Fatalf("rejected update overwrote wallType: got %+v", arr[0])
	}
}

// ── Puck screens ────────────────────────────────────────────────────────

func TestPuckScreen_CRUD(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/puckscreen", mustMarshal(t, map[string]any{"name": "IMS", "thickness": "thin"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	ps := decodeBody(t, rec.Body.Bytes())
	id := int64(ps["id"].(float64))

	rec = doJSON(t, mux, http.MethodPut, "/api/library/puckscreen/"+itoa(id), mustMarshal(t, map[string]any{"thickness": "bogus"}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid thickness, got %d", rec.Code)
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/library/puckscreens", nil)
	arr := decodeBodyArray(t, rec.Body.Bytes())
	if len(arr) != 1 {
		t.Fatalf("expected 1 puck screen, got %+v", arr)
	}

	rec = doJSON(t, mux, http.MethodDelete, "/api/library/puckscreen/"+itoa(id), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}
}

// TestPuckScreen_EnumFieldRejectsNonStringValue guards #901: a thickness
// value that decodes to a non-string JSON value used to silently pass
// validation as Go's zero value "" instead of getting rejected.
func TestPuckScreen_EnumFieldRejectsNonStringValue(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/puckscreen", mustMarshal(t, map[string]any{"name": "x", "thickness": 5}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("create with non-string thickness: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/library/puckscreen", mustMarshal(t, map[string]any{"name": "IMS", "thickness": "thin"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	ps := decodeBody(t, rec.Body.Bytes())
	id := int64(ps["id"].(float64))

	rec = doJSON(t, mux, http.MethodPut, "/api/library/puckscreen/"+itoa(id), mustMarshal(t, map[string]any{"thickness": 5}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("update with non-string thickness: status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}

	// The rejected update above must not have overwritten thickness with "".
	rec = doJSON(t, mux, http.MethodGet, "/api/library/puckscreens", nil)
	arr := decodeBodyArray(t, rec.Body.Bytes())
	if len(arr) != 1 {
		t.Fatalf("expected 1 puck screen, got %+v", arr)
	}
	if arr[0]["thickness"] != "thin" {
		t.Fatalf("rejected update overwrote thickness: got %+v", arr[0])
	}
}

// ── Milks ───────────────────────────────────────────────────────────────

func TestMilk_CRUDAndDeduct(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/milk", mustMarshal(t, map[string]any{"name": "Oat", "stockMl": 1000}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	milk := decodeBody(t, rec.Body.Bytes())
	id := int64(milk["id"].(float64))
	if milk["emoji"] != "🥛" {
		t.Errorf("emoji default = %v, want 🥛", milk["emoji"])
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/library/milks", nil)
	arr := decodeBodyArray(t, rec.Body.Bytes())
	if len(arr) != 1 || arr[0]["stockMl"] != float64(1000) {
		t.Fatalf("unexpected milk list: %+v", arr)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/library/milk/"+itoa(id)+"/deduct", mustMarshal(t, map[string]any{"ml": 200}))
	if rec.Code != http.StatusOK {
		t.Fatalf("deduct status = %d; body=%s", rec.Code, rec.Body.String())
	}
	deducted := decodeBody(t, rec.Body.Bytes())
	if deducted["stockMl"] != float64(800) {
		t.Errorf("stockMl after deduct = %v, want 800", deducted["stockMl"])
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/library/milk/"+itoa(id)+"/deduct", mustMarshal(t, map[string]any{"ml": -5}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-positive ml, got %d", rec.Code)
	}

	rec = doJSON(t, mux, http.MethodDelete, "/api/library/milk/"+itoa(id), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}
}

// TestMilk_Restock is the #932/#931 regression test: POST .../restock must
// additively top up stockMl (like /deduct in reverse), not overwrite it.
func TestMilk_Restock(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/milk", mustMarshal(t, map[string]any{"name": "Oat", "stockMl": 100}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	id := int64(decodeBody(t, rec.Body.Bytes())["id"].(float64))

	rec = doJSON(t, mux, http.MethodPost, "/api/library/milk/"+itoa(id)+"/restock", mustMarshal(t, map[string]any{"ml": 200}))
	if rec.Code != http.StatusOK {
		t.Fatalf("restock status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := decodeBody(t, rec.Body.Bytes())["stockMl"]; got != float64(300) {
		t.Errorf("stockMl after restock = %v, want 300 (additive, not overwrite)", got)
	}

	// A second restock stacks on top.
	rec = doJSON(t, mux, http.MethodPost, "/api/library/milk/"+itoa(id)+"/restock", mustMarshal(t, map[string]any{"ml": 50}))
	if got := decodeBody(t, rec.Body.Bytes())["stockMl"]; got != float64(350) {
		t.Errorf("stockMl after second restock = %v, want 350", got)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/library/milk/"+itoa(id)+"/restock", mustMarshal(t, map[string]any{"ml": 0}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-positive ml, got %d", rec.Code)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/library/milk/999/restock", mustMarshal(t, map[string]any{"ml": 100}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown milk id, got %d", rec.Code)
	}
}

// ── Recipes ─────────────────────────────────────────────────────────────

func TestRecipe_CRUD(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/recipe", mustMarshal(t, map[string]any{
		"name": "V60 default", "brewMethod": "v60", "targetDose_g": 15, "steps": []map[string]any{
			{"text": "Bloom", "duration_s": 30},
			{"text": "", "duration_s": 10}, // dropped: blank text
		},
	}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d; body=%s", rec.Code, rec.Body.String())
	}
	recipe := decodeBody(t, rec.Body.Bytes())
	id := int64(recipe["id"].(float64))
	steps, _ := recipe["steps"].([]any)
	if len(steps) != 1 {
		t.Fatalf("expected 1 step (blank dropped), got %+v", recipe["steps"])
	}
	if recipe["brewMethod"] != "v60" {
		t.Errorf("brewMethod = %v, want v60", recipe["brewMethod"])
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/library/recipe", mustMarshal(t, map[string]any{"name": "x", "brewMethod": "not-a-method"}))
	other := decodeBody(t, rec.Body.Bytes())
	if other["brewMethod"] != "other" {
		t.Errorf("unknown brewMethod should fall back to 'other', got %v", other["brewMethod"])
	}

	rec = doJSON(t, mux, http.MethodPut, "/api/library/recipe/"+itoa(id), mustMarshal(t, map[string]any{"targetDose_g": 0}))
	updated := decodeBody(t, rec.Body.Bytes())
	if updated["targetDose_g"] != nil {
		t.Errorf("targetDose_g after PUT 0 = %v, want nil (parseFloat||null quirk)", updated["targetDose_g"])
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/library/recipe/"+itoa(id)+"/delete", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}
}

func TestRecipe_CreateRequiresName(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/library/recipe", mustMarshal(t, map[string]any{}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// ── Rate limiting ───────────────────────────────────────────────────────

func TestCreateBean_RateLimited(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	var last *httptest.ResponseRecorder
	for i := 0; i < 31; i++ {
		last = doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{"name": "x"}))
	}
	if last.Code != http.StatusTooManyRequests {
		t.Fatalf("31st create status = %d, want 429; body=%s", last.Code, last.Body.String())
	}
	body := decodeBody(t, last.Body.Bytes())
	if body["error"] != "Rate limit exceeded" {
		t.Errorf("error = %v, want 'Rate limit exceeded'", body["error"])
	}
}

func itoa(id int64) string {
	return strconv.FormatInt(id, 10)
}
