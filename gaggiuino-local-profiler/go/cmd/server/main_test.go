package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestGetEnvNumber(t *testing.T) {
	const name = "GLP_TEST_RATE_LIMIT_NUMBER"

	t.Run("unset falls back to default", func(t *testing.T) {
		os.Unsetenv(name)
		if got := getEnvNumber(name, 600); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default)", got)
		}
	})

	t.Run("valid override wins", func(t *testing.T) {
		t.Setenv(name, "1200")
		if got := getEnvNumber(name, 600); got != 1200 {
			t.Errorf("getEnvNumber() = %v, want 1200 (override)", got)
		}
	})

	t.Run("invalid value falls back to default", func(t *testing.T) {
		t.Setenv(name, "not-a-number")
		if got := getEnvNumber(name, 600); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, invalid input)", got)
		}
	})

	t.Run("zero falls back to default, matching JS falsy semantics", func(t *testing.T) {
		t.Setenv(name, "0")
		if got := getEnvNumber(name, 600); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, zero is falsy in JS)", got)
		}
	})

	t.Run("empty string falls back to default", func(t *testing.T) {
		t.Setenv(name, "")
		if got := getEnvNumber(name, 600); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, empty string)", got)
		}
	})
}

func TestRequireKnownHostOnBuiltHandler(t *testing.T) {
	handler, _, _ := newTestApp(t, appConfig{
		port:            "0",
		rateLimitWindow: time.Minute,
		rateLimitMax:    1_000_000,
	})

	// An unknown Host is refused with 421 before even the public GET /api/token
	// handler runs (#1430).
	reqUnknown := httptest.NewRequest(http.MethodGet, "/api/token", nil)
	reqUnknown.Host = "evil.example.com"
	reqUnknown.RemoteAddr = "192.168.1.50:1234"
	recUnknown := httptest.NewRecorder()
	handler.ServeHTTP(recUnknown, reqUnknown)
	if recUnknown.Code != http.StatusMisdirectedRequest {
		t.Fatalf("Host: evil.example.com -> %d, want 421", recUnknown.Code)
	}

	// Loopback is a known host, so the request reaches the handler chain (200,
	// or 403 when expose_api_port is off) -- anything but 421.
	reqKnown := httptest.NewRequest(http.MethodGet, "/api/token", nil)
	reqKnown.Host = "127.0.0.1:8099"
	reqKnown.RemoteAddr = "192.168.1.50:1234"
	recKnown := httptest.NewRecorder()
	handler.ServeHTTP(recKnown, reqKnown)
	if recKnown.Code == http.StatusMisdirectedRequest {
		t.Fatalf("Host: 127.0.0.1:8099 -> 421, want a non-421 response")
	}
}
