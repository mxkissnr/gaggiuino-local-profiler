package shots

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func doJSON(t testing.TB, mux *http.ServeMux, method, path string, body []byte) *httptest.ResponseRecorder {
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

// ── /shots.json + /api/shots/last ──────────────────────────────────────

func TestListShots_HappyPathIncludesScore(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", map[string]any{"weight": 45.0}, nil)

	rec := doJSON(t, mux, http.MethodGet, "/shots.json", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var list []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 shot, got %d", len(list))
	}
	if _, ok := list[0]["score"]; !ok {
		t.Error("expected additive 'score' field on /shots.json entries")
	}
	if _, ok := list[0]["usedBeanTarget"]; !ok {
		t.Error("expected additive 'usedBeanTarget' field on /shots.json entries")
	}
}

func TestListShots_TrashQueryParamFiltersToTrashedOnly(t *testing.T) {
	h, s, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 2000, &dur, "V60", nil, nil)
	if err := s.MoveToTrash(2); err != nil {
		t.Fatalf("MoveToTrash: %v", err)
	}

	rec := doJSON(t, mux, http.MethodGet, "/shots.json", nil)
	var list []map[string]any
	json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 1 || int64(list[0]["id"].(float64)) != 1 {
		t.Fatalf("expected only shot 1 in the active list, got %+v", list)
	}

	rec = doJSON(t, mux, http.MethodGet, "/shots.json?trash=1", nil)
	json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 1 || int64(list[0]["id"].(float64)) != 2 {
		t.Fatalf("expected only shot 2 in the trash list, got %+v", list)
	}
}

func TestLastShot_NullWhenEmptyAndPopulatedOtherwise(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/shots/last", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != "null" {
		t.Errorf("expected null body for an empty shot history, got %q", rec.Body.String())
	}

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 2000, &dur, "V60", nil, nil)

	rec = doJSON(t, mux, http.MethodGet, "/api/shots/last", nil)
	body := decodeBody(t, rec.Body.Bytes())
	if int64(body["id"].(float64)) != 2 {
		t.Errorf("expected the latest-timestamp shot (id 2), got %+v", body)
	}
}

// ── /api/shots/defaults ────────────────────────────────────────────────

func TestShotDefaults_RoundTrip(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/shots/defaults", nil)
	body := decodeBody(t, rec.Body.Bytes())
	if body["grinder"] != "" {
		t.Errorf("expected zero-value defaults.grinder = \"\", got %+v", body)
	}

	payload := []byte(`{"drinkType":"espresso","coffee":"Bean","beanId":7,"basketId":null,"puckScreenId":null,"grinder":"Niche","dose":18.5}`)
	rec = doJSON(t, mux, http.MethodPost, "/api/shots/defaults", payload)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/shots/defaults", nil)
	body = decodeBody(t, rec.Body.Bytes())
	if body["drinkType"] != "espresso" || body["grinder"] != "Niche" || body["beanId"].(float64) != 7 {
		t.Errorf("unexpected persisted defaults: %+v", body)
	}
}

func TestShotDefaults_ValidationError(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/defaults", []byte(`{"dose":-5}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["error"] != "Validation failed" {
		t.Errorf("expected 'Validation failed' error, got %+v", body)
	}
}

// TestShotDefaults_NoBodyIsNotAnError guards against a Go-migration
// regression (#901): every field ValidateShotDefaults checks is optional,
// so a genuinely empty request body (no bytes at all) must decode to {}
// and save all-empty defaults, not 400 with "Invalid JSON body" --
// httputil.DecodeJSONBody's io.EOF tolerance is what makes that possible.
func TestShotDefaults_NoBodyIsNotAnError(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/defaults", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for a bodyless request; body=%s", rec.Code, rec.Body.String())
	}
}

// ── /api/shots/{id} ────────────────────────────────────────────────────

func TestGetShot_NullForInvalidAndMissingID(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	for _, path := range []string{"/api/shots/notanumber", "/api/shots/999999"} {
		rec := doJSON(t, mux, http.MethodGet, path, nil)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status = %d, want 200", path, rec.Code)
		}
		if strings.TrimSpace(rec.Body.String()) != "null" {
			t.Errorf("%s: body = %q, want null", path, rec.Body.String())
		}
	}
}

func TestGetShot_IncludesPreviousShotOnSameProfile(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)
	insertShot(t, sqlDB, 2, 2000, &dur, "V60", nil, nil)

	rec := doJSON(t, mux, http.MethodGet, "/api/shots/2", nil)
	body := decodeBody(t, rec.Body.Bytes())
	if body["previousShotId"] == nil || int64(body["previousShotId"].(float64)) != 1 {
		t.Errorf("expected previousShotId=1, got %+v", body["previousShotId"])
	}
	prevShot, ok := body["previousShot"].(map[string]any)
	if !ok {
		t.Fatalf("expected previousShot object, got %+v", body["previousShot"])
	}
	if _, ok := prevShot["score"]; !ok {
		t.Error("expected previousShot to carry its own computed score")
	}
}

// ── /api/shots/{id}/card ───────────────────────────────────────────────

func TestGetCard_StatusCodes(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)

	if rec := doJSON(t, mux, http.MethodGet, "/api/shots/notanumber/card", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("invalid id: status = %d, want 400", rec.Code)
	}
	if rec := doJSON(t, mux, http.MethodGet, "/api/shots/999999/card", nil); rec.Code != http.StatusNotFound {
		t.Errorf("missing shot: status = %d, want 404", rec.Code)
	}
	// Phase 2f (#901): the success path now renders a PNG (see card_test.go
	// for the image-shape assertions); this test keeps only the 400/404
	// branch coverage it originally had.
	if rec := doJSON(t, mux, http.MethodGet, "/api/shots/1/card", nil); rec.Code != http.StatusOK {
		t.Errorf("existing shot: status = %d, want 200", rec.Code)
	}
}

// ── /api/shots/{id}/annotate ───────────────────────────────────────────

func TestAnnotate_HappyPathAndPersists(t *testing.T) {
	h, s, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/annotate", []byte(`{"coffee":"Bean","rating":5}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["ok"] != true {
		t.Errorf("expected {ok:true}, got %+v", body)
	}

	ann, err := s.FindByID(1)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	annotation := toMap(ann["annotation"])
	if annotation["coffee"] != "Bean" {
		t.Errorf("expected persisted annotation.coffee = Bean, got %+v", annotation)
	}
}

// TestAnnotate_NoBodyIsNotAnError guards against a Go-migration
// regression (#901): every field ValidateAnnotation checks is optional, so
// a genuinely empty request body (no bytes at all) must decode to {} and
// save an empty annotation, not 400 with "Invalid JSON body".
func TestAnnotate_NoBodyIsNotAnError(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/annotate", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for a bodyless request; body=%s", rec.Code, rec.Body.String())
	}
}

func TestAnnotate_ValidationErrorBeforeIDCheck(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	// Both the body (rating out of range) AND the id (invalid) are bad —
	// validation must win, matching routes/shots.js's middleware order.
	rec := doJSON(t, mux, http.MethodPost, "/api/shots/notanumber/annotate", []byte(`{"rating":99}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["error"] != "Validation failed" {
		t.Errorf("expected the validation error to win over the id error, got %+v", body)
	}
}

func TestAnnotate_InvalidIDWithValidBody(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/notanumber/annotate", []byte(`{"coffee":"Bean"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["error"] != "Invalid shot ID" {
		t.Errorf("expected 'Invalid shot ID', got %+v", body)
	}
}

// TestAnnotate_NonexistentShotFailsOnForeignKey pins a real, verified-in-
// both-runtimes 500: ShotService.js's saveAnnotation() itself has no
// existence check, but annotations.shot_id is `REFERENCES shots(id)` and
// both lib/db.js and internal/db.InitSchema turn `PRAGMA foreign_keys = ON`
// on, so an INSERT for a shot id that was never synced hits a foreign-key
// constraint violation in both Node (better-sqlite3 throws, uncaught by
// the route -> lib/middleware/error.js's generic 500 branch) and here.
func TestAnnotate_NonexistentShotFailsOnForeignKey(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/999999/annotate", []byte(`{"coffee":"Bean"}`))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

// ── trash / restore / delete ───────────────────────────────────────────

func TestTrash_HappyPathAndNotFound(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/trash", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/shots/999999/trash", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["error"] != "Shot not found" {
		t.Errorf("expected 'Shot not found', got %+v", body)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/shots/notanumber/trash", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestRestore_NoExistenceCheck(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	// Matches ShotService.js's restoreShot: succeeds even for an id that
	// was never trashed (or doesn't exist at all).
	rec := doJSON(t, mux, http.MethodPost, "/api/shots/999999/restore", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/shots/notanumber/restore", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestDelete_HappyPathAddsToBlocklistAndNotFound(t *testing.T) {
	h, s, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/delete", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	shot, err := s.FindByID(1)
	if err != nil {
		t.Fatalf("FindByID: %v", err)
	}
	if shot != nil {
		t.Errorf("expected shot 1 to be permanently gone, got %+v", shot)
	}
	blocklist, err := s.GetBlocklist()
	if err != nil {
		t.Fatalf("GetBlocklist: %v", err)
	}
	if len(blocklist) != 1 || blocklist[0] != "1" {
		t.Errorf("expected blocklist = [\"1\"], got %+v", blocklist)
	}

	rec = doJSON(t, mux, http.MethodPost, "/api/shots/999999/delete", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// ── image upload/serve/delete ──────────────────────────────────────────

var pngMagic = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 0}

func TestImage_UploadServeDeleteRoundTrip(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)

	// GET before upload: 404.
	if rec := doJSON(t, mux, http.MethodGet, "/api/shots/1/image", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("GET before upload: status = %d, want 404", rec.Code)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/shots/1/image", bytes.NewReader(pngMagic))
	req.Header.Set("Content-Type", "image/png")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("upload: status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["image"] != "png" {
		t.Errorf("expected updated shot to carry image=png, got %+v", body)
	}
	if _, hasUsedBeanTarget := body["usedBeanTarget"]; hasUsedBeanTarget {
		t.Error("POST .../image response must only add 'score', not 'usedBeanTarget'")
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/shots/1/image", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET after upload: status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}
	if !bytes.Equal(rec.Body.Bytes(), pngMagic) {
		t.Errorf("served image bytes don't match uploaded bytes")
	}

	rec = doJSON(t, mux, http.MethodDelete, "/api/shots/1/image", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete: status = %d, want 200", rec.Code)
	}
	delBody := decodeBody(t, rec.Body.Bytes())
	if delBody["ok"] != true {
		t.Errorf("expected {ok:true, shot:...}, got %+v", delBody)
	}

	if rec := doJSON(t, mux, http.MethodGet, "/api/shots/1/image", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("GET after delete: status = %d, want 404", rec.Code)
	}
}

// testJPEG builds a w×h gradient JPEG — a real, decodable image so the
// #961 optimize pipeline in img.Save actually runs.
func testJPEG(t testing.TB, w, h int) []byte {
	t.Helper()
	im := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			im.Set(x, y, color.RGBA{uint8(x * 255 / w), uint8(y * 255 / h), uint8((x + y) * 255 / (w + h)), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, im, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode test jpeg: %v", err)
	}
	return buf.Bytes()
}

func TestImage_OptimizedAndThumbnailed(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)

	in := testJPEG(t, 1700, 1300)
	req := httptest.NewRequest(http.MethodPost, "/api/shots/1/image", bytes.NewReader(in))
	req.Header.Set("Content-Type", "image/jpeg")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("upload status = %d; body=%s", rec.Code, rec.Body.String())
	}

	main := filepath.Join(h.imageDir, "shot-1.jpg")
	mi, err := os.Stat(main)
	if err != nil {
		t.Fatalf("stored main missing: %v", err)
	}
	if mi.Size() >= 300*1024 {
		t.Errorf("stored main = %d bytes, want < 300 KiB", mi.Size())
	}
	thumb := filepath.Join(h.imageDir, "shot-1.thumb.jpg")
	ti, err := os.Stat(thumb)
	if err != nil {
		t.Fatalf("thumbnail missing: %v", err)
	}

	full := doJSON(t, mux, http.MethodGet, "/api/shots/1/image", nil)
	if full.Code != http.StatusOK || int64(full.Body.Len()) != mi.Size() {
		t.Errorf("GET image: code=%d len=%d, want 200 / %d", full.Code, full.Body.Len(), mi.Size())
	}
	small := doJSON(t, mux, http.MethodGet, "/api/shots/1/image?thumb=1", nil)
	if small.Code != http.StatusOK || int64(small.Body.Len()) != ti.Size() {
		t.Errorf("GET image?thumb=1: code=%d len=%d, want 200 / %d", small.Code, small.Body.Len(), ti.Size())
	}
	if small.Body.Len() >= full.Body.Len() {
		t.Errorf("thumb body (%d) not smaller than full body (%d)", small.Body.Len(), full.Body.Len())
	}

	// Thumb missing -> transparent fallback to the full image, never 404.
	if err := os.Remove(thumb); err != nil {
		t.Fatal(err)
	}
	fb := doJSON(t, mux, http.MethodGet, "/api/shots/1/image?thumb=1", nil)
	if fb.Code != http.StatusOK || int64(fb.Body.Len()) != mi.Size() {
		t.Errorf("thumb fallback: code=%d len=%d, want 200 / %d", fb.Code, fb.Body.Len(), mi.Size())
	}
}

func TestImage_UnsupportedContentTypeRejected(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/shots/1/image", bytes.NewReader([]byte("not an image")))
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["error"] != "no image data" {
		t.Errorf("expected 'no image data', got %+v", body)
	}
}

func TestImage_GetWithInvalidIDIs404NotBadRequest(t *testing.T) {
	// GET .../image treats an invalid id like "no image" (404), matching
	// routes/shots.js's `id ? shotService.getById(id) : null` short circuit
	// — unlike POST/DELETE .../image, which 400 on an invalid id.
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/shots/notanumber/image", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestImage_PostDeleteMissingShotIs404(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	req := httptest.NewRequest(http.MethodPost, "/api/shots/999999/image", bytes.NewReader(pngMagic))
	req.Header.Set("Content-Type", "image/png")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("POST missing shot: status = %d, want 404", rec.Code)
	}

	rec = doJSON(t, mux, http.MethodDelete, "/api/shots/999999/image", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("DELETE missing shot: status = %d, want 404", rec.Code)
	}
}
