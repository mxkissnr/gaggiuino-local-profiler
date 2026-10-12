package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"syscall"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
)

func TestGetEnvNumber(t *testing.T) {
	const name = "GLP_TEST_RATE_LIMIT_NUMBER"

	t.Run("unset falls back to default", func(t *testing.T) {
		os.Unsetenv(name)
		if got := getEnvNumber(name, 600, 1); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default)", got)
		}
	})

	t.Run("valid override wins", func(t *testing.T) {
		t.Setenv(name, "1200")
		if got := getEnvNumber(name, 600, 1); got != 1200 {
			t.Errorf("getEnvNumber() = %v, want 1200 (override)", got)
		}
	})

	t.Run("invalid value falls back to default", func(t *testing.T) {
		t.Setenv(name, "not-a-number")
		if got := getEnvNumber(name, 600, 1); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, invalid input)", got)
		}
	})

	t.Run("zero falls back to default, matching JS falsy semantics", func(t *testing.T) {
		t.Setenv(name, "0")
		if got := getEnvNumber(name, 600, 1); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, zero is falsy in JS)", got)
		}
	})

	t.Run("empty string falls back to default", func(t *testing.T) {
		t.Setenv(name, "")
		if got := getEnvNumber(name, 600, 1); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, empty string)", got)
		}
	})

	t.Run("fractional value below min falls back to default", func(t *testing.T) {
		t.Setenv(name, "0.5")
		if got := getEnvNumber(name, 600, 1); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, below min)", got)
		}
	})

	t.Run("negative value falls back to default", func(t *testing.T) {
		t.Setenv(name, "-5")
		if got := getEnvNumber(name, 600, 1); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, negative)", got)
		}
	})

	t.Run("NaN falls back to default", func(t *testing.T) {
		t.Setenv(name, "NaN")
		if got := getEnvNumber(name, 600, 1); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, NaN)", got)
		}
	})

	t.Run("integer above min wins", func(t *testing.T) {
		t.Setenv(name, "200")
		if got := getEnvNumber(name, 600, 1); got != 200 {
			t.Errorf("getEnvNumber() = %v, want 200 (override)", got)
		}
	})
}

func TestConfigFromEnvRateLimitMaxFallback(t *testing.T) {
	// A fractional max truncates to 0 as an int, which used to panic inside
	// ratelimit.New's divide by zero; it must fall back to the default instead.
	t.Setenv("GLP_RATE_LIMIT_MAX", "0.5")
	cfg := configFromEnv()
	if cfg.rateLimitMax != ratelimit.DefaultMax {
		t.Errorf("rateLimitMax = %d, want default %d", cfg.rateLimitMax, ratelimit.DefaultMax)
	}
	// The returned settings must not panic when handed to ratelimit.New.
	_ = ratelimit.New(cfg.rateLimitWindow, cfg.rateLimitMax)
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

// TestServeUntilStoppedWaitsForInFlightRequest pins the shutdown contract: a
// request already in flight when shutdown is triggered must finish, and
// serveUntilStopped must not return until it has -- returning on Serve's early
// http.ErrServerClosed would let main's deferred sqlDB.Close() run under it.
func TestServeUntilStoppedWaitsForInFlightRequest(t *testing.T) {
	handlerStarted := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(handlerStarted)
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("done"))
	})

	baseCtx, cancelBase := context.WithCancel(context.Background())
	defer cancelBase()
	srv := &http.Server{
		Handler:     handler,
		BaseContext: func(net.Listener) context.Context { return baseCtx },
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	stop := make(chan os.Signal, 1)
	serveErr := make(chan error, 1)
	start := time.Now()
	go func() { serveErr <- serveUntilStopped(srv, ln, stop, cancelBase) }()

	respCh := make(chan *http.Response, 1)
	errCh := make(chan error, 1)
	go func() {
		resp, err := http.Get("http://" + ln.Addr().String() + "/")
		if err != nil {
			errCh <- err
			return
		}
		respCh <- resp
	}()

	// Trigger shutdown only once the request is actually being handled, so it
	// is genuinely in flight when the drain starts.
	select {
	case <-handlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("request never reached the handler")
	}
	stop <- syscall.SIGTERM

	select {
	case err := <-serveErr:
		if err != http.ErrServerClosed {
			t.Fatalf("serveUntilStopped = %v, want http.ErrServerClosed", err)
		}
		if elapsed := time.Since(start); elapsed < 300*time.Millisecond {
			t.Fatalf("serveUntilStopped returned after %v, before the 300ms handler finished", elapsed)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("serveUntilStopped did not return after shutdown")
	}

	select {
	case resp := <-respCh:
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("in-flight request status = %d, want 200", resp.StatusCode)
		}
	case err := <-errCh:
		t.Fatalf("in-flight request failed: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("no response for the in-flight request")
	}
}
