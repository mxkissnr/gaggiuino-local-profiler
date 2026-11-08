package library

import (
	"net/http"
	"testing"
)

// createTestGrinder POSTs a grinder and returns its id.
func createTestGrinder(t *testing.T, mux *http.ServeMux, body map[string]any) int64 {
	t.Helper()
	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, body))
	if rec.Code != http.StatusOK {
		t.Fatalf("create grinder status = %d; body=%s", rec.Code, rec.Body.String())
	}
	return int64(decodeBody(t, rec.Body.Bytes())["id"].(float64))
}

// getGrinders reads GET /api/library and returns each grinder entity, so a
// test can assert both the flag and that a key is absent.
func getGrinders(t *testing.T, mux *http.ServeMux) []map[string]any {
	t.Helper()
	rec := doJSON(t, mux, http.MethodGet, "/api/library", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/library status = %d; body=%s", rec.Code, rec.Body.String())
	}
	raw, _ := decodeBody(t, rec.Body.Bytes())["grinders"].([]any)
	out := make([]map[string]any, len(raw))
	for i, g := range raw {
		out[i], _ = g.(map[string]any)
	}
	return out
}

// flaggedGrinders returns the names of every grinder carrying isDefault true.
func flaggedGrinders(grinders []map[string]any) []string {
	var names []string
	for _, g := range grinders {
		if isDefault, _ := g["isDefault"].(bool); isDefault {
			name, _ := g["name"].(string)
			names = append(names, name)
		}
	}
	return names
}

func TestGrinderDefault_PutClearsPrevious(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	a := createTestGrinder(t, mux, map[string]any{"name": "A"})
	b := createTestGrinder(t, mux, map[string]any{"name": "B"})

	rec := doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(a), mustMarshal(t, map[string]any{"isDefault": true}))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT A isDefault status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := flaggedGrinders(getGrinders(t, mux)); len(got) != 1 || got[0] != "A" {
		t.Fatalf("after flagging A: flagged = %v, want [A]", got)
	}

	rec = doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(b), mustMarshal(t, map[string]any{"isDefault": true}))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT B isDefault status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := flaggedGrinders(getGrinders(t, mux)); len(got) != 1 || got[0] != "B" {
		t.Fatalf("after flagging B: flagged = %v, want [B]", got)
	}
}

func TestGrinderDefault_CreateClearsPrevious(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	createTestGrinder(t, mux, map[string]any{"name": "A", "isDefault": true})
	createTestGrinder(t, mux, map[string]any{"name": "B", "isDefault": true})

	if got := flaggedGrinders(getGrinders(t, mux)); len(got) != 1 || got[0] != "B" {
		t.Fatalf("flagged = %v, want [B]", got)
	}
}

func TestGrinderDefault_PutFalseClearsAll(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	a := createTestGrinder(t, mux, map[string]any{"name": "A", "isDefault": true})
	rec := doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(a), mustMarshal(t, map[string]any{"isDefault": false}))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT isDefault false status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := flaggedGrinders(getGrinders(t, mux)); len(got) != 0 {
		t.Fatalf("flagged = %v, want none", got)
	}
	for _, g := range getGrinders(t, mux) {
		if _, ok := g["isDefault"]; ok {
			t.Errorf("grinder still carries isDefault: %+v", g)
		}
	}
}

func TestGrinderDefault_OtherPutKeepsFlag(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	a := createTestGrinder(t, mux, map[string]any{"name": "A", "isDefault": true})

	rec := doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(a), mustMarshal(t, map[string]any{"notes": "still the default"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT notes status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := flaggedGrinders(getGrinders(t, mux)); len(got) != 1 || got[0] != "A" {
		t.Fatalf("after notes-only PUT: flagged = %v, want [A]", got)
	}

	rec = doJSON(t, mux, http.MethodPut, "/api/library/grinder/"+itoa(a), mustMarshal(t, map[string]any{"name": "A renamed"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT rename status = %d; body=%s", rec.Code, rec.Body.String())
	}
	if got := flaggedGrinders(getGrinders(t, mux)); len(got) != 1 || got[0] != "A renamed" {
		t.Fatalf("after rename: flagged = %v, want [A renamed]", got)
	}
}

func TestGrinderDefault_DeleteDefaultLeavesOthersUnflagged(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	createTestGrinder(t, mux, map[string]any{"name": "A"})
	b := createTestGrinder(t, mux, map[string]any{"name": "B", "isDefault": true})

	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder/"+itoa(b)+"/delete", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d; body=%s", rec.Code, rec.Body.String())
	}
	grinders := getGrinders(t, mux)
	if len(grinders) != 1 || grinders[0]["name"] != "A" {
		t.Fatalf("grinders = %+v, want just A", grinders)
	}
	if got := flaggedGrinders(grinders); len(got) != 0 {
		t.Fatalf("flagged = %v, want none", got)
	}
}

func TestGrinderDefault_CreateWithoutKeyStoresNothing(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	createTestGrinder(t, mux, map[string]any{"name": "A"})
	grinders := getGrinders(t, mux)
	if len(grinders) != 1 {
		t.Fatalf("grinders = %+v, want 1", grinders)
	}
	if _, ok := grinders[0]["isDefault"]; ok {
		t.Fatalf("unflagged grinder carries isDefault: %+v", grinders[0])
	}
}

func TestSanitizeLibraryForRestore_DefaultGrinder(t *testing.T) {
	lib := Library{}
	lib.Grinders = []Entity{
		{"id": int64(1), "name": "A", "isDefault": true},
		{"id": int64(2), "name": "B", "isDefault": true},
		{"id": int64(3), "name": "C", "isDefault": "yes"},
		{"id": int64(4), "name": "D"},
	}
	out := SanitizeLibraryForRestore(lib)

	if _, ok := out.Grinders[0]["isDefault"]; !ok {
		t.Errorf("first flagged grinder lost its flag: %+v", out.Grinders[0])
	}
	if _, ok := out.Grinders[1]["isDefault"]; ok {
		t.Errorf("second flagged grinder kept its flag: %+v", out.Grinders[1])
	}
	if _, ok := out.Grinders[2]["isDefault"]; ok {
		t.Errorf("non-bool flag was not dropped: %+v", out.Grinders[2])
	}
	if _, ok := out.Grinders[3]["isDefault"]; ok {
		t.Errorf("absent flag gained a key: %+v", out.Grinders[3])
	}
}
