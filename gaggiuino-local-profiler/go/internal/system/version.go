package system

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sync/singleflight"
)

// This file implements the GitHub-release version check for GET /api/version.
// Its result is cached so repeated GET /api/version calls do not hit GitHub
// each time.
const versionCacheTTL = time.Hour

// versionFailureBackoff bounds how long a failed release lookup is
// remembered before GitHub is asked again (#1616). Without it every
// GET /api/version during a GitHub outage or rate limit started a fresh
// request of up to 8 s; the response is the same either way (whatever is
// cached, possibly nothing).
const versionFailureBackoff = time.Minute

// glpVersion is the GLP version this binary reports from GET /api/version.
// config.yaml's `version:` is canonical; this const must match it and is
// bumped alongside it at release time (CLAUDE.md's Versioning section).
// Enforced by test/version-sync.test.ts and scripts/release-check.mts.
const glpVersion = "3.6.0"

// Version returns the GLP version this binary reports from GET /api/version,
// for callers that need the same value (the MCP server identity, #1196).
func Version() string {
	return glpVersion
}

const releaseURL = "https://github.com/mxkissnr/gaggiuino-local-profiler/releases/latest"

// VersionInfo is GET /api/version's response shape exactly —
// current/latest/update_available/release_url, snake_case on the wire,
// distinct from checkForUpdate()'s own camelCase internal return shape.
type VersionInfo struct {
	Current         string  `json:"current"`
	Latest          *string `json:"latest"`
	UpdateAvailable bool    `json:"update_available"`
	ReleaseURL      string  `json:"release_url"`
}

// versionChecker holds the module-level cache as a struct so tests can
// construct one pointed at a fake GitHub API instead of relying on
// process-wide state.
type versionChecker struct {
	mu      sync.Mutex
	cache   *string
	cacheAt time.Time
	// failedAt is when the last lookup failed (zero after a success).
	failedAt time.Time
	// flight collapses concurrent lookups into a single GitHub request
	// (#1616).
	flight   singleflight.Group
	http     *http.Client
	apiURL   string // overridable in tests
	devBuild bool   // GLP_DEV_BUILD set — see #704's dev-channel guard below
}

func newVersionChecker() *versionChecker {
	// A test binary must not dial GitHub: every Go test that builds the system
	// handlers (GET /api/version, and the server package's full-app tests)
	// would otherwise make a real HTTPS request. An empty apiURL makes
	// fetchLatestTag a no-op, so the "keep whatever's cached" path applies.
	// Tests that need a fetch point apiURL at an httptest server themselves.
	apiURL := "https://api.github.com/repos/mxkissnr/gaggiuino-local-profiler/releases/latest"
	if testing.Testing() {
		apiURL = ""
	}
	return &versionChecker{
		http:     &http.Client{Timeout: 8 * time.Second},
		apiURL:   apiURL,
		devBuild: os.Getenv("GLP_DEV_BUILD") != "",
	}
}

// CheckForUpdate fetches the latest GitHub release tag at most once per
// versionCacheTTL, then returns result()'s shape either way (a fetch failure
// just means "keep whatever's cached, possibly nil").
//
// Concurrent stale callers share one fetch, which runs detached from any
// one caller's cancellation (the client timeout still bounds it), and a
// failed fetch is not retried for versionFailureBackoff (#1616).
func (v *versionChecker) CheckForUpdate(ctx context.Context) VersionInfo {
	v.mu.Lock()
	stale := v.cache == nil || time.Since(v.cacheAt) > versionCacheTTL
	backingOff := !v.failedAt.IsZero() && time.Since(v.failedAt) < versionFailureBackoff
	v.mu.Unlock()

	if stale && !backingOff {
		fetchCtx := context.WithoutCancel(ctx)
		_, _, _ = v.flight.Do("latest", func() (any, error) {
			tag, ok := v.fetchLatestTag(fetchCtx)
			v.mu.Lock()
			defer v.mu.Unlock()
			if ok {
				v.cache = &tag
				v.cacheAt = time.Now()
				v.failedAt = time.Time{}
			} else {
				v.failedAt = time.Now()
			}
			return nil, nil
		})
	}
	return v.result()
}

func (v *versionChecker) fetchLatestTag(ctx context.Context) (string, bool) {
	// No apiURL means "don't fetch at all" (a test binary, see
	// newVersionChecker): report not-ok without issuing any request.
	if v.apiURL == "" {
		return "", false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.apiURL, nil)
	if err != nil {
		return "", false
	}
	req.Header.Set("User-Agent", "GLP-Server")
	resp, err := v.http.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false
	}
	var data struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", false
	}
	tag := strings.TrimPrefix(data.TagName, "v")
	if tag == "" {
		return "", false
	}
	return tag, true
}

// CachedVersion returns the last-known GitHub-release check result with NO
// fetch of its own — internal/achievements' up_to_date badge reads this.
// Returns (nil, false) until a real GET /api/version request has filled the
// cache, which the badge treats as "nothing known yet". Shares this Handlers'
// own versionChecker instance, so the same cache GET /api/version fills is the
// one read here.
func (h *Handlers) CachedVersion() (latest *string, updateAvailable bool) {
	r := h.vc.result()
	return r.Latest, r.UpdateAvailable
}

// result applies #704's dev-channel guard — GLP_VERSION is frozen at the
// last real release on the dev branch, so a dev build is permanently
// "behind" by design; comparing against it would wrongly tell dev-channel
// users to update via the stable Add-on Store.
func (v *versionChecker) result() VersionInfo {
	v.mu.Lock()
	latest := v.cache
	v.mu.Unlock()
	updateAvailable := !v.devBuild && latest != nil && *latest != glpVersion
	return VersionInfo{Current: glpVersion, Latest: latest, UpdateAvailable: updateAvailable, ReleaseURL: releaseURL}
}
