package library

import (
	"net/http"
	"testing"
)

// This file pins routes/library/*.js's responses against openapi.yaml's
// component schemas for the shapes this package's endpoints actually
// return — the same "pin the essential shape, not the whole grammar"
// approach shots/contract_test.go applies.

func requireField(t *testing.T, body map[string]any, key string) any {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got keys %v", key, keysOf(body))
	}
	return v
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestContract_BeanShape pins openapi.yaml's Bean schema's required fields
// (id, name) plus the fields glp-integration/glp-lovelace-card are known to
// read off a created bean.
func TestContract_BeanShape(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{"name": "Kenya AA"}))
	bean := decodeBody(t, rec.Body.Bytes())
	requireField(t, bean, "id")
	requireField(t, bean, "name")
	// knownGrindSettings is deliberately NOT expected here: LibraryService.js's
	// upsertKnownGrindSetting only ever adds that key lazily on first use
	// (POST .../known-grind) — a freshly created bean never has it, matching
	// the Node original exactly (see TestBean_CreateUpdateDeleteLifecycle's
	// known-grind subtest for that path).
	for _, field := range []string{"origin", "origins", "enabled", "decaf", "bags"} {
		if _, ok := bean[field]; !ok {
			t.Errorf("expected Bean field %q, got keys %v", field, keysOf(bean))
		}
	}
}

// TestContract_BeansInfoShape pins GET /api/library/beans-info's per-item
// shape (id, name, roaster, origin, variety, process, roastDate, decaf) —
// the cross-repo contract glp-integration's proxy and glp-lovelace-card
// both consume directly.
func TestContract_BeansInfoShape(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	doJSON(t, mux, http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{"name": "Kenya AA", "origin": "KE"}))
	rec := doJSON(t, mux, http.MethodGet, "/api/library/beans-info", nil)
	arr := decodeBodyArray(t, rec.Body.Bytes())
	if len(arr) != 1 {
		t.Fatalf("expected 1 bean, got %d", len(arr))
	}
	for _, field := range []string{"id", "name", "roaster", "origin", "variety", "process", "roastDate", "decaf"} {
		if _, ok := arr[0][field]; !ok {
			t.Errorf("expected beans-info field %q, got keys %v", field, keysOf(arr[0]))
		}
	}
}

// TestContract_GrinderWearFieldNames pins the REAL field names
// LibraryService.js's computeGrinderWearStats returns
// (shotsSinceBurrs/gramsSinceBurrs) — see handlers.go's withWear doc
// comment for why this deliberately does NOT match openapi.yaml's
// documented {shots, grams} Grinder.wear schema.
func TestContract_GrinderWearFieldNames(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{"name": "Niche Zero"}))
	grinder := decodeBody(t, rec.Body.Bytes())
	id := int64(grinder["id"].(float64))
	rec = doJSON(t, mux, http.MethodPost, "/api/library/grinder/"+itoa(id)+"/reset-burrs", nil)
	updated := decodeBody(t, rec.Body.Bytes())
	wear, ok := updated["wear"].(map[string]any)
	if !ok {
		t.Fatalf("expected wear object, got %+v", updated["wear"])
	}
	if _, ok := wear["shotsSinceBurrs"]; !ok {
		t.Errorf("expected wear.shotsSinceBurrs, got keys %v", keysOf(wear))
	}
	if _, ok := wear["gramsSinceBurrs"]; !ok {
		t.Errorf("expected wear.gramsSinceBurrs, got keys %v", keysOf(wear))
	}
}

// TestContract_LibraryShape pins openapi.yaml's Library schema's six
// collection keys.
func TestContract_LibraryShape(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/library", nil)
	lib := decodeBody(t, rec.Body.Bytes())
	for _, field := range []string{"beans", "grinders", "baskets", "puckScreens", "recipes", "milks"} {
		if _, ok := lib[field]; !ok {
			t.Errorf("expected Library field %q, got keys %v", field, keysOf(lib))
		}
	}
}

// TestContract_MilkShape pins openapi.yaml's Milk schema (required [id,
// name]) plus emoji/stockMl.
func TestContract_MilkShape(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/library/milk", mustMarshal(t, map[string]any{"name": "Oat"}))
	milk := decodeBody(t, rec.Body.Bytes())
	requireField(t, milk, "id")
	requireField(t, milk, "name")
	requireField(t, milk, "emoji")
	requireField(t, milk, "stockMl")
}

// TestContract_OkShape pins openapi.yaml's Ok schema (required [ok], ok:
// boolean) against every documented Library 200/{ok:true} endpoint.
func TestContract_OkShape(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	_ = sqlDB

	t.Run("bean delete", func(t *testing.T) {
		id, _ := createTestBean(t, mux, nil)
		rec := doJSON(t, mux, http.MethodPost, "/api/library/bean/"+itoa(id)+"/delete", nil)
		requireBoolField(t, decodeBody(t, rec.Body.Bytes()), "ok")
	})
	t.Run("grinder delete", func(t *testing.T) {
		rec := doJSON(t, mux, http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{"name": "g"}))
		id := int64(decodeBody(t, rec.Body.Bytes())["id"].(float64))
		rec = doJSON(t, mux, http.MethodPost, "/api/library/grinder/"+itoa(id)+"/delete", nil)
		requireBoolField(t, decodeBody(t, rec.Body.Bytes()), "ok")
	})
	t.Run("recipe delete", func(t *testing.T) {
		rec := doJSON(t, mux, http.MethodPost, "/api/library/recipe", mustMarshal(t, map[string]any{"name": "r"}))
		id := int64(decodeBody(t, rec.Body.Bytes())["id"].(float64))
		rec = doJSON(t, mux, http.MethodPost, "/api/library/recipe/"+itoa(id)+"/delete", nil)
		requireBoolField(t, decodeBody(t, rec.Body.Bytes()), "ok")
	})
}

func requireBoolField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if _, ok := v.(bool); !ok {
		t.Errorf("expected %q to be a boolean, got %T (%v)", key, v, v)
	}
}

// TestContract_ErrorShape pins openapi.yaml's Error schema (required
// [error], error: string) against every documented 400/404 branch.
func TestContract_ErrorShape(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	cases := []struct {
		name   string
		method string
		path   string
		body   []byte
		status int
	}{
		{"bean create missing name", http.MethodPost, "/api/library/bean", mustMarshal(t, map[string]any{}), http.StatusBadRequest},
		{"bean update not found", http.MethodPut, "/api/library/bean/999999", mustMarshal(t, map[string]any{"name": "x"}), http.StatusNotFound},
		{"grinder create missing name", http.MethodPost, "/api/library/grinder", mustMarshal(t, map[string]any{}), http.StatusBadRequest},
		{"basket update not found", http.MethodPut, "/api/library/basket/999999", mustMarshal(t, map[string]any{"name": "x"}), http.StatusNotFound},
		{"milk deduct not found", http.MethodPost, "/api/library/milk/999999/deduct", mustMarshal(t, map[string]any{"ml": 1}), http.StatusNotFound},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := doJSON(t, mux, c.method, c.path, c.body)
			if rec.Code != c.status {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, c.status, rec.Body.String())
			}
			requireField(t, decodeBody(t, rec.Body.Bytes()), "error")
		})
	}
}
