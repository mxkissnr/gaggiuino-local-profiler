package machines

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestFirmwareChecker_CachesPerChannel(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]githubRelease{{TagName: "main-abc0000", PublishedAt: "2026-01-01T00:00:00Z", HTMLURL: "https://example.com"}})
	}))
	t.Cleanup(srv.Close)
	overrideReleasesAPI(t, srv.URL)

	c := NewFirmwareChecker()
	stable := 0
	if _, err := c.GetLatestFirmwareRelease(context.Background(), &stable); err != nil {
		t.Fatalf("first call: %v", err)
	}
	if _, err := c.GetLatestFirmwareRelease(context.Background(), &stable); err != nil {
		t.Fatalf("second call: %v", err)
	}
	if calls != 1 {
		t.Fatalf("expected 1 HTTP call across 2 GetLatestFirmwareRelease calls (cached), got %d", calls)
	}
}

// #1037: a GitHub rate-limit / non-2xx must surface as an error (so the
// caller can fall back to its last known result) and must NOT be cached as
// a "no matching release" nil.
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
	// Not cached: a second call retries the network rather than returning a
	// cached nil.
	if _, err := c.GetLatestFirmwareRelease(context.Background(), &stable); err == nil {
		t.Fatal("expected the second call to retry (not serve a cached failure)")
	}
	if calls != 2 {
		t.Fatalf("expected 2 HTTP calls (failure not cached), got %d", calls)
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
