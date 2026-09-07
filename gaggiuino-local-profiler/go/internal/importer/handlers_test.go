package importer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
)

// cannedResp is one queued fake HTTP response (the axiosGet.mockResolvedValueOnce
// equivalent).
type cannedResp struct {
	status  int
	headers map[string]string
	body    string
	err     error
}

func jsonResp(body any) cannedResp {
	b, _ := json.Marshal(body)
	return cannedResp{status: 200, body: string(b)}
}

func htmlResp(body string) cannedResp { return cannedResp{status: 200, body: body} }

type queueRT struct {
	t     *testing.T
	resps []cannedResp
	calls []string
}

func (q *queueRT) RoundTrip(r *http.Request) (*http.Response, error) {
	q.calls = append(q.calls, r.URL.String())
	if len(q.resps) == 0 {
		q.t.Fatalf("unexpected extra request: %s", r.URL)
	}
	c := q.resps[0]
	q.resps = q.resps[1:]
	if c.err != nil {
		return nil, c.err
	}
	h := http.Header{}
	for k, v := range c.headers {
		h.Set(k, v)
	}
	return &http.Response{
		StatusCode: c.status, Header: h,
		Body: io.NopCloser(strings.NewReader(c.body)), Request: r,
	}, nil
}

// dnsFunc lets a test point a host at a private address; unknown hosts
// resolve to a fixed public address.
func setDNS(t *testing.T, override map[string]string) {
	t.Helper()
	orig := lookupIPAddr
	lookupIPAddr = func(_ context.Context, host string) ([]net.IPAddr, error) {
		ipStr, ok := override[host]
		if !ok {
			ipStr = "203.0.113.10"
		}
		return []net.IPAddr{{IP: net.ParseIP(ipStr)}}, nil
	}
	t.Cleanup(func() { lookupIPAddr = orig })
}

func newHandlers(t *testing.T, beans []map[string]any, resps ...cannedResp) (*Handlers, *queueRT, *http.ServeMux) {
	t.Helper()
	sqlDB, err := db.Open(filepath.Join(t.TempDir(), "glp.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	h := NewHandlers(NewRepository(sqlDB), func() []map[string]any { return beans })
	q := &queueRT{t: t, resps: resps}
	h.fetch.client.Transport = q
	setDNS(t, nil)
	m := http.NewServeMux()
	h.RegisterRoutes(m)
	return h, q, m
}

func do(t *testing.T, m *http.ServeMux, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	m.ServeHTTP(rec, r)
	return rec
}

func jsonBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decoding %q: %v", rec.Body.String(), err)
	}
	return out
}

func urlq(u string) string { return "/api/import/url?url=" + urlEncode(u) }

func urlEncode(s string) string {
	r := strings.NewReplacer(":", "%3A", "/", "%2F", "?", "%3F", "=", "%3D", "&", "%26")
	return r.Replace(s)
}

// ── tests ──────────────────────────────────────────────────────────────

func TestImportURL_CacheHeaderAlways(t *testing.T) {
	_, _, m := newHandlers(t, nil)
	rec := do(t, m, http.MethodGet, "/api/import/url", "")
	if rec.Code != 400 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("code=%d cc=%q", rec.Code, rec.Header().Get("Cache-Control"))
	}
}

func TestImportURL_BuiltinHoploVariants(t *testing.T) {
	_, _, m := newHandlers(t, nil, jsonResp(map[string]any{
		"title": "Test Bean - Ruanda", "vendor": "Hoppenworth & Ploch", "description": "",
		"variants": []any{
			map[string]any{"id": 1, "price": 1490, "weight": 250, "option1": "250g", "unit_price_measurement": map[string]any{"quantity_unit": "g"}},
			map[string]any{"id": 2, "price": 5200, "weight": 1000, "option1": "1kg", "unit_price_measurement": map[string]any{"quantity_unit": "g"}},
		},
	}))
	rec := do(t, m, http.MethodGet, urlq("https://hoppenworth-ploch.de/products/test-bean"), "")
	body := jsonBody(t, rec)
	if body["importMethod"] != "builtin:hoppenworth-ploch" {
		t.Errorf("importMethod = %v", body["importMethod"])
	}
	variants, _ := body["variants"].([]any)
	if len(variants) != 2 {
		t.Fatalf("variants = %v", body["variants"])
	}
	v0 := variants[0].(map[string]any)
	if v0["title"] != "250g" || v0["weight"].(float64) != 250 || v0["unit"] != "g" {
		t.Errorf("v0 = %v", v0)
	}
}

func TestImportURL_GenericShopifyFallback(t *testing.T) {
	_, q, m := newHandlers(t, nil,
		jsonResp(map[string]any{"title": "Ethiopia Washed", "vendor": "Random Roastery", "description": "<p>Noten von Zitrone.</p>", "featured_image": "//cdn.shopify.com/random.jpg"}),
		htmlResp("<html><body>no markers</body></html>"), // HTML enrich attempt
	)
	rec := do(t, m, http.MethodGet, urlq("https://randomroaster.example/products/ethiopia"), "")
	body := jsonBody(t, rec)
	if body["name"] != "Ethiopia Washed" || body["roaster"] != "Random Roastery" || body["importMethod"] != "generic-shopify" {
		t.Fatalf("body = %v", body)
	}
	if q.calls[0] != "https://randomroaster.example/products/ethiopia.js" {
		t.Errorf("first call = %s", q.calls[0])
	}
}

func TestImportURL_JSONLD(t *testing.T) {
	ld, _ := json.Marshal(map[string]any{
		"@context": "https://schema.org", "@type": "Product",
		"name": "Colombia Huila", "description": "Notes of caramel and orange.",
		"brand":  map[string]any{"name": "Some Roastery"},
		"offers": map[string]any{"@type": "Offer", "price": "14.90"},
	})
	html := `<html><head><script type="application/ld+json">` + string(ld) + `</script></head><body></body></html>`
	_, _, m := newHandlers(t, nil, htmlResp(html))
	rec := do(t, m, http.MethodGet, urlq("https://blog.example/coffee/colombia"), "")
	body := jsonBody(t, rec)
	if body["name"] != "Colombia Huila" || body["roaster"] != "Some Roastery" || body["importMethod"] != "jsonld" {
		t.Fatalf("body = %v", body)
	}
	if body["price_eur"].(float64) != 14.9 {
		t.Errorf("price_eur = %v", body["price_eur"])
	}
}

func TestImportURL_OpenGraph(t *testing.T) {
	html := `<html><head>
	<meta property="og:title" content="Kenya AA">
	<meta property="og:site_name" content="Kenya Roasters GmbH">
	<meta property="og:price:amount" content="15.90">
	</head><body></body></html>`
	_, _, m := newHandlers(t, nil, htmlResp(html))
	rec := do(t, m, http.MethodGet, urlq("https://shop.example/product/kenya"), "")
	body := jsonBody(t, rec)
	if body["importMethod"] != "opengraph" || body["roaster"] != "Kenya Roasters GmbH" {
		t.Fatalf("body = %v", body)
	}
	if body["price_eur"].(float64) != 15.9 {
		t.Errorf("price_eur = %v", body["price_eur"])
	}
}

func TestImportURL_404WhenNothingFound(t *testing.T) {
	_, _, m := newHandlers(t, nil, htmlResp("<html><head></head><body>nothing</body></html>"))
	rec := do(t, m, http.MethodGet, urlq("https://empty.example/x"), "")
	if rec.Code != 404 {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestImportURL_HTMLEnrichFillsFields(t *testing.T) {
	detail := `<html><body><details class="details"><summary>Details</summary>
	<div class="details-content"><p>Process - Anaerobic Natural</p><p>Elevation - 1900-2300 MASL</p></div>
	</details></body></html>`
	_, q, m := newHandlers(t, nil,
		jsonResp(map[string]any{"title": "Flower Power", "vendor": "adventurous", "description": "", "price": 1800}),
		htmlResp(detail),
	)
	rec := do(t, m, http.MethodGet, urlq("https://sproutcoffeeroasters.art/products/flower-power"), "")
	body := jsonBody(t, rec)
	if body["process"] != "Anaerobic Natural" {
		t.Errorf("process = %v", body["process"])
	}
	if body["altitude_m"].(float64) != 2100 {
		t.Errorf("altitude_m = %v", body["altitude_m"])
	}
	if len(q.calls) != 2 {
		t.Errorf("calls = %v", q.calls)
	}
}

func TestImportURL_HTMLEnrichFailureKeepsBean(t *testing.T) {
	_, _, m := newHandlers(t, nil,
		jsonResp(map[string]any{"title": "Flower Power", "vendor": "adventurous", "description": "", "price": 1800}),
		cannedResp{err: errors.New("timeout")},
	)
	rec := do(t, m, http.MethodGet, urlq("https://sproutcoffeeroasters.art/products/flower-power"), "")
	body := jsonBody(t, rec)
	if rec.Code != 200 || body["name"] != "Flower Power" {
		t.Fatalf("code=%d body=%v", rec.Code, body)
	}
	if _, ok := body["process"]; ok {
		t.Errorf("process should be absent, got %v", body["process"])
	}
}

func TestImportURL_DebugField(t *testing.T) {
	html := `<html><body><div class="origin-wrapper"><h5 class="origin-title">Process</h5><p>Washed</p></div></body></html>`
	_, _, m := newHandlers(t, nil,
		jsonResp(map[string]any{"title": "Flower Power", "vendor": "adventurous", "description": "", "price": 1800}),
		htmlResp(html),
	)
	rec := do(t, m, http.MethodGet, urlq("https://sproutcoffeeroasters.art/products/flower-power")+"&debug=1", "")
	body := jsonBody(t, rec)
	dbg, ok := body["_debug"].(map[string]any)
	if !ok {
		t.Fatalf("_debug missing: %v", body)
	}
	if dbg["needsHtmlEnrich"] != true || dbg["hasOriginWrapper"] != true || dbg["hasOriginTitle"] != true || dbg["hasDetailsAccordion"] != false {
		t.Errorf("_debug = %v", dbg)
	}

	// no debug flag -> no _debug
	_, _, m2 := newHandlers(t, nil,
		jsonResp(map[string]any{"title": "Flower Power", "vendor": "adventurous", "description": "", "price": 1800}),
		htmlResp("<html><body>nope</body></html>"),
	)
	body2 := jsonBody(t, do(t, m2, http.MethodGet, urlq("https://sproutcoffeeroasters.art/products/flower-power"), ""))
	if _, ok := body2["_debug"]; ok {
		t.Error("_debug should be absent without ?debug=1")
	}
}

func TestImportURL_DuplicateWarning(t *testing.T) {
	beans := []map[string]any{{"id": 999.0, "name": "Some Existing Bean", "roaster": "Whoever", "sourceUrl": "https://dupshop.example/products/repeat"}}
	_, _, m := newHandlers(t, beans,
		jsonResp(map[string]any{"title": "Some New Title", "vendor": "Whoever", "description": ""}),
		htmlResp("<html><body></body></html>"))
	rec := do(t, m, http.MethodGet, urlq("https://dupshop.example/products/repeat"), "")
	body := jsonBody(t, rec)
	dw, ok := body["duplicateWarning"].(map[string]any)
	if !ok || dw["id"].(float64) != 999 {
		t.Fatalf("duplicateWarning = %v", body["duplicateWarning"])
	}
}

func TestImportURL_SSRFPrivateAddress(t *testing.T) {
	_, q, m := newHandlers(t, nil)
	setDNS(t, map[string]string{"internal-service.example": "10.1.2.3"})
	rec := do(t, m, http.MethodGet, urlq("https://internal-service.example/products/x"), "")
	if rec.Code != 400 || jsonBody(t, rec)["error"] != "blocked address" {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(q.calls) != 0 {
		t.Errorf("no fetch should have happened, calls=%v", q.calls)
	}
}

func TestImportURL_SSRFRedirectToPrivate(t *testing.T) {
	_, q, m := newHandlers(t, nil, cannedResp{
		status: 302, headers: map[string]string{"Location": "https://internal.example/products/x.js"}, body: "",
	})
	setDNS(t, map[string]string{"internal.example": "192.168.1.5"})
	rec := do(t, m, http.MethodGet, urlq("https://public-shop.example/products/x"), "")
	if rec.Code != 400 || jsonBody(t, rec)["error"] != "blocked address" {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(q.calls) != 1 {
		t.Errorf("redirect must not be followed, calls=%v", q.calls)
	}
}

func TestImportURL_RejectsNonHTTPS(t *testing.T) {
	_, q, m := newHandlers(t, nil)
	rec := do(t, m, http.MethodGet, urlq("http://kaffeebraun.com/products/x"), "")
	if rec.Code != 400 {
		t.Fatalf("code = %d", rec.Code)
	}
	if len(q.calls) != 0 {
		t.Errorf("no fetch, calls=%v", q.calls)
	}
}

func TestImportSettings_GetDefault(t *testing.T) {
	_, _, m := newHandlers(t, nil)
	body := jsonBody(t, do(t, m, http.MethodGet, "/api/import/settings", ""))
	providers, _ := body["providers"].([]any)
	if len(providers) != 3 {
		t.Fatalf("providers = %v", body["providers"])
	}
	for _, p := range providers {
		if p.(map[string]any)["enabled"] != true {
			t.Errorf("provider not enabled: %v", p)
		}
	}
	if arr, _ := body["customShopifyDomains"].([]any); len(arr) != 0 {
		t.Errorf("customShopifyDomains = %v", body["customShopifyDomains"])
	}
}

func TestImportSettings_PostFiltersGarbage(t *testing.T) {
	h, _, m := newHandlers(t, nil)
	rec := do(t, m, http.MethodPost, "/api/import/settings",
		`{"disabledProviders":["kaffeebraun","not-a-real-id"],"customShopifyDomains":["shop.example.com","not a domain","https://other-shop.example/path"]}`)
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	s := h.repo.GetSettings()
	if len(s.DisabledProviders) != 1 || s.DisabledProviders[0] != "kaffeebraun" {
		t.Errorf("disabledProviders = %v", s.DisabledProviders)
	}
	if strings.Join(s.CustomShopifyDomains, ",") != "shop.example.com,other-shop.example" {
		t.Errorf("customShopifyDomains = %v", s.CustomShopifyDomains)
	}
}

func TestImportSettings_PostDisabledProviderFallsToGeneric(t *testing.T) {
	h, _, m := newHandlers(t, nil,
		jsonResp(map[string]any{"title": "BOMBE", "vendor": "elbgold", "description": "<p>Noten von Kirsche und Mandel.</p>"}),
		htmlResp("<html><body>x</body></html>"),
	)
	if err := h.repo.SaveSettings(Settings{DisabledProviders: []string{"elbgold"}, CustomShopifyDomains: []string{}}); err != nil {
		t.Fatal(err)
	}
	rec := do(t, m, http.MethodGet, urlq("https://elbgold.com/products/bombe"), "")
	body := jsonBody(t, rec)
	if body["importMethod"] != "generic-shopify" || body["roaster"] != "elbgold" {
		t.Fatalf("body = %v", body)
	}
}
