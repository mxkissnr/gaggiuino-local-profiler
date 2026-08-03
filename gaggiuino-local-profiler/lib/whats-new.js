// In-app "What's New" changelog (#610). Hand-maintained, English-only
// subset of CHANGELOG.md's most recent releases — CHANGELOG.md stays the
// full/source-of-truth history; this is a curated highlight list meant to
// be readable inside the app itself, not generated from CHANGELOG.md's
// Markdown. Add a new entry here by hand whenever a release ships (see
// CLAUDE.md's Commits section). Same isomorphic sharing pattern as
// lib/machines/theme-presets.js (see vite.config.js's commonjsOptions):
// pure data, no Node/DOM deps, importable from both the backend and the
// ESM frontend build.
//
// Highlight text is deliberately English-only, not run through i18n like
// the rest of the UI — historical release notes aren't practical to
// machine-translate, same reasoning as shot annotations/tasting notes
// staying user-authored/English-source. Only the Settings card's own
// title/description are translated.
//
// Keep this list newest-first; getWhatsNewEntries() below re-sorts and
// caps it defensively so an out-of-order manual edit can't silently show
// entries in the wrong order or let the list grow unbounded.
const WHATS_NEW_ENTRIES = [
    { version: '2.28.0', date: '2026-08-04', highlights: [
        'Added an in-app "What\'s New" changelog to Settings — this list.',
    ] },
    { version: '2.27.4', date: '2026-08-04', highlights: [
        'Fixed a stale WebSocket session leak when a machine is removed or re-hosted.',
        'Fixed component-test commands (pump/valve/LED) always timing out despite succeeding.',
    ] },
    { version: '2.27.3', date: '2026-08-04', highlights: [
        'Live temperature/pressure/weight readings now actually update in real time over WebSocket/MQTT, instead of lagging on the 1s REST poll.',
    ] },
    { version: '2.27.2', date: '2026-08-04', highlights: [
        'Preheat-ready and low-stock notification toggles are now reachable in Settings even when Orders is disabled.',
    ] },
    { version: '2.27.1', date: '2026-08-03', highlights: [
        'Added logging so the active live-data transport (WebSocket/MQTT) and its connection state are visible from the logs.',
    ] },
    { version: '2.27.0', date: '2026-08-03', highlights: [
        'Added MQTT as an alternative live-data transport (Settings → "Live connection"), with Supervisor broker auto-discovery and a one-click "apply to machine" button.',
    ] },
    { version: '2.26.0', date: '2026-08-03', highlights: [
        'Added per-notification-type toggles (preheat-ready, low-stock, shop open/close, new order, order status) in Settings.',
    ] },
    { version: '2.25.0', date: '2026-08-03', highlights: [
        "The default machine's colour theme now drives the whole app's accent colour, not just its icon.",
    ] },
];

const MAX_ENTRIES = 8;

function compareVersionsDesc(a, b) {
    const pa = a.version.split('.').map(Number);
    const pb = b.version.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pb[i] || 0) - (pa[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

// Newest-first, capped at MAX_ENTRIES — callers never need to sort/slice
// themselves.
function getWhatsNewEntries() {
    return [...WHATS_NEW_ENTRIES].sort(compareVersionsDesc).slice(0, MAX_ENTRIES);
}

module.exports = { WHATS_NEW_ENTRIES, MAX_ENTRIES, getWhatsNewEntries };
