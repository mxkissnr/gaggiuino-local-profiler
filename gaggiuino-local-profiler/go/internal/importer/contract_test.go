package importer

import (
	"net/http"
	"testing"
)

// This file pins routes/import.js's wire contract — the "pin the essential
// shape, not the whole grammar" check orders/shots/library's
// contract_test.go established. The parser-by-parser value assertions live
// in handlers_test.go; this file pins what every response of each route
// guarantees.

// TestContract_ImportURL_SuccessShape: GET /api/import/url on a happy path
// returns a parsed-bean object with at least name + importMethod, and
// always Cache-Control: no-store (#486).
func TestContract_ImportURL_SuccessShape(t *testing.T) {
	_, _, m := newHandlers(t, nil,
		jsonResp(map[string]any{
			"title": "Kenya AA", "vendor": "Some Roastery", "description": "",
			"variants": []any{map[string]any{"id": 1, "price": 1490, "weight": 250, "option1": "250g"}},
		}),
		htmlResp("<html><body></body></html>"), // generic-shopify HTML enrich attempt
	)
	rec := do(t, m, http.MethodGet, urlq("https://someroastery.example/products/kenya-aa"), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	body := jsonBody(t, rec)
	if name, _ := body["name"].(string); name == "" {
		t.Errorf("response has no name: %v", body)
	}
	if im, _ := body["importMethod"].(string); im == "" {
		t.Errorf("response has no importMethod: %v", body)
	}
}

// TestContract_ImportURL_SSRFRejection: a URL whose host resolves into
// private address space is rejected 400 { error: "blocked address" }
// before any fetch happens — the contract glp's #486 SSRF guard owes every
// caller.
func TestContract_ImportURL_SSRFRejection(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "192.168.1.5", "169.254.1.1", "::1"} {
		_, q, m := newHandlers(t, nil)
		setDNS(t, map[string]string{"private.example": ip})
		rec := do(t, m, http.MethodGet, urlq("https://private.example/products/x"), "")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", ip, rec.Code)
		}
		if got := jsonBody(t, rec)["error"]; got != "blocked address" {
			t.Errorf("%s: error = %v, want %q", ip, got, "blocked address")
		}
		if len(q.calls) != 0 {
			t.Errorf("%s: a fetch happened despite a blocked host: %v", ip, q.calls)
		}
	}
}

// TestContract_ImportSettings_Shape: GET returns { providers: [...],
// customShopifyDomains: [...] } with every provider carrying
// id/label/enabled; POST echoes the persisted settings back.
func TestContract_ImportSettings_Shape(t *testing.T) {
	h, _, m := newHandlers(t, nil)

	get := jsonBody(t, do(t, m, http.MethodGet, "/api/import/settings", ""))
	providers, ok := get["providers"].([]any)
	if !ok || len(providers) == 0 {
		t.Fatalf("providers = %v", get["providers"])
	}
	for _, raw := range providers {
		p, _ := raw.(map[string]any)
		if _, ok := p["id"].(string); !ok {
			t.Errorf("provider missing id: %v", p)
		}
		if _, ok := p["label"].(string); !ok {
			t.Errorf("provider missing label: %v", p)
		}
		if _, ok := p["enabled"].(bool); !ok {
			t.Errorf("provider missing enabled bool: %v", p)
		}
	}
	if _, ok := get["customShopifyDomains"].([]any); !ok {
		t.Errorf("customShopifyDomains = %v, want an array", get["customShopifyDomains"])
	}

	post := do(t, m, http.MethodPost, "/api/import/settings", `{"disabledProviders":["kaffeebraun"],"customShopifyDomains":["shop.example.com"]}`)
	if post.Code != http.StatusOK {
		t.Fatalf("POST status = %d, body=%s", post.Code, post.Body.String())
	}
	if s := h.repo.GetSettings(); len(s.DisabledProviders) != 1 || s.DisabledProviders[0] != "kaffeebraun" {
		t.Errorf("disabledProviders not persisted: %v", s.DisabledProviders)
	}
}
