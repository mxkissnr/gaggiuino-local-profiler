package webapp

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

const fakeIndex = "<!DOCTYPE html><html><head><title>GLP</title></head><body><div id=\"glp-app-root\"></div></body></html>"

func testHandlers(t *testing.T) *Handlers {
	t.Helper()
	return newHandlers(fstest.MapFS{
		"index.html":          {Data: []byte(fakeIndex)},
		"manifest.json":       {Data: []byte(`{"name":"GLP"}`)},
		"sw.js":               {Data: []byte("/* service worker */")},
		"assets/app-abc.js":   {Data: []byte("console.log(1)")},
		"countries-110m.json": {Data: []byte(`{"type":"Topology"}`)},
	})
}

// ingressRequest builds a request that auth.IsIngressRequest accepts: the
// X-Ingress-Path prefix plus a Supervisor-network source IP.
func ingressRequest(method, target string) *http.Request {
	r := httptest.NewRequest(method, target, nil)
	r.Header.Set("X-Ingress-Path", "/api/hassio_ingress/tok3n")
	r.RemoteAddr = "172.30.32.2:9000"
	return r
}

func TestIndex_ManifestInjectedWhenNotIngress(t *testing.T) {
	h := testHandlers(t)
	rec := httptest.NewRecorder()
	h.index(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `<link rel="manifest" href="manifest.json">`) {
		t.Errorf("non-Ingress GET / is missing the injected manifest link:\n%s", body)
	}
	if strings.Count(body, "</head>") != 1 {
		t.Errorf("</head> count = %d, want 1 (injection must not duplicate it)", strings.Count(body, "</head>"))
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
}

func TestIndex_NoManifestUnderIngress(t *testing.T) {
	h := testHandlers(t)
	rec := httptest.NewRecorder()
	h.index(rec, ingressRequest(http.MethodGet, "/"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "manifest") {
		t.Errorf("Ingress GET / must not carry a manifest link:\n%s", rec.Body.String())
	}
}

func TestIndex_NoCacheHeaders(t *testing.T) {
	h := testHandlers(t)
	rec := httptest.NewRecorder()
	h.index(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	for k, want := range map[string]string{
		"Cache-Control": "no-cache, no-store, must-revalidate",
		"Pragma":        "no-cache",
		"Expires":       "0",
	} {
		if got := rec.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
}

func TestRoutes_IndexAndIndexHTML(t *testing.T) {
	mux := http.NewServeMux()
	testHandlers(t).RegisterRoutes(mux)

	for _, path := range []string{"/", "/index.html"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status = %d", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), `id="glp-app-root"`) {
			t.Errorf("GET %s did not return the SPA shell:\n%s", path, rec.Body.String())
		}
	}
}

func TestStatic_AssetsServed(t *testing.T) {
	mux := http.NewServeMux()
	testHandlers(t).RegisterRoutes(mux)

	cases := []struct {
		path        string
		wantStatus  int
		wantCTHas   string
		wantBodyHas string
	}{
		{"/manifest.json", 200, "json", `"name":"GLP"`},
		{"/sw.js", 200, "javascript", "service worker"},
		{"/assets/app-abc.js", 200, "javascript", "console.log"},
		{"/countries-110m.json", 200, "json", "Topology"},
		{"/does-not-exist.js", 404, "", ""},
		{"/assets/", 404, "", ""},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if rec.Code != tc.wantStatus {
			t.Errorf("GET %s: status = %d, want %d", tc.path, rec.Code, tc.wantStatus)
			continue
		}
		if tc.wantCTHas != "" && !strings.Contains(rec.Header().Get("Content-Type"), tc.wantCTHas) {
			t.Errorf("GET %s: Content-Type = %q, want to contain %q", tc.path, rec.Header().Get("Content-Type"), tc.wantCTHas)
		}
		if tc.wantBodyHas != "" && !strings.Contains(rec.Body.String(), tc.wantBodyHas) {
			t.Errorf("GET %s: body = %q, want to contain %q", tc.path, rec.Body.String(), tc.wantBodyHas)
		}
	}
}

func TestStatic_RejectsTraversal(t *testing.T) {
	h := testHandlers(t)
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/x", nil)
	r.URL.Path = "/assets/../../etc/passwd" // bypass ServeMux path cleaning
	h.static(rec, r)
	if rec.Code != http.StatusNotFound {
		t.Errorf("traversal path: status = %d, want 404", rec.Code)
	}
}

func TestStatic_HTMLFileGetsNoCache(t *testing.T) {
	h := newHandlers(fstest.MapFS{
		"index.html":   {Data: []byte(fakeIndex)},
		"offline.html": {Data: []byte("<!DOCTYPE html><title>x</title>")},
	})
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/offline.html", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get("Cache-Control") != "no-cache, no-store, must-revalidate" {
		t.Errorf("a served .html file must carry no-cache headers, got %q", rec.Header().Get("Cache-Control"))
	}
}

// TestEmbeddedBundle proves the real //go:embed all:dist resolves (against
// the committed placeholder in CI, or the real Vite build locally) and that
// GET / returns whatever index.html it holds.
func TestEmbeddedBundle(t *testing.T) {
	rec := httptest.NewRecorder()
	mux := http.NewServeMux()
	NewHandlers().RegisterRoutes(mux)
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /: status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<title>GLP</title>") {
		t.Errorf("embedded index.html missing expected <title>:\n%s", rec.Body.String())
	}
}
