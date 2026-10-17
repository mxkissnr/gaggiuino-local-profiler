package system

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fakeGitHubReleases(t *testing.T, tag string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"tag_name":%q}`, tag)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestVersionChecker_UpdateAvailable(t *testing.T) {
	srv := fakeGitHubReleases(t, "v99.0.0")
	vc := newVersionChecker()
	vc.apiURL = srv.URL

	info := vc.CheckForUpdate(context.Background())
	if info.Current != glpVersion {
		t.Errorf("Current = %q, want %q", info.Current, glpVersion)
	}
	if info.Latest == nil || *info.Latest != "99.0.0" {
		t.Fatalf("Latest = %v, want 99.0.0 (v-prefix stripped)", info.Latest)
	}
	if !info.UpdateAvailable {
		t.Error("UpdateAvailable = false, want true (99.0.0 != current)")
	}
}

func TestVersionChecker_UpToDate(t *testing.T) {
	srv := fakeGitHubReleases(t, "v"+glpVersion)
	vc := newVersionChecker()
	vc.apiURL = srv.URL

	info := vc.CheckForUpdate(context.Background())
	if info.UpdateAvailable {
		t.Error("UpdateAvailable = true, want false when latest == current")
	}
}

func TestVersionChecker_DevBuildNeverReportsUpdate(t *testing.T) {
	srv := fakeGitHubReleases(t, "v99.0.0")
	vc := newVersionChecker()
	vc.apiURL = srv.URL
	vc.devBuild = true

	info := vc.CheckForUpdate(context.Background())
	if info.UpdateAvailable {
		t.Error("UpdateAvailable = true, want false for a dev build regardless of latest")
	}
}

func TestVersionChecker_FetchFailure_DegradesGracefully(t *testing.T) {
	vc := newVersionChecker()
	vc.apiURL = "http://127.0.0.1:1" // connection refused
	info := vc.CheckForUpdate(context.Background())
	if info.Current != glpVersion {
		t.Errorf("Current = %q, want %q even on fetch failure", info.Current, glpVersion)
	}
	if info.Latest != nil {
		t.Errorf("Latest = %v, want nil on fetch failure", *info.Latest)
	}
	if info.UpdateAvailable {
		t.Error("UpdateAvailable = true, want false when latest is unknown")
	}
}

// noDialTransport fails the test if any HTTP request is made through it, so a
// checker under test proves it never reached the network.
type noDialTransport struct{ t *testing.T }

func (n noDialTransport) RoundTrip(*http.Request) (*http.Response, error) {
	n.t.Error("CheckForUpdate dialed the network from a test binary")
	return nil, fmt.Errorf("unexpected request")
}

// TestVersionChecker_TestBinaryNeverDialsGitHub proves newVersionChecker leaves
// apiURL empty inside a test binary and that CheckForUpdate then returns no
// latest value without issuing any request.
func TestVersionChecker_TestBinaryNeverDialsGitHub(t *testing.T) {
	vc := newVersionChecker()
	if vc.apiURL != "" {
		t.Fatalf("apiURL = %q, want empty inside a test binary", vc.apiURL)
	}
	vc.http = &http.Client{Transport: noDialTransport{t: t}}

	info := vc.CheckForUpdate(context.Background())
	if info.Latest != nil {
		t.Errorf("Latest = %v, want nil when no fetch is attempted", *info.Latest)
	}
	if info.UpdateAvailable {
		t.Error("UpdateAvailable = true, want false when no fetch is attempted")
	}
}

// TestVersionChecker_FailureBackoff (#1616): a failed lookup is not retried
// for versionFailureBackoff — the response stays "nothing known" — and the
// next call after the backoff asks GitHub again and picks up the release.
func TestVersionChecker_FailureBackoff(t *testing.T) {
	var calls atomic.Int32
	fail := atomic.Bool{}
	fail.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if fail.Load() {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Write([]byte(`{"tag_name":"v99.0.0"}`))
	}))
	t.Cleanup(srv.Close)
	vc := newVersionChecker()
	vc.apiURL = srv.URL

	for i := 0; i < 3; i++ {
		if info := vc.CheckForUpdate(context.Background()); info.Latest != nil {
			t.Fatalf("call %d: Latest = %v, want nil while GitHub fails", i, *info.Latest)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("expected 1 request inside the failure backoff, got %d", got)
	}

	fail.Store(false)
	vc.mu.Lock()
	vc.failedAt = time.Now().Add(-2 * versionFailureBackoff)
	vc.mu.Unlock()
	info := vc.CheckForUpdate(context.Background())
	if info.Latest == nil || *info.Latest != "99.0.0" {
		t.Fatalf("after the backoff: Latest = %v, want 99.0.0", info.Latest)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("expected a retry after the backoff, got %d requests", got)
	}
}

// TestVersionChecker_ConcurrentCallsShareOneFetch (#1616): stale callers
// that arrive together share a single GitHub request.
func TestVersionChecker_ConcurrentCallsShareOneFetch(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		<-release
		w.Write([]byte(`{"tag_name":"v99.0.0"}`))
	}))
	t.Cleanup(srv.Close)
	vc := newVersionChecker()
	vc.apiURL = srv.URL

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			vc.CheckForUpdate(context.Background())
		}()
	}
	for calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if got := calls.Load(); got != 1 {
		t.Fatalf("expected one shared request, got %d", got)
	}
	if info := vc.CheckForUpdate(context.Background()); info.Latest == nil || *info.Latest != "99.0.0" {
		t.Fatalf("Latest = %v, want 99.0.0", info.Latest)
	}
}
