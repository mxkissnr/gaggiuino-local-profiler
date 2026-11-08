package shots

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
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

// TestShotDefaults_NoBodyIsNotAnError pins that a genuinely empty request body
// (no bytes at all) decodes to {} and saves all-empty defaults rather than
// 400ing with "Invalid JSON body": every field ValidateShotDefaults checks is
// optional (#901), and httputil.DecodeJSONBody's io.EOF tolerance is what makes
// that possible.
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

// TestGetShot_ResolvesDemoRangeID guards the #1034 fix: demo-seed shots get
// ids in the demoIDBase..demoIDMax band (far above MaxShotID), and GET
// /api/shots/{id} has to reach them — otherwise demo mode's shot detail
// (curve, P·Q, average pressure) renders empty because the per-shot curve
// fetch #957 introduced 200-nulls. An id just past the demo band is still
// rejected the same way an over-MaxShotID real id always was.
func TestGetShot_ResolvesDemoRangeID(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)

	const demoID = demoIDBase + 1 // 900000001 — first id the demo seed hands out
	dur := int64(300)
	insertShot(t, sqlDB, demoID, 1000, &dur, "Demo Profile 1",
		map[string]any{"datapoints": map[string]any{
			"pressure":   []float64{9, 9, 9},
			"timeInShot": []float64{0, 1, 2},
		}}, nil)

	rec := doJSON(t, mux, http.MethodGet, "/api/shots/900000001", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["id"] == nil || int64(body["id"].(float64)) != demoID {
		t.Fatalf("expected the demo shot row (id %d), got %+v", demoID, body)
	}
	data, ok := body["datapoints"].(map[string]any)
	if !ok || len(data["pressure"].([]any)) != 3 {
		t.Errorf("expected the demo shot's datapoints to come back, got %+v", body["datapoints"])
	}

	// demoIDMax (2*demoIDBase) itself and anything between MaxShotID and
	// demoIDBase stay rejected (200 null, exactly as an over-ceiling real id
	// always was).
	for _, path := range []string{"/api/shots/1800000000", "/api/shots/500000000"} {
		rec := doJSON(t, mux, http.MethodGet, path, nil)
		if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "null" {
			t.Errorf("%s: status=%d body=%q, want 200 null", path, rec.Code, rec.Body.String())
		}
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
	// The success path renders a PNG (see card_test.go for the image-shape
	// assertions); this test keeps only the 400/404 branch coverage.
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
	merged := toMap(body["annotation"])
	if merged["coffee"] != "Bean" {
		t.Errorf("expected response annotation.coffee = Bean, got %+v", merged)
	}
	if merged["rating"] != float64(5) {
		t.Errorf("expected response annotation.rating = 5, got %+v", merged)
	}
	if _, has := body["score"]; !has {
		t.Errorf("expected response to carry a score key, got %+v", body)
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

// TestAnnotate_NoBodyIsNotAnError pins that a genuinely empty request body (no
// bytes at all) decodes to {} and saves an empty annotation rather than 400ing
// with "Invalid JSON body": every field ValidateAnnotation checks is optional
// (#901).
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
	// validation must win (see the handlers.go header for that order).
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

// TestAnnotate_NonexistentShotFailsOnForeignKey pins the 500 for a shot id
// that was never synced: SaveAnnotation itself has no existence check, but
// annotations.shot_id is `REFERENCES shots(id)` and internal/db.InitSchema
// turns `PRAGMA foreign_keys = ON`, so the INSERT hits a foreign-key
// constraint violation, surfaced by the handler as a generic 500.
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

	// RestoreShot has no existence check: it succeeds even for an id that was
	// never trashed (or doesn't exist at all).
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
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, map[string]any{"dose": 18.0})
	if _, err := sqlDB.Exec(`INSERT INTO trash (shot_id, deleted_at) VALUES (?, ?)`, 1, time.Now().UnixMilli()); err != nil {
		t.Fatalf("trashing shot 1: %v", err)
	}

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
	// #1609: the handler's single delete+blocklist transaction also drops the
	// annotation and trash rows, not just the shot.
	if got := countRows(t, sqlDB, `SELECT COUNT(*) FROM annotations WHERE shot_id = 1`); got != 0 {
		t.Errorf("annotation count = %d, want 0", got)
	}
	if got := countRows(t, sqlDB, `SELECT COUNT(*) FROM trash WHERE shot_id = 1`); got != 0 {
		t.Errorf("trash count = %d, want 0", got)
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
	if cc := rec.Header().Get("Cache-Control"); cc != "private, no-cache" {
		t.Errorf("Cache-Control = %q, want private, no-cache", cc)
	}
	if lm := rec.Header().Get("Last-Modified"); lm != "" {
		req304 := httptest.NewRequest(http.MethodGet, "/api/shots/1/image", nil)
		req304.Header.Set("If-Modified-Since", lm)
		rec304 := httptest.NewRecorder()
		mux.ServeHTTP(rec304, req304)
		if rec304.Code != http.StatusNotModified {
			t.Errorf("revalidation status = %d, want 304", rec304.Code)
		}
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
	// GET .../image treats an invalid id like "no image" (404) — unlike
	// POST/DELETE .../image, which 400 on an invalid id.
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

// TestPostImage_RateLimited proves the dedicated image:<ip> feature limit
// (#1056, imageRateLimitPerMin) on POST /api/shots/{id}/image — the same
// pattern as TestGetCard_RateLimited in card_test.go. The limiter runs
// before id-parsing, so this drives it with missing-shot requests (404) and
// never pays a real decode/encode pass: the first imageRateLimitPerMin
// requests pass the limiter, the next one 429s. Every httptest.NewRequest
// shares one RemoteAddr, so they share one bucket.
func TestPostImage_RateLimited(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	post := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/shots/999999/image", bytes.NewReader(pngMagic))
		req.Header.Set("Content-Type", "image/png")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	for i := 0; i < imageRateLimitPerMin; i++ {
		if rec := post(); rec.Code != http.StatusNotFound {
			t.Fatalf("request %d: status = %d, want 404 (limiter not yet tripped)", i, rec.Code)
		}
	}
	if rec := post(); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request %d: status = %d, want 429", imageRateLimitPerMin, rec.Code)
	}
}

// TestDeleteShot_RemovesPhotoThumbnailAndOriginal (#1525, #1845): permanently
// deleting a shot removes its photo, thumbnail and uncropped original from
// disk as well as its rows.
func TestDeleteShot_RemovesPhotoThumbnailAndOriginal(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	insertShot(t, sqlDB, 1, 1000, nil, "Espresso", map[string]any{"image": "jpg"}, nil)
	names := []string{"shot-1.jpg", "shot-1.thumb.jpg", "shot-1.orig.jpg"}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(h.imageDir, name), []byte{0x01}, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/delete", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	for _, name := range names {
		if _, err := os.Stat(filepath.Join(h.imageDir, name)); !os.IsNotExist(err) {
			t.Errorf("%s should have been removed (err=%v)", name, err)
		}
	}
}

// ── shot photo originals and re-cropping (#1845) ───────────────────────

// postShotImage posts body to path as contentType. An empty contentType sends
// no Content-Type header — the shape a body-less re-crop request has.
func postShotImage(t *testing.T, mux *http.ServeMux, path, contentType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == nil {
		req = httptest.NewRequest(http.MethodPost, path, nil)
	} else {
		req = httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// jpegConfig returns the header dimensions of a JPEG, failing the test when
// the bytes are not a decodable JPEG.
func jpegConfig(t *testing.T, data []byte) image.Config {
	t.Helper()
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decoding JPEG header: %v", err)
	}
	return cfg
}

// shotImagePath is the on-disk path of one stored shot photo variant
// ("" = main, "thumb" and "orig" the two siblings the crop pipeline adds).
func shotImagePath(h *Handlers, id int64, variant, ext string) string {
	switch variant {
	case "thumb":
		return img.ThumbPath(h.imageDir, id, ext, "shot-")
	case "orig":
		return img.OriginalPath(h.imageDir, id, "shot-")
	}
	return img.Path(h.imageDir, id, ext, "shot-")
}

func requireShotFile(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected stored file %s: %v", path, err)
	}
}

func requireNoShotFile(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected %s to be absent, stat err = %v", path, err)
	}
}

// mustShot reads a shot back, failing the test when it is gone.
func mustShot(t *testing.T, h *Handlers, id int64) Shot {
	t.Helper()
	shot, err := h.repo.FindByID(id)
	if err != nil {
		t.Fatalf("FindByID(%d): %v", id, err)
	}
	if shot == nil {
		t.Fatalf("shot %d missing", id)
	}
	return shot
}

// requireShotCrop asserts the shot's stored imageCrop.
func requireShotCrop(t *testing.T, shot Shot, want img.Crop) {
	t.Helper()
	got, ok := shotCrop(shot)
	if !ok {
		t.Fatalf("shot has no valid imageCrop: %v", shot)
	}
	if diff := math.Abs(got.X-want.X) + math.Abs(got.Y-want.Y) + math.Abs(got.W-want.W) + math.Abs(got.H-want.H); diff > 1e-9 {
		t.Fatalf("imageCrop = %+v, want %+v", got, want)
	}
}

// TestPostImage_NewPhotoDropsOriginalAndCrop pins the "a new photo replaces
// everything that described the old one" rule: the stored original and the
// crop rectangle go away with the picture they belonged to.
func TestPostImage_NewPhotoDropsOriginalAndCrop(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "Espresso", nil, nil)

	if rec := postShotImage(t, mux, "/api/shots/1/image", "image/jpeg", testJPEG(t, 200, 100)); rec.Code != http.StatusOK {
		t.Fatalf("new photo status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if rec := postShotImage(t, mux, "/api/shots/1/image?original=1&crop=0,0,0.5,0.5", "image/jpeg", testJPEG(t, 200, 100)); rec.Code != http.StatusOK {
		t.Fatalf("store original status = %d; body=%s", rec.Code, rec.Body.String())
	}
	requireShotFile(t, shotImagePath(h, 1, "orig", "jpg"))
	requireShotCrop(t, mustShot(t, h, 1), img.Crop{X: 0, Y: 0, W: 0.5, H: 0.5})

	if rec := postShotImage(t, mux, "/api/shots/1/image", "image/jpeg", testJPEG(t, 200, 100)); rec.Code != http.StatusOK {
		t.Fatalf("replacement photo status = %d; body=%s", rec.Code, rec.Body.String())
	}
	updated := mustShot(t, h, 1)
	if _, ok := updated["imageCrop"]; ok {
		t.Fatalf("imageCrop survived a new photo: %v", updated)
	}
	requireNoShotFile(t, shotImagePath(h, 1, "orig", "jpg"))
}

// TestPostImage_StoreOriginal covers `?original=1&crop=`: the upload becomes
// the uncropped original, the crop is recorded, and the main image is left
// alone. Also pins the four rejections that guard it.
func TestPostImage_StoreOriginal(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "Espresso", nil, nil)

	if rec := postShotImage(t, mux, "/api/shots/1/image", "image/jpeg", testJPEG(t, 64, 48)); rec.Code != http.StatusOK {
		t.Fatalf("upload status = %d; body=%s", rec.Code, rec.Body.String())
	}
	mainBefore, err := os.ReadFile(shotImagePath(h, 1, "", "jpg"))
	if err != nil {
		t.Fatalf("reading stored main image: %v", err)
	}

	want := img.Crop{X: 0.1, Y: 0.2, W: 0.5, H: 0.6}
	rec := postShotImage(t, mux, "/api/shots/1/image?original=1&crop=0.1,0.2,0.5,0.6", "image/jpeg", testJPEG(t, 200, 100))
	if rec.Code != http.StatusOK {
		t.Fatalf("store original status = %d; body=%s", rec.Code, rec.Body.String())
	}
	requireShotCrop(t, mustShot(t, h, 1), want)
	mainAfter, err := os.ReadFile(shotImagePath(h, 1, "", "jpg"))
	if err != nil {
		t.Fatalf("reading stored main image: %v", err)
	}
	if !bytes.Equal(mainBefore, mainAfter) {
		t.Fatalf("storing an original rewrote the main image")
	}
	orig, err := os.ReadFile(shotImagePath(h, 1, "orig", "jpg"))
	if err != nil {
		t.Fatalf("reading stored original: %v", err)
	}
	if cfg := jpegConfig(t, orig); cfg.Width != 200 || cfg.Height != 100 {
		t.Fatalf("stored original = %dx%d, want 200x100", cfg.Width, cfg.Height)
	}
	if resp := decodeBody(t, rec.Body.Bytes()); resp["image"] != "jpg" {
		t.Fatalf("response image = %v, want jpg (main untouched)", resp["image"])
	}

	if rec := postShotImage(t, mux, "/api/shots/1/image?original=1&crop=0.1,0.2,0.5,0.6", "image/png", pngMagic); rec.Code != http.StatusBadRequest {
		t.Fatalf("PNG original status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if rec := postShotImage(t, mux, "/api/shots/1/image?original=1&crop=0,0,2,2", "image/jpeg", testJPEG(t, 40, 30)); rec.Code != http.StatusBadRequest {
		t.Fatalf("out-of-range crop status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if rec := postShotImage(t, mux, "/api/shots/1/image?original=1", "image/jpeg", testJPEG(t, 40, 30)); rec.Code != http.StatusBadRequest {
		t.Fatalf("missing crop status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if rec := postShotImage(t, mux, "/api/shots/1/image?original=1&crop=0,0,0.5,0.5&thumb=1", "image/jpeg", testJPEG(t, 40, 30)); rec.Code != http.StatusBadRequest {
		t.Fatalf("unsupported query status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}

	insertShot(t, sqlDB, 2, 2000, &dur, "Espresso", nil, nil)
	rec = postShotImage(t, mux, "/api/shots/2/image?original=1&crop=0,0,0.5,0.5", "image/jpeg", testJPEG(t, 40, 30))
	if rec.Code != http.StatusConflict {
		t.Fatalf("original without a photo status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	requireNoShotFile(t, shotImagePath(h, 2, "orig", "jpg"))
}

// TestPostImage_Recrop covers `?crop=` alone: the main image is rebuilt from
// the stored original at the requested size, the original survives, and a
// main-image extension change drops the old main but never the original.
func TestPostImage_Recrop(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "Espresso", nil, nil)

	// A PNG main makes the later re-crop's jpg a real extension change.
	if rec := postShotImage(t, mux, "/api/shots/1/image", "image/png", pngMagic); rec.Code != http.StatusOK {
		t.Fatalf("png upload status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if rec := postShotImage(t, mux, "/api/shots/1/image?original=1&crop=0,0,1,1", "image/jpeg", testJPEG(t, 200, 100)); rec.Code != http.StatusOK {
		t.Fatalf("store original status = %d; body=%s", rec.Code, rec.Body.String())
	}

	// No body at all: a re-crop reads the original, not the request.
	rec := postShotImage(t, mux, "/api/shots/1/image?crop=0,0,0.5,0.5", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("re-crop status = %d; body=%s", rec.Code, rec.Body.String())
	}
	main, err := os.ReadFile(shotImagePath(h, 1, "", "jpg"))
	if err != nil {
		t.Fatalf("reading re-cropped main image: %v", err)
	}
	if cfg := jpegConfig(t, main); cfg.Width != 100 || cfg.Height != 50 {
		t.Fatalf("re-cropped main = %dx%d, want 100x50", cfg.Width, cfg.Height)
	}
	updated := mustShot(t, h, 1)
	requireShotCrop(t, updated, img.Crop{X: 0, Y: 0, W: 0.5, H: 0.5})
	if updated.imageExt() != "jpg" {
		t.Fatalf("image = %v, want jpg", updated.imageExt())
	}
	requireShotFile(t, shotImagePath(h, 1, "orig", "jpg"))
	requireNoShotFile(t, shotImagePath(h, 1, "", "png"))

	if rec := postShotImage(t, mux, "/api/shots/1/image?crop=0,0", "", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("malformed crop status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}

	insertShot(t, sqlDB, 2, 2000, &dur, "Espresso", map[string]any{"image": "jpg"}, nil)
	rec = postShotImage(t, mux, "/api/shots/2/image?crop=0,0,0.5,0.5", "", nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("re-crop without original status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
}

// TestGetImage_Original covers the read side of the invariant: the original is
// served only for a shot that both records a crop and still has the file.
func TestGetImage_Original(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "Espresso", nil, nil)

	if rec := postShotImage(t, mux, "/api/shots/1/image", "image/jpeg", testJPEG(t, 64, 48)); rec.Code != http.StatusOK {
		t.Fatalf("upload status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if rec := postShotImage(t, mux, "/api/shots/1/image?original=1&crop=0,0,0.5,0.5", "image/jpeg", testJPEG(t, 200, 100)); rec.Code != http.StatusOK {
		t.Fatalf("store original status = %d; body=%s", rec.Code, rec.Body.String())
	}

	// `original=1` wins over `thumb=1`: there is no thumbnail of an original.
	rec := doJSON(t, mux, http.MethodGet, "/api/shots/1/image?original=1&thumb=1", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET original status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Fatalf("GET original Content-Type = %q, want image/jpeg", got)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "private, no-cache" {
		t.Fatalf("GET original Cache-Control = %q, want private, no-cache", cc)
	}
	if cfg := jpegConfig(t, rec.Body.Bytes()); cfg.Width != 200 || cfg.Height != 100 {
		t.Fatalf("served original = %dx%d, want 200x100", cfg.Width, cfg.Height)
	}

	// The crop is what ties the file to the shot: without it the original is
	// not served even though it is on disk.
	insertShot(t, sqlDB, 2, 2000, &dur, "Espresso", map[string]any{"image": "jpg"}, nil)
	if err := os.WriteFile(shotImagePath(h, 2, "orig", "jpg"), testJPEG(t, 20, 10), 0o644); err != nil {
		t.Fatal(err)
	}
	if rec := doJSON(t, mux, http.MethodGet, "/api/shots/2/image?original=1", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("GET original without imageCrop status = %d, want 404", rec.Code)
	}

	os.Remove(shotImagePath(h, 1, "orig", "jpg"))
	if rec := doJSON(t, mux, http.MethodGet, "/api/shots/1/image?original=1", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("GET original with a missing file status = %d, want 404", rec.Code)
	}
}

// TestDeleteImage_RemovesMainThumbAndOriginal pins that DELETE .../image takes
// the thumbnail and the uncropped original with it, plus the crop that
// pointed into it.
func TestDeleteImage_RemovesMainThumbAndOriginal(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "Espresso", nil, nil)

	if rec := postShotImage(t, mux, "/api/shots/1/image", "image/jpeg", testJPEG(t, 800, 600)); rec.Code != http.StatusOK {
		t.Fatalf("upload status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if rec := postShotImage(t, mux, "/api/shots/1/image?original=1&crop=0,0,0.5,0.5", "image/jpeg", testJPEG(t, 200, 100)); rec.Code != http.StatusOK {
		t.Fatalf("store original status = %d; body=%s", rec.Code, rec.Body.String())
	}
	paths := []string{
		shotImagePath(h, 1, "", "jpg"),
		shotImagePath(h, 1, "thumb", "jpg"),
		shotImagePath(h, 1, "orig", "jpg"),
	}
	for _, p := range paths {
		requireShotFile(t, p)
	}

	rec := doJSON(t, mux, http.MethodDelete, "/api/shots/1/image", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}
	for _, p := range paths {
		requireNoShotFile(t, p)
	}
	updated := mustShot(t, h, 1)
	for _, key := range []string{"image", "imageCrop"} {
		if _, ok := updated[key]; ok {
			t.Fatalf("%s survived DELETE .../image: %v", key, updated)
		}
	}
}
