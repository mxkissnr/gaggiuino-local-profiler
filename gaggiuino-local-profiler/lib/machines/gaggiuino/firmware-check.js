// Firmware update-availability check (#620, Phase 1) — queries the actual
// firmware source's GitHub releases (Zer0-bit/gaggiuino, not the docs-only
// gaggiuino/GAGGIUINO org) for the latest release matching the machine's
// configured release channel, so "is an update even available" can be
// answered before triggering routes/machine-control.js's existing
// POST /api/machine/firmware/update (#597/#599) OTA trigger.
//
// The machine's own REST API has no "latest available version" endpoint of
// its own — GET /api/settings/versions only reports the *installed*
// coreVersion/frontVersion/staticVersion, each a short git commit hash
// (e.g. "7889b7d"), not a semver. This module is GLP's own separate check
// against the firmware's public release feed.
'use strict';
const axios = require('axios');

const RELEASES_API = 'https://api.github.com/repos/Zer0-bit/gaggiuino/releases';

// Unauthenticated GitHub API calls are rate-limited to 60 req/hr — this must
// never be queried per-poll. One hour is a sensible interval for a value
// that only changes on a firmware release, cached per release channel so a
// machine on 'test' and a machine on 'stable' don't share a stale answer.
const CACHE_TTL_MS = 60 * 60 * 1000;

// releaseChannel is system.releaseChannel (rest-api.md: 0=stable, 1=test,
// 2=debug), returned by adapter.getSettings(machine, 'system'). Firmware
// releases use commit-hash tags, not semver — "main-<hash>" and
// "dev-<hash>" (e.g. "main-7889b7d") — with no prerelease-flag distinction
// in GitHub's own release metadata, so channel is encoded entirely in this
// tag prefix.
//
// ASSUMPTION, documented per #620's explicit call-out rather than silently
// treated as verified: stable and test both draw from the `main-*` line,
// debug draws from the rougher `dev-*` line. This has NOT been confirmed
// against the OTA-trigger firmware source (what POST /api/firmware/update-
// all actually installs) or a firmware maintainer. If wrong, this endpoint
// could report "no update available" when the firmware would actually
// install a different-channel build than what was compared, or the reverse.
// Revisit once confirmed — see #620.
const CHANNEL_TAG_PREFIX = { 0: 'main-', 1: 'main-', 2: 'dev-' };
const DEFAULT_CHANNEL = 0;

// Keyed by channel (not a single slot) so a multi-machine install with
// machines on different releaseChannels doesn't evict each other's cached
// answer on every alternating poll.
const cache = new Map(); // channel -> { fetchedAt, result }

// #673: fetchLatestRelease() used to only look at the response's first page
// (GitHub's default page size, ~30 releases). If one channel is published
// much more often than the other -- or there's simply a dry spell on one --
// the first page could be entirely the *other* prefix, making a real
// release look like "unknown" instead of being found. GitHub returns
// releases newest-first, so scanning pages in order and stopping at the
// first page that has a matching-prefix release still finds the true
// latest one -- no need to keep paging past a match. Bounded to
// MAX_PAGES so a channel with no matching release at all (or a GitHub API
// change) can't spin through unbounded requests against the existing
// 60/hr unauthenticated budget the CACHE_TTL_MS comment above already
// accounts for.
const MAX_PAGES = 5;

async function fetchLatestRelease(prefix) {
    for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await axios.get(RELEASES_API, {
            timeout: 5000,
            params: { page },
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'gaggiuino-local-profiler' },
        });
        const releases = Array.isArray(r.data) ? r.data : [];
        if (releases.length === 0) break; // no more pages

        const match = releases
            .filter(rel => typeof rel.tag_name === 'string' && rel.tag_name.startsWith(prefix))
            .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0];
        if (match) return match;
    }
    return null;
}

// Returns { hash, publishedAt, releaseUrl } for the latest release matching
// `channel`, or null if none was found (e.g. GitHub API failure, or no
// release under that prefix — surfaced to the caller as "unknown", not as
// "no update available", since the two are not the same thing). Result is
// cached for CACHE_TTL_MS per channel value.
async function getLatestFirmwareRelease(channel) {
    const ch      = channel != null && CHANNEL_TAG_PREFIX[channel] ? channel : DEFAULT_CHANNEL;
    const prefix  = CHANNEL_TAG_PREFIX[ch];
    const cached  = cache.get(ch);

    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
        return cached.result;
    }

    const release = await fetchLatestRelease(prefix);
    const result = release ? {
        hash:        release.tag_name.slice(prefix.length),
        publishedAt: release.published_at,
        releaseUrl:  release.html_url,
    } : null;
    cache.set(ch, { fetchedAt: Date.now(), result });
    return result;
}

function _resetCacheForTests() { cache.clear(); }

module.exports = { getLatestFirmwareRelease, CHANNEL_TAG_PREFIX, _resetCacheForTests };
