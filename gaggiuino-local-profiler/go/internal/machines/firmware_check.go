package machines

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// This file ports lib/machines/gaggiuino/firmware-check.js (#620 Phase 1):
// queries Zer0-bit/gaggiuino's GitHub releases for the latest release
// matching a machine's configured release channel, so "is an update even
// available" can be answered before triggering the OTA update endpoint.

// releasesAPI is a var (not a const) so tests can point it at a local fake
// GitHub-releases server instead of hitting the real network — see
// firmware_check_test.go.
var releasesAPI = "https://api.github.com/repos/Zer0-bit/gaggiuino/releases"

// firmwareHTTPClient is deliberately its own *http.Client, distinct from
// http.go's httpClient: that one's Transport pins outbound connections to
// an SSRF-guard-resolved LAN address (#987, guardedDialContext) — the
// right behavior for a machine's own user-configured host, wrong for this
// file's fixed, hardcoded api.github.com endpoint (no attacker-controlled
// host ever reaches it, and firmware_check_test.go's fake GitHub server
// intentionally binds to 127.0.0.1, which machineHostGuardResolved would
// reject).
var firmwareHTTPClient = &http.Client{}

// firmwareCacheTTL ports CACHE_TTL_MS — unauthenticated GitHub API calls
// are rate-limited to 60 req/hr, so this must never be queried per-poll.
const firmwareCacheTTL = time.Hour

// firmwareMaxPages ports MAX_PAGES (#673).
const firmwareMaxPages = 5

// channelTagPrefix ports CHANNEL_TAG_PREFIX. ASSUMPTION, carried forward
// unverified from the Node original (#620): stable(0)/test(1) both draw
// from main-*, debug(2) draws from dev-*. See firmware-check.js's own
// header comment for the full caveat — not re-verified in this port.
var channelTagPrefix = map[int]string{0: "main-", 1: "main-", 2: "dev-"}

const defaultFirmwareChannel = 0

// FirmwareRelease ports getLatestFirmwareRelease()'s {hash, publishedAt,
// releaseUrl} result shape.
type FirmwareRelease struct {
	Hash        string `json:"hash"`
	PublishedAt string `json:"publishedAt"`
	ReleaseURL  string `json:"releaseUrl"`
}

type firmwareCacheEntry struct {
	fetchedAt time.Time
	result    *FirmwareRelease
}

// FirmwareChecker ports the module-level `cache` Map + getLatestFirmwareRelease
// function as a struct, same reasoning as gaggiuinoLiveClient (Go has no
// module-singleton equivalent to lean on).
type FirmwareChecker struct {
	mu    sync.Mutex
	cache map[int]firmwareCacheEntry
}

func NewFirmwareChecker() *FirmwareChecker {
	return &FirmwareChecker{cache: make(map[int]firmwareCacheEntry)}
}

type githubRelease struct {
	TagName     string `json:"tag_name"`
	PublishedAt string `json:"published_at"`
	HTMLURL     string `json:"html_url"`
}

// fetchLatestRelease ports fetchLatestRelease(prefix) (#673): scans pages
// newest-first, stopping at the first page containing a matching-prefix
// release, bounded to firmwareMaxPages.
func fetchLatestRelease(ctx context.Context, prefix string) (*githubRelease, error) {
	for page := 1; page <= firmwareMaxPages; page++ {
		url := fmt.Sprintf("%s?page=%d", releasesAPI, page)
		reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
		if err != nil {
			cancel()
			return nil, err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("User-Agent", "gaggiuino-local-profiler")
		resp, err := firmwareHTTPClient.Do(req)
		cancel()
		if err != nil {
			return nil, err
		}
		var releases []githubRelease
		err = json.NewDecoder(resp.Body).Decode(&releases)
		resp.Body.Close()
		if err != nil || len(releases) == 0 {
			break // no more pages / malformed page — treat as "no more results"
		}

		var best *githubRelease
		var bestPublished time.Time
		for i := range releases {
			rel := releases[i]
			if !strings.HasPrefix(rel.TagName, prefix) {
				continue
			}
			published, err := time.Parse(time.RFC3339, rel.PublishedAt)
			if err != nil {
				continue
			}
			if best == nil || published.After(bestPublished) {
				r := rel
				best = &r
				bestPublished = published
			}
		}
		if best != nil {
			return best, nil
		}
	}
	return nil, nil
}

// GetLatestFirmwareRelease ports getLatestFirmwareRelease(channel):
// returns nil (not an error) if no matching release was found — that's
// "unknown", not "no update available", same distinction the Node
// original's comment draws. Cached per channel for firmwareCacheTTL.
func (c *FirmwareChecker) GetLatestFirmwareRelease(ctx context.Context, channel *int) (*FirmwareRelease, error) {
	ch := defaultFirmwareChannel
	if channel != nil {
		if _, ok := channelTagPrefix[*channel]; ok {
			ch = *channel
		}
	}
	prefix := channelTagPrefix[ch]

	c.mu.Lock()
	entry, ok := c.cache[ch]
	c.mu.Unlock()
	if ok && time.Since(entry.fetchedAt) < firmwareCacheTTL {
		return entry.result, nil
	}

	release, err := fetchLatestRelease(ctx, prefix)
	if err != nil {
		return nil, err
	}
	var result *FirmwareRelease
	if release != nil {
		result = &FirmwareRelease{
			Hash:        strings.TrimPrefix(release.TagName, prefix),
			PublishedAt: release.PublishedAt,
			ReleaseURL:  release.HTMLURL,
		}
	}
	c.mu.Lock()
	c.cache[ch] = firmwareCacheEntry{fetchedAt: time.Now(), result: result}
	c.mu.Unlock()
	return result, nil
}

// ParseReleaseChannel converts the loosely-typed value getSettings(machine,
// "system").releaseChannel decodes to (a JSON number in practice) into the
// *int GetLatestFirmwareRelease expects — nil if absent/unrecognized,
// which resolves to defaultFirmwareChannel same as Node's `channel != null
// && CHANNEL_TAG_PREFIX[channel] ? channel : DEFAULT_CHANNEL`.
func ParseReleaseChannel(v any) *int {
	switch t := v.(type) {
	case float64:
		n := int(t)
		return &n
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(t))
		if err != nil {
			return nil
		}
		return &n
	default:
		return nil
	}
}

// resetCacheForTests clears the cache — test-only helper, mirrors
// firmware-check.js's own _resetCacheForTests.
func (c *FirmwareChecker) resetCacheForTests() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cache = make(map[int]firmwareCacheEntry)
}
