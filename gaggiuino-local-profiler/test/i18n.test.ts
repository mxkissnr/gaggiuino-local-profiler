import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import de from '../public-src/i18n/de.js';
import en from '../public-src/i18n/en.js';
import itLang from '../public-src/i18n/it.js';
import fr from '../public-src/i18n/fr.js';
import es from '../public-src/i18n/es.js';
import nl from '../public-src/i18n/nl.js';
import { LOCALE_MAP, localeFor } from '../public-src/constants.js';
import { formatDate } from '../public-src/utils.js';

// setLang() runs applyTranslations() (which touches document) and then re-renders
// the active view through window.* hooks. Stub those browser globals so the
// behaviour test can drive the real setLang() the same way index.ts does.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= g;
g.document = {
  documentElement: { lang: 'de' },
  getElementById: (): null => null,
  querySelectorAll: (): unknown[] => [],
};
const { S } = await import('../public-src/state/index.js');
const { setLang } = await import('../public-src/i18n.js');

// localeFor()'s declared parameter is `string`, but the app feeds it a
// possibly-unset S.currentLang; this test pins the runtime tolerance for
// undefined/null, so the probe goes through a wider local signature.
const localeForUnset = localeFor as (lang: string | null | undefined) => string;

const LANGS = { de, en, it: itLang, fr, es, nl };

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// #2238: the system locale is the second region source. A stubbed system
// locale needs a fresh constants module, because localeFor's cache key holds
// only the browser languages, not the system locale.
function stubSystemLocale(locale: string): void {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
        .mockReturnValue({ locale } as Intl.ResolvedDateTimeFormatOptions);
}
async function freshLocaleFor(): Promise<(lang: string) => string> {
    vi.resetModules();
    return (await import('../public-src/constants.js')).localeFor;
}

const NEW_KEYS = [
    'machine_ready', 'export_csv_title', 'export_shot_title', 'share_card_tooltip',
    'compare_title', 'please_wait', 'profile_unknown',
    'backup_progress_download', 'backup_progress_upload', 'backup_progress_preparing',
    'backup_progress_restoring', 'backup_progress_done', 'settings_devtools_export_db_failed',
    // Recorded-phase extras (#1409): shot end reason, phase exit reasons and
    // machine warnings. shot_end_reason is a formatter (truthy as a function).
    'shot_end_reason',
    'exit_reason_1', 'exit_reason_2', 'exit_reason_3', 'exit_reason_4',
    'exit_reason_5', 'exit_reason_6', 'exit_reason_7',
    'machine_warn_water', 'machine_warn_flush', 'machine_warn_switch',
    'machine_warn_scaleConnected', 'machine_warn_scaleBattery', 'machine_warn_temperature',
    'machine_update_available',
    // #1923: the maintenance page's own wording — the all-good verdict
    // sentence and the tasks section heading.
    'maint_verdict_ok', 'maint_tasks_title',
    // #1955: the task sheet's pause/resume toggle and the paused row label.
    'maint_paused', 'maint_pause_btn', 'maint_resume_btn',
    // #1957: the annotation panel's taste-tag chips. Three labels are shared
    // with the Profile Dial-In wizard; the panel reuses that prompt as its
    // label and needs one label of its own.
    'profile_dialin_symptom_prompt', 'profile_dialin_symptom_sour',
    'profile_dialin_symptom_bitter', 'profile_dialin_symptom_balanced',
    'taste_tag_thin',
];

describe('i18n language files', () => {
    // Regression (#391): LOCALE_MAP only had 5 entries for 6 supported
    // languages (nl was missing), silently falling back to 'de-DE' for
    // Dutch-locale date formatting.
    it('LOCALE_MAP has a BCP-47 locale for every supported language', () => {
        for (const name of Object.keys(LANGS)) {
            expect(LOCALE_MAP, `LOCALE_MAP missing an entry for "${name}"`).toHaveProperty(name);
            expect(LOCALE_MAP[name]).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
        }
    });

    // Companion guard for a second regression: every LOCALE_MAP[lang] || 'de-DE'
    // call site (13+ views/components) used to duplicate the same German
    // fallback, so an unsupported S.currentLang silently rendered dates/times
    // in German for every user, not just German ones — same failure mode
    // #391 already found for the missing 'nl' entry, just for *any* unlisted
    // language rather than one specific one. localeFor() is now the single
    // place that decides the fallback; keep it locked to English.
    it('localeFor() falls back to en-US, not de-DE, for an unsupported/missing language', () => {
        expect(localeFor('pt')).toBe('en-US');
        expect(localeFor('xx')).toBe('en-US');
        expect(localeForUnset(undefined)).toBe('en-US');
        expect(localeForUnset(null)).toBe('en-US');
    });

    it("localeFor() returns the exact LOCALE_MAP entry for every supported language", async (): Promise<void> => {
        vi.stubGlobal('navigator', { language: '', languages: [] });
        stubSystemLocale('und');
        const fresh = await freshLocaleFor();
        for (const name of Object.keys(LANGS)) {
            expect(fresh(name)).toBe(LOCALE_MAP[name]);
        }
    });

    it('all languages define the new keys with a non-empty value', () => {
        for (const [name, obj] of Object.entries(LANGS)) {
            for (const key of NEW_KEYS) {
                expect(obj, `${name}.js missing ${key}`).toHaveProperty(key);
                expect(obj[key], `${name}.js ${key} is empty`).toBeTruthy();
            }
        }
    });

    it('backup_progress_download/upload are functions that interpolate the percentage (#960)', () => {
        for (const [name, obj] of Object.entries(LANGS)) {
            for (const key of ['backup_progress_download', 'backup_progress_upload']) {
                expect(typeof obj[key], `${name}.js ${key} should be a function`).toBe('function');
                expect((obj[key] as (pct: number) => string)(42), `${name}.js ${key}(42)`).toContain('42');
            }
        }
    });

    it('compare_title is a function that interpolates both shot ids', () => {
        for (const [name, obj] of Object.entries(LANGS)) {
            expect(typeof obj.compare_title, `${name}.js compare_title should be a function`).toBe('function');
            const rendered = (obj.compare_title as (a: number, b: number) => string)(11, 22);
            expect(rendered, `${name}.js compare_title output`).toContain('11');
            expect(rendered, `${name}.js compare_title output`).toContain('22');
        }
    });
});

// #2232: the language picks the words, the browser's region the conventions.
describe('localeFor() follows the browser region (#2232)', () => {
    const d = new Date(2026, 10, 9, 16, 2);
    const clean = (s: string): string => s.replace(/\s/g, ' ');

    it("English UI in a German browser uses day-first dates and a 24-hour clock", () => {
        vi.stubGlobal('navigator', { language: 'de-DE', languages: ['de-DE', 'de', 'en'] });
        expect(localeFor('en')).toBe('en-DE');
        expect(clean(formatDate(d, localeFor('en'), 'short', true))).toBe('09/11/2026 16:02');
        expect(clean(formatDate(d, localeFor('en'), 'long'))).toBe('9 November 2026');
    });

    it("English UI in a US browser is unchanged", () => {
        vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] });
        expect(localeFor('en')).toBe('en-US');
        expect(clean(formatDate(d, localeFor('en'), 'short', true))).toBe('11/09/2026 04:02 PM');
    });

    it("the first browser language wins and keeps the UI language's words", () => {
        vi.stubGlobal('navigator', { language: 'en-US', languages: ['de-AT', 'en-US'] });
        expect(localeFor('de')).toBe('de-AT');
        expect(localeFor('en')).toBe('en-AT');
        vi.stubGlobal('navigator', { language: 'en-GB', languages: [] });
        expect(localeFor('en')).toBe('en-GB');
    });

    it("falls back to the fixed locale without a usable region", async (): Promise<void> => {
        stubSystemLocale('und');
        const fresh = await freshLocaleFor();
        vi.stubGlobal('navigator', { language: '', languages: [] });
        expect(fresh('fr')).toBe('fr-FR');
        vi.stubGlobal('navigator', { language: 'x', languages: ['not a locale!'] });
        expect(fresh('nl')).toBe('nl-NL');
        vi.stubGlobal('navigator', undefined);
        expect(fresh('it')).toBe('it-IT');
    });

    it("an unknown UI language still falls back to English", () => {
        vi.stubGlobal('navigator', { language: 'de-DE', languages: ['de-DE'] });
        expect(localeFor('pt')).toBe('en-DE');
    });

    it("a bare first browser language does not hide the region of a later one (#2238)", async (): Promise<void> => {
        vi.stubGlobal('navigator', { language: 'de', languages: ['de', 'de-DE'] });
        stubSystemLocale('en-US');
        const fresh = await freshLocaleFor();
        expect(fresh('en')).toBe('en-DE');
        expect(fresh('de')).toBe('de-DE');
    });

    it("without a region in the browser languages the system locale's region applies (#2238)", async (): Promise<void> => {
        vi.stubGlobal('navigator', { language: 'de', languages: ['de'] });
        stubSystemLocale('de-DE');
        let fresh = await freshLocaleFor();
        expect(fresh('en')).toBe('en-DE');
        vi.restoreAllMocks();
        vi.stubGlobal('navigator', { language: 'fr', languages: [] });
        stubSystemLocale('fr-CH');
        fresh = await freshLocaleFor();
        expect(fresh('fr')).toBe('fr-CH');
    });

    // #2240: when neither source carries an explicit region, the likely region
    // of the first bare browser language applies before the LOCALE_MAP entry.
    it("a bare browser language gives its likely region when no locale has one (#2240)", async (): Promise<void> => {
        vi.stubGlobal('navigator', { language: 'de', languages: ['de', 'en'] });
        stubSystemLocale('de');
        const fresh = await freshLocaleFor();
        expect(fresh('en')).toBe('en-DE');
        expect(fresh('de')).toBe('de-DE');
        expect(fresh('pt')).toBe('en-DE');
    });

    it("an explicit region still wins over a likely one (#2240)", async (): Promise<void> => {
        vi.stubGlobal('navigator', { language: 'de', languages: ['de', 'en-GB'] });
        stubSystemLocale('und');
        const fresh = await freshLocaleFor();
        expect(fresh('en')).toBe('en-GB');
    });

    it("a bare English browser keeps en-US (#2240)", async (): Promise<void> => {
        vi.stubGlobal('navigator', { language: 'en', languages: ['en'] });
        stubSystemLocale('en');
        const fresh = await freshLocaleFor();
        expect(fresh('en')).toBe('en-US');
    });

    it("an invalid first tag is skipped for the likely region (#2240)", async (): Promise<void> => {
        vi.stubGlobal('navigator', { language: 'fr', languages: ['x', 'fr'] });
        stubSystemLocale('und');
        const fresh = await freshLocaleFor();
        expect(fresh('en')).toBe('en-FR');
    });
});

// #1620: one consistency guard for the six dictionaries. It fails when a key
// is missing from a language, when code references a key no dictionary
// defines, when a key nothing references is left behind, or when the
// languages disagree on a key's placeholders (a formatter's parameter count).
describe('i18n dictionaries stay consistent with the code (#1620)', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const SRC_ROOT = join(__dirname, '../public-src');

    function sourceFiles(dir: string, out: string[] = []): string[] {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) {
                if (name !== 'i18n' && name !== 'public') sourceFiles(path, out);
            } else if (/\.(ts|html)$/.test(name)) {
                out.push(path);
            }
        }
        return out;
    }
    const sources = sourceFiles(SRC_ROOT).map(path => readFileSync(path, 'utf8')).join('\n');

    // Keys the code builds at runtime, e.g. t(`ach_${id}_n`). Every key with
    // one of these prefixes counts as used; each prefix must still occur in
    // the code, so the list cannot outlive the construction it stands for.
    const DYNAMIC_PREFIXES = [
        'ach_', 'analytics_fact_wd_', 'analytics_summary_delta_', 'backup_section_',
        'curve_', 'exit_reason_', 'machine_warn_', 'phase_type_',
        'profile_dialin_symptom_', 'theme_preset_',
    ];

    it('every language defines exactly the English key set', () => {
        const base = new Set(Object.keys(en));
        for (const [name, dict] of Object.entries(LANGS)) {
            const keys = new Set(Object.keys(dict));
            const missing = [...base].filter(k => !keys.has(k));
            const extra = [...keys].filter(k => !base.has(k));
            expect(missing, `${name} is missing keys`).toEqual([]);
            expect(extra, `${name} has keys English lacks`).toEqual([]);
        }
    });

    it('every statically referenced key exists', () => {
        const referenced = new Set<string>();
        for (const m of sources.matchAll(/\bt(?:Html)?\(\s*['"]([A-Za-z0-9_-]+)['"]\s*[,)]/g)) referenced.add(m[1] ?? '');
        for (const m of sources.matchAll(/\sdata-i18n(?:-[a-z-]+)?="([A-Za-z0-9_-]+)"/g)) referenced.add(m[1] ?? '');
        const missing = [...referenced].filter(k => !(k in en)).sort();
        expect(missing, 'keys referenced in public-src but defined in no dictionary').toEqual([]);
    });

    it('every key is referenced somewhere', () => {
        const unused = Object.keys(en).filter(key => {
            if (DYNAMIC_PREFIXES.some(prefix => key.startsWith(prefix))) return false;
            return !new RegExp(`['"\`]${key}['"\`]`).test(sources);
        });
        expect(unused, 'keys no code or markup references').toEqual([]);
    });

    it('every dynamic key prefix is still built in the code', () => {
        for (const prefix of DYNAMIC_PREFIXES) {
            expect(sources.includes(`${prefix}\${`) || sources.includes(`'${prefix}' +`), `prefix ${prefix} is no longer built at runtime`).toBe(true);
        }
    });

    it('placeholders match across languages', () => {
        const mismatches: string[] = [];
        for (const [key, ref] of Object.entries(en)) {
            for (const [name, dict] of Object.entries(LANGS)) {
                const val = dict[key];
                if (val === undefined) continue; // reported by the key-set test
                if (typeof val !== typeof ref) {
                    mismatches.push(`${name}:${key} is a ${typeof val}, English a ${typeof ref}`);
                } else if (typeof val === 'function' && typeof ref === 'function' && val.length !== ref.length) {
                    mismatches.push(`${name}:${key} takes ${val.length} placeholders, English ${ref.length}`);
                }
            }
        }
        expect(mismatches).toEqual([]);
    });

    // #2232: every date/time call must get its locale from localeFor(), which
    // now depends on the browser region. A call site that inlines a locale
    // (LOCALE_MAP[...] or a literal) would silently opt out of that fix.
    it("no date or time call bypasses localeFor", () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(SRC_ROOT).filter(path => path.endsWith('.ts'))) {
            const text = readFileSync(file, 'utf8');
            for (const m of text.matchAll(/\.toLocale(?:Date|Time)String\(\s*([^,)]*)/g)) {
                const arg = (m[1] ?? '').trim();
                if (!/^(locale|localeFor\(.*)$/.test(arg)) offenders.push(`${file}: ${arg}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('index.html i18n wiring', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(__dirname, '../public-src/index.html'), 'utf8');

    // Deliberate plan deviation (#2153 slice 2): the plan lists only index.html,
    // style.css and the six dictionaries, but this guard pinned the old
    // <h1 data-i18n="live_title"> title bar, which this slice deletes. Without
    // the update the suite cannot go green; slice 3 can fold it into the page test.
    it('keeps the Live view title-less and wires the page-pattern keys (#2153)', () => {
        expect(html).not.toMatch(/data-i18n="live_title"/);
        expect(html).toMatch(/<span data-i18n="live_setup_toggle">/);
        expect(html).toMatch(/<span class="section-title__count" data-i18n="live_setup_hint">/);
        expect(html).toMatch(/id="refChip"[^>]*data-i18n-title="live_ref_title"/);
    });

    it('wires the idle-state heading to the new machine_ready key', () => {
        expect(html).toMatch(/<h2[^>]*data-i18n="machine_ready"[^>]*>Maschine bereit<\/h2>/);
    });

    it('wires the CSV/.shot export button tooltips to the new keys', () => {
        expect(html).toMatch(/id="exportAllCsvBtn"[^>]*data-i18n-title="export_csv_title"/);
        expect(html).toMatch(/id="exportShotBtn"[^>]*data-i18n-title="export_shot_title"/);
    });

    it('wires the share-card button tooltip to the new share_card_tooltip key', () => {
        expect(html).toMatch(/id="shareCardBtn"[^>]*data-i18n-title="share_card_tooltip"/);
    });

    it('wires the idle firmware-update hint to machine_update_available (#1409)', () => {
        // The idle warning list is filled from JS; only the update hint is a
        // plain data-i18n text node, so it must stay child-element-free.
        expect(html).toMatch(/<p[^>]*id="liveIdleUpdateHint"[^>]*data-i18n="machine_update_available"[^>]*>Firmware-Update auf der Maschine verfügbar<\/p>/);
        expect(html).toMatch(/<p[^>]*id="liveIdleWarnings"[^>]*><\/p>/);
        expect(html).not.toMatch(/<p[^>]*id="liveIdleWarnings"[^>]*data-i18n=/);
    });

    it('backup download control is no longer a plain <a href> (would 401 outside HA ingress)', () => {
        expect(html).not.toMatch(/<a[^>]*id="backupDownloadBtn"[^>]*href=/);
        expect(html).toMatch(/<button[^>]*id="backupDownloadBtn"/);
    });

    it('the restore label keeps its file input out of the data-i18n text node', () => {
        // applyTranslations() would wipe a child <input> when it sets textContent
        expect(html).toMatch(/<span data-i18n="backup_restore">/);
        expect(html).not.toMatch(/<label[^>]*data-i18n="backup_restore"/);
    });

    it('no [data-i18n] element contains child elements (textContent replacement would drop them)', () => {
        // Applies to plain data-i18n only; data-i18n-title/-placeholder/-html are safe.
        const re = /<(\w+)((?:(?!data-i18n-)[^>])*\sdata-i18n="[^"]+"[^>]*)>([\s\S]*?)<\/\1>/g;
        const offenders = [];
        for (const m of html.matchAll(re)) {
            const inner = m[3] ?? '';
            const full = m[0] ?? '';
            if (/<\w+/.test(inner)) offenders.push(full.slice(0, 100));
        }
        expect(offenders, `child elements inside [data-i18n] nodes:\n${offenders.join('\n')}`).toEqual([]);
    });

    // #1922: the Dev Tools card gains a score-model select and a blind-rating
    // checkbox. Both labels are plain data-i18n nodes, so they localise with
    // the rest of the card — but only if the label/control pairing survives
    // edits: a <label for=...> with no matching id leaves the text clickable
    // but silently untethered from its control.
    it('wires the Dev Tools score-model and blind-rating labels to their controls (#1922)', () => {
        expect(html).toMatch(/<label for="devScoreModel"[^>]*data-i18n="settings_devtools_score_model"/);
        expect(html).toMatch(/<select id="devScoreModel"/);
        expect(html).toMatch(/<p[^>]*data-i18n="settings_devtools_score_model_desc"/);
        expect(html).toMatch(/<label for="devBlindRating"[^>]*data-i18n="settings_devtools_blind_rating"/);
    });
});

// The shot detail view wires its phase tags, compare title and profile fallback
// through t(); rendering updateView() needs a full Chart.js + curve-fetch + ~40
// element harness (see test/shots-load-data-race.test.ts, which deliberately
// avoids it), so this stays a source guard — the escape hatch the issue allows
// for a disproportionate harness. The language-switch re-render below is its
// behavioural half.
describe('shot detail view i18n wiring', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dirname, '../public-src/views/shots/index.ts'), 'utf8');

    it('phase-tag chips use t() instead of hardcoded German labels', () => {
        expect(src).not.toMatch(/class="phase-tag">Preinfusion /);
        expect(src).not.toMatch(/class="phase-tag">Extraktion /);
        expect(src).toContain("t('phase_preinfusion')");
        expect(src).toContain("t('phase_extraction')");
    });

    it('compare title and unknown-profile fallback go through t() instead of hardcoded strings', () => {
        expect(src).not.toContain('Vergleich: Shot');
        expect(src).not.toContain("'Unknown Profile'");
        expect(src).toContain("t('compare_title'");
        expect(src).toContain("t('profile_unknown')");
    });
});

describe('setLang() re-renders the open shot view', () => {
    // Regression guard: the Chart.js legend, grind advice and phase tags are only
    // rebuilt when the shot detail re-renders — applyTranslations()'s DOM scan can't
    // reach canvas-drawn text, so a language switch used to leave them stuck in
    // whatever language was active when the shot was first opened.
    it('calls window.updateView() when switching language while on the shots view', () => {
        const updateView = vi.fn();
        g.updateView = updateView;
        S.currentMode = 'shots';
        setLang('en');
        expect(S.currentLang).toBe('en');
        expect(updateView).toHaveBeenCalledTimes(1);
    });

    it('does not call window.updateView() when another view is active', () => {
        const updateView = vi.fn();
        g.updateView = updateView;
        g.initAnalytics = vi.fn();
        S.currentMode = 'analytics';
        setLang('de');
        expect(updateView).not.toHaveBeenCalled();
    });
});

// #811 Phase 5 removed the app's second visual language: text glyphs baked
// into translated status strings (e.g. "✓ Gespeichert") instead of the
// app's own drawn icon set (public-src/icons.ts). One sibling key
// (orders_types_saved) was missed by the original sweep and only found by a
// manual recount -- no test caught it, because the existing key-set-
// equality test above only checks keys exist, not what their values
// contain. This guards the whole class going forward: no translated value
// in any of the 6 languages may carry a checkmark/cross/pencil glyph, full
// stop, so a future call site can never reintroduce this pattern silently.
describe('i18n values carry no leftover text-glyph icons (#811)', () => {
    const GLYPHS = ['\u2713', '\u2717', '\u2715', '\u270E']; // ✓ ✗ ✕ ✎

    it('no key in any language ships a checkmark/cross/pencil glyph', () => {
        for (const [name, dict] of Object.entries(LANGS)) {
            for (const [key, value] of Object.entries(dict)) {
                if (typeof value !== 'string') continue;
                for (const glyph of GLYPHS) {
                    expect(value.includes(glyph), `${name}:${key} still contains "${glyph}": ${JSON.stringify(value)}`).toBe(false);
                }
            }
        }
    });
});
