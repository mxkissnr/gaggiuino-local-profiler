package library

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func newTestGeocoder(t *testing.T, handler http.HandlerFunc) (*Geocoder, *int32) {
	t.Helper()
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		handler(w, r)
	}))
	t.Cleanup(srv.Close)

	_, repo, _ := newTestHandlers(t)
	g := &Geocoder{
		repo:        repo,
		http:        srv.Client(),
		apiURL:      srv.URL + "/search",
		lastRequest: time.Now().Add(-time.Hour), // no artificial wait on the first call
		assertHost:  func(context.Context, string) error { return nil },
	}
	return g, &calls
}

func TestGeocodeRegion_HitThenCached(t *testing.T) {
	g, calls := newTestGeocoder(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("q"); got != "Yirgacheffe, Ethiopia" {
			t.Errorf("query q = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"lat":"6.16","lon":"38.20","display_name":"Yirgacheffe"}]`))
	})

	loc, err := g.GeocodeRegion(context.Background(), "Yirgacheffe", "Ethiopia")
	if err != nil {
		t.Fatalf("GeocodeRegion: %v", err)
	}
	if loc == nil || loc.Lat != 6.16 || loc.Lon != 38.20 || loc.Label != "Yirgacheffe" {
		t.Fatalf("loc = %+v", loc)
	}

	// Second call for the same query must be served from the kv cache.
	loc2, err := g.GeocodeRegion(context.Background(), "Yirgacheffe", "Ethiopia")
	if err != nil {
		t.Fatalf("GeocodeRegion (cached): %v", err)
	}
	if loc2 == nil || *loc2 != *loc {
		t.Fatalf("cached loc = %+v, want %+v", loc2, loc)
	}
	if n := atomic.LoadInt32(calls); n != 1 {
		t.Fatalf("Nominatim called %d times, want 1 (second call must be cached)", n)
	}
}

func TestGeocodeRegion_MissIsCached(t *testing.T) {
	g, calls := newTestGeocoder(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[]`))
	})

	loc, err := g.GeocodeRegion(context.Background(), "Nowhere", "")
	if err != nil {
		t.Fatalf("GeocodeRegion: %v", err)
	}
	if loc != nil {
		t.Fatalf("loc = %+v, want nil", loc)
	}
	// A cached miss must not re-query.
	if _, err := g.GeocodeRegion(context.Background(), "Nowhere", ""); err != nil {
		t.Fatalf("GeocodeRegion (cached miss): %v", err)
	}
	if n := atomic.LoadInt32(calls); n != 1 {
		t.Fatalf("Nominatim called %d times, want 1 (miss must be cached)", n)
	}
}

func TestGeocodeBean_WritesLocation(t *testing.T) {
	g, _ := newTestGeocoder(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"lat":"6.16","lon":"38.20"}]`))
	})

	lib, err := g.repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	lib.Beans = append(lib.Beans, Entity{"id": int64(1001), "name": "Yirg", "region": "Yirgacheffe", "origin": "ET"})
	if err := g.repo.SaveLibrary(lib); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	g.GeocodeBean(context.Background(), 1001)

	// Re-read goes through JSON round-trip, so location comes back as a map.
	fresh, _ := g.repo.GetLibrary()
	loc, ok := fresh.Beans[0]["location"].(map[string]any)
	if !ok {
		t.Fatalf("bean location = %#v, want a map", fresh.Beans[0]["location"])
	}
	if lat, _ := loc["lat"].(float64); lat != 6.16 {
		t.Fatalf("bean location lat = %v, want 6.16", loc["lat"])
	}
}

func TestCountryNameForCode(t *testing.T) {
	if got := countryNameForCode("ET"); got != "Ethiopia" {
		t.Errorf("countryNameForCode(ET) = %q", got)
	}
	if got := countryNameForCode("zz"); got != "" {
		t.Errorf("countryNameForCode(zz) = %q, want empty", got)
	}
}
