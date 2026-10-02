package system

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// This file implements the GitHub-release version check for GET /api/version.
// GLP_VERSION is shared across the whole repo (the release process isn't
// per-binary). Not used: the achievements up_to_date badge's cached-value path
// (achievements isn't implemented yet — see go/README.md's domain list;
// nothing in this Go binary calls checkForUpdate() except this endpoint
// itself, which is why the cache exists).
const versionCacheTTL = time.Hour

// glpVersion is the GLP version this binary reports from GET /api/version.
// config.yaml's `version:` is canonical; this const must match it and is
// bumped alongside it at release time (CLAUDE.md's Versioning section).
// Enforced by test/version-sync.test.js and scripts/release-check.mjs.
// Duplicated rather than imported — no shared "constants" package exists in
// this Go port; every domain package that needs a version-shaped value
// defines its own, see internal/db's schema version handling.
const glpVersion = "3.3.0"

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
	mu       sync.Mutex
	cache    *string
	cacheAt  time.Time
	http     *http.Client
	apiURL   string // overridable in tests
	devBuild bool   // GLP_DEV_BUILD set — see #704's dev-channel guard below
}

func newVersionChecker() *versionChecker {
	return &versionChecker{
		http:     &http.Client{Timeout: 8 * time.Second},
		apiURL:   "https://api.github.com/repos/mxkissnr/gaggiuino-local-profiler/releases/latest",
		devBuild: os.Getenv("GLP_DEV_BUILD") != "",
	}
}

// CheckForUpdate fetches the latest GitHub release tag at most once per
// versionCacheTTL, then returns result()'s shape either way (a fetch failure
// just means "keep whatever's cached, possibly nil").
func (v *versionChecker) CheckForUpdate(ctx context.Context) VersionInfo {
	v.mu.Lock()
	stale := v.cache == nil || time.Since(v.cacheAt) > versionCacheTTL
	v.mu.Unlock()

	if stale {
		if tag, ok := v.fetchLatestTag(ctx); ok {
			v.mu.Lock()
			v.cache = &tag
			v.cacheAt = time.Now()
			v.mu.Unlock()
		}
	}
	return v.result()
}

func (v *versionChecker) fetchLatestTag(ctx context.Context) (string, bool) {
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
