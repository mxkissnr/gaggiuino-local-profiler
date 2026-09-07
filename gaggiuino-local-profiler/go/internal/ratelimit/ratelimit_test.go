package ratelimit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLimiter_Allow_BucketExhaustionAndReset(t *testing.T) {
	// Small window/max so the test doesn't need to wait a real minute.
	l := New(100*time.Millisecond, 3)

	for i := 0; i < 3; i++ {
		if !l.Allow("1.2.3.4") {
			t.Fatalf("request %d: expected to be allowed within burst", i+1)
		}
	}
	if l.Allow("1.2.3.4") {
		t.Fatal("expected the 4th request to be rejected once the bucket is exhausted")
	}

	// A different key must have its own, independent bucket.
	if !l.Allow("5.6.7.8") {
		t.Fatal("expected a different key to have its own unexhausted bucket")
	}

	// Tokens refill continuously; after waiting past the window a request
	// must be allowed again.
	time.Sleep(150 * time.Millisecond)
	if !l.Allow("1.2.3.4") {
		t.Fatal("expected the bucket to have refilled after waiting past the window")
	}
}

func TestLimiter_Middleware_RejectsWithJSON429(t *testing.T) {
	l := New(time.Minute, 1)
	handler := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.RemoteAddr = "10.0.0.1:1234"

	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first request: expected 200, got %d", rec1.Code)
	}

	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusTooManyRequests {
		t.Fatalf("second request: expected 429, got %d", rec2.Code)
	}
	if ct := rec2.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var body map[string]string
	if err := json.Unmarshal(rec2.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding 429 body: %v", err)
	}
	if body["error"] != "Too many requests" {
		t.Errorf("body = %v, want error:\"Too many requests\"", body)
	}
}

func TestLimiter_Middleware_AssetsExempt(t *testing.T) {
	l := New(time.Minute, 1)
	handler := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	req.RemoteAddr = "10.0.0.2:1234"

	// Far more requests than the configured burst of 1 -- all must pass
	// because /assets/* is exempt from the limiter entirely.
	for i := 0; i < 10; i++ {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d to /assets/: expected 200, got %d", i+1, rec.Code)
		}
	}
}

func TestLimiter_Middleware_KeyIsSocketAddressOnly(t *testing.T) {
	// A spoofed X-Forwarded-For must not let a client dodge its own bucket
	// — the limiter must key purely on RemoteAddr, matching server.js never
	// trusting XFF (see doc.go).
	l := New(time.Minute, 1)
	handler := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req1 := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req1.RemoteAddr = "10.0.0.3:1234"
	req1.Header.Set("X-Forwarded-For", "1.1.1.1")
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first request: expected 200, got %d", rec1.Code)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req2.RemoteAddr = "10.0.0.3:5678" // same host, different port -- RemoteIP strips the port
	req2.Header.Set("X-Forwarded-For", "2.2.2.2")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusTooManyRequests {
		t.Fatalf("second request from the same socket address (different spoofed XFF): expected 429, got %d", rec2.Code)
	}
}

func TestLimiter_Middleware_IPv6SameSlash64ShareBucket(t *testing.T) {
	// Two different addresses drawn from the same routed /64 must share one
	// bucket -- otherwise a client with a /64 (or larger) IPv6 allocation
	// could dodge the limit by presenting a fresh address on every request.
	l := New(time.Minute, 1)
	handler := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req1 := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req1.RemoteAddr = "[2001:db8:1234:5678::1]:1234"
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first request: expected 200, got %d", rec1.Code)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req2.RemoteAddr = "[2001:db8:1234:5678::dead:beef]:5678"
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusTooManyRequests {
		t.Fatalf("second request from a different address in the same /64: expected 429, got %d", rec2.Code)
	}
}

func TestLimiter_Middleware_IPv6DifferentSlash64GetSeparateBuckets(t *testing.T) {
	l := New(time.Minute, 1)
	handler := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req1 := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req1.RemoteAddr = "[2001:db8:1234:5678::1]:1234"
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first request: expected 200, got %d", rec1.Code)
	}

	req2 := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req2.RemoteAddr = "[2001:db8:9999:0000::1]:5678"
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("request from a different /64: expected 200, got %d", rec2.Code)
	}
}

func TestBucketKey(t *testing.T) {
	cases := []struct {
		name string
		ip   string
		want string
	}{
		{"ipv4 unchanged", "10.0.0.3", "10.0.0.3"},
		{"ipv6 masked to /64", "2001:db8:1234:5678::1", "2001:db8:1234:5678::"},
		{"ipv6 mapped-v4 unchanged", "::ffff:10.0.0.3", "10.0.0.3"},
		{"unparseable passed through", "not-an-ip", "not-an-ip"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := bucketKey(tc.ip); got != tc.want {
				t.Errorf("bucketKey(%q) = %q, want %q", tc.ip, got, tc.want)
			}
		})
	}
}
