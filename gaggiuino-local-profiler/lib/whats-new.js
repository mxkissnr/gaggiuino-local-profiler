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
    { version: '2.33.2', date: '2026-08-11', highlights: [
        'Sidebar shot counter cleaned up: removed the redundant "(N)" text next to the flap-board counter and moved the counter in front of the "Shots" label.',
    ] },
    { version: '2.33.1', date: '2026-08-11', highlights: [
        'Fixed theme/accent colour swatches (Settings → Machines → Farbe, and the app-wide colour scheme picker) showing a square edge instead of a fully filled circle on some browsers.',
        'Fixed shot-import progress showing the total shrinking mid-backfill during a large sync.',
    ] },
    { version: '2.33.0', date: '2026-08-11', highlights: [
        'Added standalone Docker install support for Home Assistant setups without a Supervisor (HA Container, HA Core, Unraid, TrueNAS SCALE, …): a ready-made docker-compose.standalone.yml, plus env-var config and an optional HA long-lived-token integration.',
    ] },
    { version: '2.32.0', date: '2026-08-11', highlights: [
        'Heads up if you manage the machine host/switch entity via the add-on\'s Configuration tab: those fields are removed there. Your existing value carries over automatically, but from now on the default machine is configured entirely under Settings → Machines instead.',
        'Added a guided first-run setup wizard: a fresh install with no machines configured now gets a welcome -> connect machine -> done walkthrough, with a one-click demo-data option and a "Restart setup tour" control in Settings → Machines.',
        'The Live tab and the sidebar\'s shot counter now update in real time instead of only polling every few seconds, falling back automatically if a live connection can\'t be established.',
        'Settings → Machines: "Test connection" now saves the machine automatically first, you can change the default machine or delete any machine, and the host field can be left empty to save a machine as "not configured yet".',
        'Fixed several shot-sync sticking points (a stuck backfill, an out-of-range shot id) and the Live tab\'s flow reading always showing 0.',
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
