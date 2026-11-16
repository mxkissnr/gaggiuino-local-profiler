package library

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func grinderByID(t *testing.T, grinders []map[string]any, id int64) map[string]any {
	t.Helper()
	for _, g := range grinders {
		if got, _ := g["id"].(float64); int64(got) == id {
			return g
		}
	}
	t.Fatalf("grinder %d not found in %+v", id, grinders)
	return nil
}

func putGrinder(t *testing.T, mux *http.ServeMux, id int64, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+strconv.FormatInt(id, 10), mustMarshal(t, body))
}

func TestGrinderScale_CreateStoresScale(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	scale := map[string]any{"type": "stepped", "min": 0.0, "max": 60.0, "step": 1.0}
	id := createTestGrinder(t, mux, map[string]any{"name": "Kingrinder K6", "scale": scale})

	stored, ok := grinderByID(t, getGrinders(t, mux), id)["scale"].(map[string]any)
	if !ok {
		t.Fatal("created grinder has no scale")
	}
	if stored["type"] != "stepped" || stored["min"] != 0.0 || stored["max"] != 60.0 || stored["step"] != 1.0 {
		t.Errorf("stored scale = %#v", stored)
	}
}

func TestGrinderScale_CreateWithoutScaleStoresNothing(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	id := createTestGrinder(t, mux, map[string]any{"name": "No Scale"})
	stored := grinderByID(t, getGrinders(t, mux), id)
	if v, ok := stored["scale"]; ok {
		t.Errorf("grinder gained a scale key: %#v", v)
	}
}

func TestGrinderScale_UpdateSetsKeepsAndRemoves(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	id := createTestGrinder(t, mux, map[string]any{"name": "Lagom Casa"})
	scale := map[string]any{"type": "stepless", "min": 0.0, "max": 9.0, "step": 0.1}
	if rec := putGrinder(t, mux, id, map[string]any{"scale": scale}); rec.Code != http.StatusOK {
		t.Fatalf("PUT scale status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got, ok := grinderByID(t, getGrinders(t, mux), id)["scale"].(map[string]any); !ok {
		t.Fatalf("PUT did not store a scale")
	} else if got["step"] != 0.1 {
		t.Errorf("stored step = %v, want 0.1", got["step"])
	}

	if rec := putGrinder(t, mux, id, map[string]any{"notes": "keep me"}); rec.Code != http.StatusOK {
		t.Fatalf("PUT notes status = %d; body=%s", rec.Code, rec.Body.String())
	}
	stored := grinderByID(t, getGrinders(t, mux), id)
	if _, ok := stored["scale"].(map[string]any); !ok {
		t.Errorf("a PUT without scale dropped it: %#v", stored)
	}

	if rec := putGrinder(t, mux, id, map[string]any{"scale": nil}); rec.Code != http.StatusOK {
		t.Fatalf("PUT null scale status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if v, ok := grinderByID(t, getGrinders(t, mux), id)["scale"]; ok {
		t.Errorf("PUT null kept the scale: %#v", v)
	}
}

func TestGrinderScale_CreateInvalidScaleIs400(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	invalid := []map[string]any{
		{"type": "clicky", "min": 0.0, "max": 9.0, "step": 0.1},
		{"type": "stepless", "min": 9.0, "max": 0.0, "step": 0.1},
		{"type": "stepless", "min": 0.0, "max": 9.0, "step": 0.0},
		{"type": "stepless", "min": -1.0, "max": 9.0, "step": 0.1},
	}
	for _, scale := range invalid {
		rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{
			"name": "Bad Scale", "scale": scale,
		}))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("POST scale %#v status = %d, want 400; body=%s", scale, rec.Code, rec.Body.String())
		}
	}
	if grinders := getGrinders(t, mux); len(grinders) != 0 {
		t.Errorf("a rejected create stored something: %+v", grinders)
	}
}

func TestGrinderScale_UpdateInvalidScaleIs400(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	good := map[string]any{"type": "stepped", "min": 0.0, "max": 60.0, "step": 1.0}
	id := createTestGrinder(t, mux, map[string]any{"name": "K6", "scale": good})

	invalid := []map[string]any{
		{"type": "clicky", "min": 0.0, "max": 9.0, "step": 0.1},
		{"type": "stepless", "min": 9.0, "max": 0.0, "step": 0.1},
		{"type": "stepless", "min": 0.0, "max": 9.0, "step": 0.0},
		{"type": "stepless", "min": -1.0, "max": 9.0, "step": 0.1},
	}
	for _, scale := range invalid {
		rec := putGrinder(t, mux, id, map[string]any{"scale": scale})
		if rec.Code != http.StatusBadRequest {
			t.Errorf("PUT scale %#v status = %d, want 400; body=%s", scale, rec.Code, rec.Body.String())
		}
	}

	stored, ok := grinderByID(t, getGrinders(t, mux), id)["scale"].(map[string]any)
	if !ok {
		t.Fatalf("a rejected update dropped the previous scale")
	}
	if stored["type"] != "stepped" || stored["max"] != 60.0 {
		t.Errorf("previous scale changed to %#v", stored)
	}
}

func TestSanitizeGrinderFields_Scale(t *testing.T) {
	valid := Entity{"name": "K6", "scale": map[string]any{
		"type": "stepped", "min": 0.0, "max": 60.0, "step": 1.0,
	}}
	out := SanitizeGrinderFields(valid)
	stored, ok := out["scale"].(map[string]any)
	if !ok {
		t.Fatalf("a valid scale was dropped: %#v", out)
	}
	if stored["type"] != "stepped" || stored["max"] != 60.0 {
		t.Errorf("kept scale = %#v", stored)
	}

	garbage := Entity{"name": "K6", "scale": map[string]any{"type": "clicky"}}
	if v, ok := SanitizeGrinderFields(garbage)["scale"]; ok {
		t.Errorf("a garbage scale survived: %#v", v)
	}

	absent := Entity{"name": "K6"}
	if v, ok := SanitizeGrinderFields(absent)["scale"]; ok {
		t.Errorf("a grinder without a scale gained one: %#v", v)
	}

	others := Entity{"name": " K6 ", "notes": "  n  ", "burrType": " flat ", "purchaseDate": "2026-01-02"}
	out = SanitizeGrinderFields(others)
	if out["name"] != "K6" || out["notes"] != "n" || out["burrType"] != "flat" || out["purchaseDate"] != "2026-01-02" {
		t.Errorf("other fields changed: %#v", out)
	}
}
