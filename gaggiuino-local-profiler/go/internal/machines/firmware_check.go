package machines

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
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

// firmwareNegativeCacheTTL bounds how long a "fetched successfully but no
// release matched this channel's tag prefix" outcome is cached (#1042).
// Unlike a real match, a no-match result is cheap to reverify and, if it
// reflects a transient GitHub listing/ordering quirk rather than a genuine
// absence of matching releases, shouldn't silently persist for the full
// hour. Ten minutes still keeps this well within the 60 req/hr budget (one
// channel retrying at this rate is 6 req/hr) while recovering far sooner
// than firmwareCacheTTL would.
const firmwareNegativeCacheTTL = 10 * time.Minute

// firmwareFetchTimeout bounds a whole GetLatestFirmwareRelease GitHub lookup
// (up to firmwareMaxPages pages). #1037: the lookup runs on a context
// detached from the caller's request deadline — the integration's own 10s
// client timeout, already mostly spent on the two machine-settings
// round-trips, was starving the GitHub call and 502ing the endpoint.
const firmwareFetchTimeout = 20 * time.Second

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

// fetchLatestRelease ports fetchLatestRelease(prefix) (#673): scans up to
// firmwareMaxPages pages and returns the matching-prefix release with the
// latest published_at across ALL of them.
//
// #1042: this used to return as soon as ANY page yielded a matching-prefix
// release, using only that page's own best-by-published_at. That silently
// assumed the GitHub releases list is ordered newest-published-first. Live-
// checking Zer0-bit/gaggiuino's actual /releases response disproved that:
// this repo edits a small, fixed set of release objects in place (retagging
// + republishing) rather than creating new ones, so every release shares
// the same created_at and the list's order has no reliable relationship to
// published_at at all -- e.g. on page 1, "main-d8b6219" (published
// 2026-04-19) sorts ahead of "main-61bd042" (published 2026-09-07, the true
// latest). Stopping at the first page with a match would have returned the
// April release as "latest" while a newer one sat on the same or a later
// page. All current releases fit on one page so this hasn't produced a
// wrong answer yet, but the moment a channel's releases span more than one
// page, the old early-return could silently pick a stale one.
//
// #1042 (actual root cause, found by live-testing against the real GitHub
// API rather than only the fake test server): `cancel()` for a page's
// request context used to fire right after `firmwareHTTPClient.Do(req)`
// returned, before `resp.Body` was read. Against `httptest`'s local,
// same-process fake server the response body is already fully buffered by
// the time `Do` returns, so the early cancel was harmless there and every
// existing test passed -- but against the real, network-latency-bearing
// GitHub API, `resp.Body` is still being streamed off the connection when
// the context gets canceled, and `json.Decode` then reliably fails with
// "context canceled". That decode error was silently folded into the same
// `break` as "no more pages" below, so a live poll NEVER found a match,
// on any channel, 100% of the time -- not a flaky edge case. `cancel` is
// now deferred to function return (bounded: at most firmwareMaxPages
// deferred cancels, freed within the same call) so the context stays live
// for the whole decode.
func fetchLatestRelease(ctx context.Context, prefix string) (*githubRelease, error) {
	var best *githubRelease
	var bestPublished time.Time
	for page := 1; page <= firmwareMaxPages; page++ {
		url := fmt.Sprintf("%s?page=%d", releasesAPI, page)
		reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("User-Agent", "gaggiuino-local-profiler")
		resp, err := firmwareHTTPClient.Do(req)
		if err != nil {
			return nil, err
		}
		// #1037: a non-2xx (esp. 403/429 — the unauthenticated GitHub rate
		// limit is 60 req/hr and the LAN's egress IP is shared between the
		// stable, DEV and Go-Preview apps) returns a JSON *object*, not an
		// array. Treating that as "no more results" silently cached a nil
		// "no release found" for an hour; surface it as an error instead so
		// the caller can serve its last known good result.
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			resp.Body.Close()
			if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
				return nil, fmt.Errorf("github releases API rate-limited (HTTP %d)", resp.StatusCode)
			}
			return nil, fmt.Errorf("github releases API returned HTTP %d", resp.StatusCode)
		}
		var releases []githubRelease
		err = json.NewDecoder(resp.Body).Decode(&releases)
		resp.Body.Close()
		if err != nil || len(releases) == 0 {
			break // no more pages / malformed page — treat as "no more results"
		}

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
	}
	return best, nil
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
	if ok {
		ttl := firmwareCacheTTL
		if entry.result == nil {
			ttl = firmwareNegativeCacheTTL
		}
		if time.Since(entry.fetchedAt) < ttl {
			return entry.result, nil
		}
	}

	// #1037: detach from the caller's request deadline (it's near-exhausted
	// on a slow poll) but keep values so an outer cancel still propagates.
	fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), firmwareFetchTimeout)
	defer cancel()
	release, err := fetchLatestRelease(fetchCtx, prefix)
	if err != nil {
		// Serve the last known good result rather than propagating -- a
		// transient GitHub failure (rate limit, network, timeout) must not
		// make the machine's update status vanish. A failed fetch is never
		// cached as a result. Surface the error only when there's nothing
		// to fall back to.
		if ok && entry.result != nil {
			return entry.result, nil
		}
		return nil, err
	}
	var result *FirmwareRelease
	if release != nil {
		result = &FirmwareRelease{
			Hash:        strings.TrimPrefix(release.TagName, prefix),
			PublishedAt: release.PublishedAt,
			ReleaseURL:  release.HTMLURL,
		}
	} else {
		// #1042: a clean HTTP success with zero matching-prefix tags across
		// firmwareMaxPages pages is indistinguishable from "genuinely up to
		// date" unless logged -- this was silently cached as a good "no
		// update" result for the full TTL with no trace in the logs,
		// distinct from (and easy to confuse with) the GitHub-error slog.Warn
		// in handlers_control.go's firmwareVersion handler.
		slog.Info("firmware check: no release matched channel tag prefix", "channel", ch, "prefix", prefix, "pagesScanned", firmwareMaxPages)
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
