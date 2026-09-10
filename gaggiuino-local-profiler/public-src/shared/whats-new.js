// In-app "What's New" changelog (#610). Hand-maintained, English-only
// subset of CHANGELOG.md's most recent releases — CHANGELOG.md stays the
// full/source-of-truth history; this is a curated highlight list meant to
// be readable inside the app itself, not generated from CHANGELOG.md's
// Markdown. Add a new entry here by hand whenever a release ships (see
// CLAUDE.md's Commits section). Pure data, no DOM deps.
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
    { version: '3.0.1', date: '2026-09-10', highlights: [
        'Fixed: demo mode\'s shot detail (curve chart, P·Q view and average pressure/temperature) is no longer blank.',
    ] },
    { version: '3.0.0', date: '2026-09-09', highlights: [
        'The add-on now runs on a Go backend instead of Node.js, with no visible change in behaviour. Back up Home Assistant before updating.',
        'armv7 (32-bit ARM) is no longer deprecated — the Go backend builds a static armv7 image again.',
        'First-class GaggiMate support: foundational integration across the stack plus a full Standard/Pro profile editor, saved straight to the machine. Thanks to @Paul-Lukas.',
    ] },
    { version: '2.36.0', date: '2026-08-24', highlights: [
        'The Live tab now shows current temperature/target, pressure and water level even while idle, instead of just "Ready to brew".',
        'Steam and flush mode now get the same live treatment as brewing: a timer, live readouts, a badge and the animated machine icon.',
        'Fixed: the power toggle is now reachable on mobile from the topbar, not just the (mobile-hidden) sidebar.',
        'Fixed: exhausted beans (zero stock) no longer show up in the shot-annotation bean picker.',
        'Fixed: the Live tab no longer keeps showing stale readings after the machine loses power or drops off the network.',
        'Fixed: the Live tab\'s shot timer no longer keeps counting after a BREW_AUTO shot has actually finished.',
    ] },
    { version: '2.35.0', date: '2026-08-19', highlights: [
        'Fixed the armv7 add-on image build, restored by reverting the Docker base image to node:22-slim.',
        'Switched dependency updates from Dependabot to Renovate.',
    ] },
    { version: '2.34.0', date: '2026-08-16', highlights: [
        '"Instrument" redesign: a cooler graphite look throughout the app, drawn icons in place of emoji, and a calmer, less boxy shot view with a guided metric line and a plain-text verdict.',
        'Added the achievement stamp card: a browsable catalogue of 54 badges across 7 categories, unlocked automatically as you brew.',
        'The machine icon (Settings, topbar, Live view) now draws the right body for your machine type, and toggle buttons/the sidebar shot counter got a lighter, less mechanical look.',
    ] },
    { version: '2.33.3', date: '2026-08-11', highlights: [
        'Live view updates faster on a fresh sensor reading: a WebSocket or MQTT sample now pushes to the Live tab instantly instead of waiting for the next 1-second poll.',
    ] },
    { version: '2.33.2', date: '2026-08-11', highlights: [
        'Sidebar shot counter cleaned up: removed the redundant "(N)" text next to the flap-board counter and moved the counter in front of the "Shots" label.',
    ] },
    { version: '2.33.1', date: '2026-08-11', highlights: [
        'Fixed theme/accent colour swatches (Settings → Machines → Farbe, and the app-wide colour scheme picker) showing a square edge instead of a fully filled circle on some browsers.',
        'Fixed shot-import progress showing the total shrinking mid-backfill during a large sync.',
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

export { WHATS_NEW_ENTRIES, MAX_ENTRIES, getWhatsNewEntries };
