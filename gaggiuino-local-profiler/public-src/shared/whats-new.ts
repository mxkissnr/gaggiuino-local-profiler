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
    { version: '3.8.1', date: '2026-11-18', highlights: [
        'Fixed: GaggiMate shot history keeps syncing when one shot cannot be read, the desktop shot list stays open while you pick shots, and aroma and origin changes on a bean are saved right away.',
    ] },
    { version: '3.8.0', date: '2026-11-16', highlights: [
        'Settings is now a grouped list like in Home Assistant, with search and sub-pages.',
        'Tag how a shot tasted (sour, bitter, balanced or thin) and the grind advice takes it into account.',
        'Beans know their roast level and the profiles that worked for them, and grinders get a default and their own grind scale.',
        'The Dial-In and Achievements pages are clearer, and the library saves your changes by itself.',
        'Fixed: achievements with a counter unlock again, bean age is the same everywhere, and GaggiMate scale weights are shown.',
        'Security: built with Go 1.27.4.',
    ] },
    { version: '3.7.0', date: '2026-11-08', highlights: [
        'The maintenance page now shows what is due next, with simple lists for tasks and the log.',
        'Gaggiuino machines keep a history of their settings and profiles that you can compare and restore.',
        'Saved photos can be cropped again at any time.',
        'Saving a new coffee asks for its bag straight away.',
        'Fixed: the backflush and descaling guides are back, and firmware updates show their progress until the machine has finished.',
    ] },
    { version: '3.6.0', date: '2026-11-01', highlights: [
        'Mix beans in one shot: split a dose over up to four beans, each bag deducted by its own grams.',
        'Take photos with a camera inside the app, on every photo field.',
        'Set your own bean freshness windows and low-stock threshold in Settings.',
        'The guest kiosk can use its own orders-only key with a ready-made link.',
    ] },
    { version: '3.5.1', date: '2026-10-23', highlights: [
        'Fixed: a bag\'s roast date can be corrected after the first shot, machine settings answer at once when the machine is off, and the Live page, language switch and maintenance labels follow your changes without a reload.',
        'Security: the live-update stream no longer accepts the API token in the address, and the app is built with a patched Go release.',
    ] },
    { version: '3.5.0', date: '2026-10-18', highlights: [
        'Open pages pick up changes made on another device within seconds, without a reload.',
        'A backflush or descale recorded by your Gaggiuino now ticks off the matching maintenance task automatically.',
        'Pages and the Home Assistant integration load much faster on small devices with a long shot history, and shot scores use one five-step colour scale everywhere.',
        'Backups and restores are more reliable: large backups with many photos restore again, and a restore tells you when photos could not be written.',
        'Fixed: several-machine setups keep profile edits and maintenance entries on the machine they belong to, and saves the server rejects now show an error.',
        'Security: a round of hardening for photos, imports, notifications and Home Assistant ingress handling.',
    ] },
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
