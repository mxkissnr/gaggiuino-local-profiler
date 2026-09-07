package library

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestScanBarcode_InvalidFormat(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/library/scan/123", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["error"] != "Validation failed" {
		t.Errorf("error = %v, want 'Validation failed'", body["error"])
	}
}

func TestScanBarcode_SSRFBlockedReturns502(t *testing.T) {
	withFakeLookup(t, map[string][]net.IP{offHost: {net.ParseIP("10.0.0.1")}})
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodGet, "/api/library/scan/5000112637922", nil)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502; body=%s", rec.Code, rec.Body.String())
	}
}

func TestScanBarcode_HappyPathAndNotFound(t *testing.T) {
	withFakeLookup(t, map[string][]net.IP{offHost: {net.ParseIP("93.184.216.34")}})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v3/product/5000112637922.json":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"product":{"product_name":"Test Coffee","brands":"Test Roaster","labels":"Organic","categories_tags":["en:coffees","fr:something"]}}`))
		case "/api/v3/product/00000000.json":
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	origBase := offBaseURL
	offBaseURL = srv.URL
	t.Cleanup(func() { offBaseURL = origBase })

	h, _, _ := newTestHandlers(t)
	mux := newMux(h)

	rec := doJSON(t, mux, http.MethodGet, "/api/library/scan/5000112637922", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["name"] != "Test Coffee" || body["roaster"] != "Test Roaster" {
		t.Errorf("unexpected body: %+v", body)
	}
	if body["notes"] != "coffees, Organic" {
		t.Errorf("notes = %v, want 'coffees, Organic'", body["notes"])
	}

	rec = doJSON(t, mux, http.MethodGet, "/api/library/scan/00000000", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rec.Code, rec.Body.String())
	}
}
