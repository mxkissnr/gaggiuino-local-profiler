package machines

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func fakeGitHubReleases(t *testing.T, releases []githubRelease) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		if page != "" && page != "1" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`[]`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(releases)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFirmwareChecker_FindsMatchingChannel(t *testing.T) {
	srv := fakeGitHubReleases(t, []githubRelease{
		{TagName: "dev-aaa1111", PublishedAt: "2026-01-01T00:00:00Z", HTMLURL: "https://example.com/dev"},
		{TagName: "main-bbb2222", PublishedAt: "2026-02-01T00:00:00Z", HTMLURL: "https://example.com/main"},
	})
	overrideReleasesAPI(t, srv.URL)

	c := NewFirmwareChecker()
	stable := 0
	rel, err := c.GetLatestFirmwareRelease(context.Background(), &stable)
	if err != nil {
		t.Fatalf("GetLatestFirmwareRelease: %v", err)
	}
	if rel == nil || rel.Hash != "bbb2222" {
		t.Fatalf("stable channel release = %+v, want hash bbb2222", rel)
	}

	debug := 2
	c.resetCacheForTests()
	rel, err = c.GetLatestFirmwareRelease(context.Background(), &debug)
	if err != nil {
		t.Fatalf("GetLatestFirmwareRelease (debug): %v", err)
	}
	if rel == nil || rel.Hash != "aaa1111" {
		t.Fatalf("debug channel release = %+v, want hash aaa1111", rel)
	}
}

// #1042: fetchLatestRelease must pick the globally latest matching-prefix
// release by published_at across ALL scanned pages, not just return the
// first page that happens to contain any match. Zer0-bit/gaggiuino's real
// releases list is not reliably ordered by published_at (see the header
// comment on fetchLatestRelease), so an earlier page can contain an older
// match while a newer one sits on a later page.
func TestFirmwareChecker_PicksLatestAcrossPages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Query().Get("page") {
		case "", "1":
			_ = json.NewEncoder(w).Encode([]githubRelease{
				{TagName: "main-old0001", PublishedAt: "2026-01-01T00:00:00Z", HTMLURL: "https://example.com/old"},
			})
		case "2":
			_ = json.NewEncoder(w).Encode([]githubRelease{
				{TagName: "main-new0002", PublishedAt: "2026-06-01T00:00:00Z", HTMLURL: "https://example.com/new"},
			})
		default:
			w.Write([]byte(`[]`))
		}
	}))
	t.Cleanup(srv.Close)
	overrideReleasesAPI(t, srv.URL)

	c := NewFirmwareChecker()
	stable := 0
	rel, err := c.GetLatestFirmwareRelease(context.Background(), &stable)
	if err != nil {
		t.Fatalf("GetLatestFirmwareRelease: %v", err)
	}
	if rel == nil || rel.Hash != "new0002" {
		t.Fatalf("expected the later-published release from page 2, got %+v", rel)
	}
}

func TestFirmwareChecker_NoMatchReturnsNilNotError(t *testing.T) {
	srv := fakeGitHubReleases(t, []githubRelease{
		{TagName: "other-ccc3333", PublishedAt: "2026-01-01T00:00:00Z", HTMLURL: "https://example.com/x"},
	})
	overrideReleasesAPI(t, srv.URL)

	c := NewFirmwareChecker()
	stable := 0
	rel, err := c.GetLatestFirmwareRelease(context.Background(), &stable)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rel != nil {
		t.Fatalf("expected nil (unknown, not an error) for no matching release, got %+v", rel)
	}
}

// #1042: a clean HTTP success with no matching-prefix release must be
// logged distinctly from the existing GitHub-error path, since a silently
// cached nil was previously indistinguishable in the logs from "genuinely
// up to date".
func TestFirmwareChecker_NoMatchLogsDistinctlyFromError(t *testing.T) {
	srv := fakeGitHubReleases(t, []githubRelease{
		{TagName: "other-ccc3333", PublishedAt: "2026-01-01T00:00:00Z", HTMLURL: "https://example.com/x"},
	})
	overrideReleasesAPI(t, srv.URL)

	var buf bytes.Buffer
	origLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(origLogger) })

	c := NewFirmwareChecker()
	stable := 0
	rel, err := c.GetLatestFirmwareRelease(context.Background(), &stable)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rel != nil {
		t.Fatalf("expected nil release for no matching tag, got %+v", rel)
	}

	logged := buf.String()
	if !strings.Contains(logged, "no release matched channel tag prefix") {
		t.Fatalf("expected a log line about no matching release, got: %s", logged)
	}
	if strings.Contains(logged, "latest-release lookup failed") {
		t.Fatalf("no-match path must not log the GitHub-error message, got: %s", logged)
	}
}

func TestFirmwareChecker_CachesPerChannel(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		page := r.URL.Query().Get("page")
		w.Header().Set("Content-Type", "application/json")
		if page != "" && page != "1" {
			w.Write([]byte(`[]`))
			return
		}
		_ = json.NewEncoder(w).Encode([]githubRelease{{TagName: "main-abc0000", PublishedAt: "2026-01-01T00:00:00Z", HTMLURL: "https://example.com"}})
	}))
	t.Cleanup(srv.Close)
	overrideReleasesAPI(t, srv.URL)

	c := NewFirmwareChecker()
	stable := 0
	if _, err := c.GetLatestFirmwareRelease(context.Background(), &stable); err != nil {
		t.Fatalf("first call: %v", err)
	}
	callsAfterFirst := calls
	if _, err := c.GetLatestFirmwareRelease(context.Background(), &stable); err != nil {
		t.Fatalf("second call: %v", err)
	}
	if calls != callsAfterFirst {
		t.Fatalf("expected no additional HTTP calls on the second GetLatestFirmwareRelease call (cached), went from %d to %d", callsAfterFirst, calls)
	}
}

// #1037: a GitHub rate-limit / non-2xx must surface as an error (so the
// caller can fall back to its last known result) and must NOT be cached as
// a "no matching release" nil. #1616: within firmwareFailureBackoff the
// failure is remembered — a second call still errors, without asking
// GitHub again — and once the backoff has passed the next call retries.
func TestFirmwareChecker_RateLimitIsAnErrorNotCached(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"message":"API rate limit exceeded"}`))
	}))
	t.Cleanup(srv.Close)
	overrideReleasesAPI(t, srv.URL)

	c := NewFirmwareChecker()
	stable := 0
	if _, err := c.GetLatestFirmwareRelease(context.Background(), &stable); err == nil {
		t.Fatal("expected an error on HTTP 403, got nil")
	}
	// Never a cached nil: a second call inside the backoff still errors,
	// and does not hit GitHub again.
	if rel, err := c.GetLatestFirmwareRelease(context.Background(), &stable); err == nil {
		t.Fatalf("expected the second call to still report the failure, got rel=%+v", rel)
	}
	if calls != 1 {
		t.Fatalf("expected 1 HTTP call inside the failure backoff, got %d", calls)
	}
	// Once the backoff has passed, the next call retries the network.
	c.mu.Lock()
	f := c.failures[0]
	f.at = time.Now().Add(-2 * firmwareFailureBackoff)
	c.failures[0] = f
	c.mu.Unlock()
	if _, err := c.GetLatestFirmwareRelease(context.Background(), &stable); err == nil {
		t.Fatal("expected the retry to report the still-failing GitHub")
	}
	if calls != 2 {
		t.Fatalf("expected 2 HTTP calls after the backoff passed, got %d", calls)
	}
}

// TestFirmwareChecker_ConcurrentCallsShareOneFetch (#1616): callers that
// arrive while a channel's lookup is in flight wait for it instead of
// starting their own.
func TestFirmwareChecker_ConcurrentCallsShareOneFetch(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		<-release
		page := r.URL.Query().Get("page")
		w.Header().Set("Content-Type", "application/json")
		if page != "" && page != "1" {
			w.Write([]byte(`[]`))
			return
		}
		_ = json.NewEncoder(w).Encode([]githubRelease{{TagName: "main-abc0000", PublishedAt: "2026-01-01T00:00:00Z", HTMLURL: "https://example.com"}})
	}))
	t.Cleanup(srv.Close)
	overrideReleasesAPI(t, srv.URL)

	c := NewFirmwareChecker()
	stable := 0
	var wg sync.WaitGroup
	results := make([]*FirmwareRelease, 8)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rel, err := c.GetLatestFirmwareRelease(context.Background(), &stable)
			if err != nil {
				t.Errorf("call %d: %v", i, err)
			}
			results[i] = rel
		}()
	}
	// Let every goroutine reach the in-flight lookup before GitHub answers.
	for calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	// One lookup = page 1 plus the empty page 2 that ends the scan.
	if got := calls.Load(); got != 2 {
		t.Fatalf("expected one shared lookup (2 page requests), got %d requests", got)
	}
	for i, rel := range results {
		if rel == nil || rel.Hash != "abc0000" {
			t.Errorf("call %d: rel = %+v, want hash abc0000", i, rel)
		}
	}
}

// #1037: once a good result is known, a later transient GitHub failure
// serves the stale result instead of propagating the error.
func TestFirmwareChecker_ServesStaleResultOnTransientFailure(t *testing.T) {
	fail := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]githubRelease{
			{TagName: "main-good111", PublishedAt: "2026-02-01T00:00:00Z", HTMLURL: "https://example.com/good"},
		})
	}))
	t.Cleanup(srv.Close)
	overrideReleasesAPI(t, srv.URL)

	c := NewFirmwareChecker()
	stable := 0
	rel, err := c.GetLatestFirmwareRelease(context.Background(), &stable)
	if err != nil || rel == nil || rel.Hash != "good111" {
		t.Fatalf("warm-up fetch: rel=%+v err=%v", rel, err)
	}

	// Age the cache entry past its TTL and make GitHub start failing.
	c.mu.Lock()
	e := c.cache[0]
	e.fetchedAt = time.Now().Add(-2 * firmwareCacheTTL)
	c.cache[0] = e
	c.mu.Unlock()
	fail = true

	rel, err = c.GetLatestFirmwareRelease(context.Background(), &stable)
	if err != nil {
		t.Fatalf("expected stale result to be served, got error: %v", err)
	}
	if rel == nil || rel.Hash != "good111" {
		t.Fatalf("expected stale hash good111, got %+v", rel)
	}
}

func TestParseReleaseChannel(t *testing.T) {
	if got := ParseReleaseChannel(float64(2)); got == nil || *got != 2 {
		t.Fatalf("ParseReleaseChannel(2.0) = %v, want 2", got)
	}
	if got := ParseReleaseChannel("1"); got == nil || *got != 1 {
		t.Fatalf("ParseReleaseChannel(\"1\") = %v, want 1", got)
	}
	if got := ParseReleaseChannel(nil); got != nil {
		t.Fatalf("ParseReleaseChannel(nil) = %v, want nil", got)
	}
	if got := ParseReleaseChannel("not-a-number"); got != nil {
		t.Fatalf("ParseReleaseChannel(garbage) = %v, want nil", got)
	}
}

// overrideReleasesAPI points releasesAPI at a local fake GitHub-releases
// server for the duration of a test.
func overrideReleasesAPI(t *testing.T, url string) {
	t.Helper()
	orig := releasesAPI
	releasesAPI = url
	t.Cleanup(func() { releasesAPI = orig })
}
