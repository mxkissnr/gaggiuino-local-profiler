package library

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
)

// TestGeocodeRegion_TransientFailureRetried guards #1625: a Nominatim outage
// must not be cached as a permanent miss. The first call against a 503 gets an
// error and caches nothing; the retry hits the now-healthy server and resolves.
func TestGeocodeRegion_TransientFailureRetried(t *testing.T) {
	var outages int32
	g, calls := newTestGeocoder(t, func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&outages, 1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"lat":"6.16","lon":"38.20"}]`))
	})

	loc, err := g.GeocodeRegion(context.Background(), "Yirgacheffe", "Ethiopia")
	if err == nil {
		t.Fatal("GeocodeRegion during an outage: want an error, got nil")
	}
	if loc != nil {
		t.Fatalf("loc = %+v, want nil during an outage", loc)
	}

	loc2, err := g.GeocodeRegion(context.Background(), "Yirgacheffe", "Ethiopia")
	if err != nil {
		t.Fatalf("GeocodeRegion after recovery: %v", err)
	}
	if loc2 == nil || loc2.Lat != 6.16 || loc2.Lon != 38.20 {
		t.Fatalf("loc2 = %+v, want the recovered location", loc2)
	}
	if n := atomic.LoadInt32(calls); n != 2 {
		t.Fatalf("Nominatim called %d times, want 2 (the outage must not be cached)", n)
	}
}

// TestGeocodeRegion_EmptyResultCachedAsMiss confirms a 200 with no hit is a
// genuine miss and IS cached — the retry-on-failure change must not turn an
// unlocated region into a request every time.
func TestGeocodeRegion_EmptyResultCachedAsMiss(t *testing.T) {
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
	if _, err := g.GeocodeRegion(context.Background(), "Nowhere", ""); err != nil {
		t.Fatalf("GeocodeRegion (cached miss): %v", err)
	}
	if n := atomic.LoadInt32(calls); n != 1 {
		t.Fatalf("Nominatim called %d times, want 1 (a 200 empty result is a cached miss)", n)
	}
}
