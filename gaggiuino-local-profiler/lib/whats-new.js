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
    { version: '2.32.0', date: '2026-08-10', highlights: [
        'Machine setup\'s "Test connection" button now saves first automatically, instead of requiring the machine to already be saved.',
        'New machines show an import progress indicator for their initial shot sync.',
        'Saving any machine now triggers a catch-up shot sync for it, not just default-machine host changes.',
    ] },
    { version: '2.31.0', date: '2026-08-07', highlights: [
        'Added optional per-install shot-logging defaults (Settings → "Shot logging defaults") that auto-prefill a new shot\'s annotation panel.',
        'Added Basket Stats and Puck Screen Stats groupings to Analytics, alongside the existing Grinder Stats.',
        'Added on-duration to the status footer, edge-swipe to open the mobile drawer, and a persistent dev-build warning banner.',
    ] },
    { version: '2.30.0', date: '2026-08-06', highlights: [
        'Backup export now downloads as a real .zip with selectable sections, an optional encrypted API-token/MQTT-login section, and a dry-run preview before restoring.',
        'Fixed the status dot/Live tab staying green for hours after the machine was switched off — and, on the same fix, staying red for minutes after it was switched back on.',
        'Fixed barcode scanning during bean import being completely broken for every user, blocked by the app\'s own content-security policy.',
    ] },
    { version: '2.29.0', date: '2026-08-04', highlights: [
        'Added Baskets and Puck Screens as new Coffee Library entity types, with photo upload and shot linkage like beans.',
    ] },
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
