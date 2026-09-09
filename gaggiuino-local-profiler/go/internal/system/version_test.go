package system

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
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
