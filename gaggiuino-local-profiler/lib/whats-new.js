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
    { version: '2.35.1', date: '2026-08-10', highlights: [
        'Fixed the previous data-wipe wizard fix (v2.33.3) never actually firing on its first run for any existing browser — it now genuinely reopens the setup wizard after a real data wipe.',
    ] },
    { version: '2.35.0', date: '2026-08-10', highlights: [
        'The dev-only raw database export (Settings → Dev Tools) now has an import counterpart, for GLP DEV builds only — separate from, and no change to, the regular Backup & Restore feature.',
    ] },
    { version: '2.34.0', date: '2026-08-10', highlights: [
        'Settings → Machines can now change the default machine ("Set as default") and delete any machine, including the current default (behind a confirmation) — not just non-default ones.',
    ] },
    { version: '2.33.3', date: '2026-08-10', highlights: [
        'Fixed the first-run setup wizard staying permanently suppressed after wiping the add-on\'s data — it now reopens correctly on a genuine fresh start instead of only via the manual "Restart setup tour" control.',
    ] },
    { version: '2.33.2', date: '2026-08-10', highlights: [
        'Fixed the setup wizard closing itself the instant "Test connection" was clicked, and no longer leaves a duplicate machine behind.',
    ] },
    { version: '2.33.1', date: '2026-08-10', highlights: [
        'Fixed the first-run setup wizard never actually opening on a real fresh install.',
    ] },
    { version: '2.33.0', date: '2026-08-10', highlights: [
        'Added a guided first-run setup wizard: a first-time install with no machines configured now gets a welcome -> connect machine -> done walkthrough automatically.',
        'The wizard offers a one-click "load demo data" shortcut for trying GLP before connecting a real machine.',
        'A new "Restart setup tour" control in Settings → Machines reopens the wizard anytime.',
    ] },
    { version: '2.32.0', date: '2026-08-10', highlights: [
        'Machine setup\'s "Test connection" button now saves first automatically, instead of requiring the machine to already be saved.',
        'New machines show an import progress indicator for their initial shot sync.',
        'Saving any machine now triggers a catch-up shot sync for it, not just default-machine host changes.',
        'Shot-import progress now updates live instead of in 30s polling jumps, and the completion toast is now reliable — falls back to the previous polling behavior automatically if a live connection can\'t be established.',
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
