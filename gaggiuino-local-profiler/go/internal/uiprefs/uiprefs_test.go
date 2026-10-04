package uiprefs

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
)

func newTestRepo(t *testing.T) (*Repository, *sql.DB) {
	t.Helper()
	sqlDB, err := db.Open(filepath.Join(t.TempDir(), "glp.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	return NewRepository(sqlDB), sqlDB
}

func newTestMux(t *testing.T) (*http.ServeMux, *Repository) {
	t.Helper()
	repo, _ := newTestRepo(t)
	mux := http.NewServeMux()
	NewHandlers(repo).RegisterRoutes(mux)
	return mux, repo
}

func do(t *testing.T, mux *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, r)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decoding %q: %v", rec.Body.String(), err)
	}
	return m
}

// ── repository ─────────────────────────────────────────────────────────

func TestGet_MissingRowIsEmpty(t *testing.T) {
	mux, _ := newTestMux(t)
	rec := do(t, mux, http.MethodGet, "/api/ui-prefs", "")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "{}" {
		t.Fatalf("GET = %d %q; want 200 {}", rec.Code, rec.Body.String())
	}
}

func TestGet_MalformedJSONIsEmpty(t *testing.T) {
	_, sqlDB := newTestRepo(t)
	for _, stored := range []string{`{not json`, `[]`, `"x"`, `null`} {
		if _, err := sqlDB.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES ('ui_prefs', ?)`, stored); err != nil {
			t.Fatal(err)
		}
		repo := NewRepository(sqlDB)
		got, err := repo.Get()
		if err != nil {
			t.Fatalf("Get(%q): %v", stored, err)
		}
		if len(got) != 0 {
			t.Errorf("Get(%q) = %+v; want empty map", stored, got)
		}
	}
}

func TestSaveGet_RoundTrip(t *testing.T) {
	repo, _ := newTestRepo(t)
	want := map[string]any{
		"view":    "shelf",
		"sort":    "name",
		"compact": true,
		"dose":    float64(18),
		"filter":  map[string]any{"drinkType": "espresso", "cols": float64(3)},
	}
	if err := repo.Save(want); err != nil {
		t.Fatal(err)
	}
	got, err := repo.Get()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("round trip = %+v; want %+v", got, want)
	}
}

// ── Sanitize ───────────────────────────────────────────────────────────

func TestSanitize_Valid(t *testing.T) {
	in := map[string]any{
		"view":    "shelf",
		"compact": true,
		"dose":    float64(18),
		"empty":   nil,
		"filter":  map[string]any{"drinkType": "espresso", "cols": float64(3), "pinned": true, "x": nil},
	}
	out, issues := Sanitize(in)
	if len(issues) != 0 {
		t.Fatalf("issues = %v; want none", issues)
	}
	if !reflect.DeepEqual(out, in) {
		t.Errorf("cleaned = %+v; want %+v", out, in)
	}
}

func TestSanitize_InvalidKey(t *testing.T) {
	for _, key := range []string{"", "View", "1view", "with space", "view!", strings.Repeat("a", 65)} {
		_, issues := Sanitize(map[string]any{key: "x"})
		if len(issues) == 0 {
			t.Errorf("key %q accepted; want rejected", key)
		}
	}
}

func TestSanitize_TooManyKeys(t *testing.T) {
	in := map[string]any{}
	for i := 0; i < maxKeys+1; i++ {
		in["k"+string(rune('a'+i%26))+string(rune('a'+i/26))] = "x"
	}
	if len(in) != maxKeys+1 {
		t.Fatalf("test built %d keys, want %d", len(in), maxKeys+1)
	}
	if _, issues := Sanitize(in); len(issues) == 0 {
		t.Errorf("%d keys accepted; want rejected", len(in))
	}
}

func TestSanitize_OversizedValue(t *testing.T) {
	if _, issues := Sanitize(map[string]any{"view": strings.Repeat("x", maxStringLen+1)}); len(issues) == 0 {
		t.Error("oversized string accepted; want rejected")
	}
	if _, issues := Sanitize(map[string]any{"view": strings.Repeat("x", maxStringLen)}); len(issues) != 0 {
		t.Errorf("max-length string rejected: %v", issues)
	}
}

func TestSanitize_RejectsDeeperNesting(t *testing.T) {
	cases := map[string]map[string]any{
		"nested object": {"a": map[string]any{"b": "c"}},
		"array":         {"a": []any{float64(1)}},
		"flat in flat":  {"a": map[string]any{"b": map[string]any{"c": "d"}}},
	}
	for name, in := range cases {
		if _, issues := Sanitize(in); len(issues) == 0 {
			t.Errorf("%s accepted; want rejected", name)
		}
	}
}

func TestSanitize_RejectsTooManyFlatKeys(t *testing.T) {
	flat := map[string]any{}
	for i := 0; i < maxFlatKeys+1; i++ {
		flat["k"+string(rune('a'+i))] = "x"
	}
	if _, issues := Sanitize(map[string]any{"filter": flat}); len(issues) == 0 {
		t.Errorf("%d flat keys accepted; want rejected", len(flat))
	}
}

func TestSanitize_RejectsOversizedEncoding(t *testing.T) {
	// 64 keys all holding a 256-char string exceed 16 KiB.
	in := map[string]any{}
	for i := 0; i < maxKeys; i++ {
		in["k"+string(rune('a'+i%26))+string(rune('a'+i/26))] = strings.Repeat("x", maxStringLen)
	}
	if _, issues := Sanitize(in); len(issues) == 0 {
		t.Error("oversized encoding accepted; want rejected")
	}
}

// ── handlers ───────────────────────────────────────────────────────────

func TestPUT_PartialMerge(t *testing.T) {
	mux, _ := newTestMux(t)
	rec := do(t, mux, http.MethodPut, "/api/ui-prefs", `{"view":"shelf"}`)
	if rec.Code != http.StatusOK || decode(t, rec)["view"] != "shelf" {
		t.Fatalf("PUT = %d %q", rec.Code, rec.Body.String())
	}
	rec = do(t, mux, http.MethodPut, "/api/ui-prefs", `{"sort":"name"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d %q", rec.Code, rec.Body.String())
	}
	got := decode(t, rec)
	if got["view"] != "shelf" || got["sort"] != "name" {
		t.Fatalf("merge lost a key: %+v", got)
	}
	rec = do(t, mux, http.MethodGet, "/api/ui-prefs", "")
	if g := decode(t, rec); g["view"] != "shelf" || g["sort"] != "name" {
		t.Fatalf("GET after merge = %+v", g)
	}
}

func TestPUT_NullDeletes(t *testing.T) {
	mux, _ := newTestMux(t)
	do(t, mux, http.MethodPut, "/api/ui-prefs", `{"view":"shelf","sort":"name"}`)
	rec := do(t, mux, http.MethodPut, "/api/ui-prefs", `{"view":null}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT = %d %q", rec.Code, rec.Body.String())
	}
	got := decode(t, rec)
	if _, ok := got["view"]; ok {
		t.Errorf("null did not delete key: %+v", got)
	}
	if got["sort"] != "name" {
		t.Errorf("null deleted the wrong key: %+v", got)
	}
}

func TestPUT_EmptyBodyIsNoop(t *testing.T) {
	mux, _ := newTestMux(t)
	rec := do(t, mux, http.MethodPut, "/api/ui-prefs", "")
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "{}" {
		t.Fatalf("PUT empty = %d %q; want 200 {}", rec.Code, rec.Body.String())
	}
}

func TestPUT_ValidationFailureIs400AndNotSaved(t *testing.T) {
	mux, _ := newTestMux(t)
	for _, body := range []string{
		`{"BadKey":"x"}`,
		`{"view":{"a":{"b":"c"}}}`,
		`{"view":"` + strings.Repeat("x", maxStringLen+1) + `"}`,
	} {
		rec := do(t, mux, http.MethodPut, "/api/ui-prefs", body)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("PUT %s = %d; want 400", body, rec.Code)
		}
		resp := decode(t, rec)
		if resp["error"] != "Validation failed" {
			t.Errorf("PUT %s error = %v; want Validation failed", body, resp["error"])
		}
		if issues, _ := resp["issues"].([]any); len(issues) == 0 {
			t.Errorf("PUT %s issues = %v; want non-empty", body, resp["issues"])
		}
	}
	rec := do(t, mux, http.MethodGet, "/api/ui-prefs", "")
	if g := decode(t, rec); len(g) != 0 {
		t.Errorf("invalid PUT was persisted: %+v", g)
	}
}

func TestPUT_MalformedJSONIs400(t *testing.T) {
	mux, _ := newTestMux(t)
	rec := do(t, mux, http.MethodPut, "/api/ui-prefs", `{not json`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("PUT malformed = %d %q; want 400", rec.Code, rec.Body.String())
	}
}
