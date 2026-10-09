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
export interface WhatsNewEntry {
    version: string;
    date: string;
    highlights: string[];
}

const WHATS_NEW_ENTRIES: WhatsNewEntry[] = [
    { version: '3.4.0', date: '2026-10-09', highlights: [
        'Before you update: GLP now refuses requests for unknown host names. The Home Assistant sidebar, IP addresses and local names such as .local or .fritz.box keep working. If you open GLP under your own domain, for example through a reverse proxy, add that domain to the new allowed_hosts option right after updating.',
        'A new coffee library: your beans stand on a shelf as bag photos with a stock bar, every bean opens a detail sheet with bags and actions, and bag photos can be cut out as stickers right on your device.',
        'Statistics, redesigned: a one-line verdict, a coffee year with streaks, a coffee map with routes to your cup, your beans ranked by score and a few surprising facts.',
        'Better GaggiMate support: flush and answer brew confirmations from GLP (firmware 1.9.0+), shots sync the moment they are saved, and standby, heating and flushing show correctly.',
        'Fixed: barcode scanning on iPhone and iPad, view settings that follow you across devices, kiosk orders that keep the chosen milk or bean, and a reliable preheat countdown.',
        'Security: built with Go 1.27.2 and an updated HTTP/2 library, unknown host names are refused, and the MQTT password no longer reaches the browser.',
    ] },
    { version: '3.3.0', date: '2026-10-02', highlights: [
        'Beans can now hold several bags as a queue, with a drag-reorderable upcoming list and per-bag stock.',
        'Machine profiles can be created, edited and deleted while the machine is offline, and are pushed to it automatically once it is reachable again.',
        'The live view has a shot setup panel: pick bean, dose, grinder, grind setting, basket, puck screen and recipe before you pull, and they are saved to the shot.',
        'Try the app in your browser with sample data and a simulated live shot, no machine needed.',
        'AI assistants such as Claude can read your shots, beans and analytics through an optional built-in MCP server, switched on in Settings.',
        'Fixed: GaggiMate machines on firmware v1.9.0 show the profile name, steaming, scale weight and live readings again.',
        'Fixed: changes made at the same moment, such as a milk deduction from an order while you edit a bean, no longer overwrite each other.',
    ] },
    { version: '3.2.0', date: '2026-09-26', highlights: [
        'New kiosk page for a tablet on the table: guests enter their name, pick a drink and place an order, and see the live queue with estimated times.',
        'Grinders can log a zero-point history, so re-zeroing after cleaning no longer means rewriting past grind settings.',
        'Add your own maintenance tasks with an optional shots and/or days interval, and disable any task without deleting it.',
        'Machine profiles can now be duplicated, and a firmware update triggered from the app is recorded in the maintenance log.',
        'Fixed: shot sync now works with more machines and firmware versions, and shots in the trash are deleted after 30 days again.',
    ] },
    { version: '3.1.0', date: '2026-09-17', highlights: [
        'Machines can now check for, trigger, and track Gaggiuino firmware updates right from the web app — a status badge on the machine\'s row expands into a progress bar naming the component being flashed, plus a release-channel selector in the machine\'s edit form.',
        'Fixed: manual shot sync and the machine debug probe are now protected against a machine host that changes what it points to.',
        'Fixed: the machine firmware update entity now actually detects available updates instead of always reporting up to date.',
        'Fixed: the Statistics world map tooltip no longer renders bean or region names as HTML.',
        'Fixed: the MQTT broker password can now be explicitly cleared, and is never returned in cleartext.',
    ] },
    { version: '3.0.2', date: '2026-09-11', highlights: [
        'Fixed: the machine firmware check no longer stops reporting the installed version when GitHub is temporarily unreachable.',
    ] },
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
];

const MAX_ENTRIES = 8;

function compareVersionsDesc(a: WhatsNewEntry, b: WhatsNewEntry): number {
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
function getWhatsNewEntries(): WhatsNewEntry[] {
    return [...WHATS_NEW_ENTRIES].sort(compareVersionsDesc).slice(0, MAX_ENTRIES);
}

export { WHATS_NEW_ENTRIES, MAX_ENTRIES, getWhatsNewEntries };
