import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import de from '../public-src/i18n/de.js';
import en from '../public-src/i18n/en.js';
import itLang from '../public-src/i18n/it.js';
import fr from '../public-src/i18n/fr.js';
import es from '../public-src/i18n/es.js';
import nl from '../public-src/i18n/nl.js';
import { LOCALE_MAP, localeFor } from '../public-src/constants.js';

const LANGS = { de, en, it: itLang, fr, es, nl };
const NEW_KEYS = [
    'machine_ready', 'export_csv_title', 'export_shot_title', 'share_card_tooltip',
    'compare_title', 'please_wait', 'profile_unknown',
    'backup_progress_download', 'backup_progress_upload', 'backup_progress_preparing',
    'backup_progress_restoring', 'backup_progress_done', 'settings_devtools_export_db_failed',
];

describe('i18n language files', () => {
    it('all 6 languages export the same key set', () => {
        const base = Object.keys(de).sort();
        for (const [name, obj] of Object.entries(LANGS)) {
            expect(Object.keys(obj).sort(), `key mismatch in ${name}.js`).toEqual(base);
        }
    });

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
        expect(localeFor(undefined)).toBe('en-US');
        expect(localeFor(null)).toBe('en-US');
    });

    it('localeFor() returns the exact LOCALE_MAP entry for every supported language', () => {
        for (const name of Object.keys(LANGS)) {
            expect(localeFor(name)).toBe(LOCALE_MAP[name]);
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
                expect(obj[key](42), `${name}.js ${key}(42)`).toContain('42');
            }
        }
    });

    it('compare_title is a function that interpolates both shot ids', () => {
        for (const [name, obj] of Object.entries(LANGS)) {
            expect(typeof obj.compare_title, `${name}.js compare_title should be a function`).toBe('function');
            const rendered = obj.compare_title(11, 22);
            expect(rendered, `${name}.js compare_title output`).toContain('11');
            expect(rendered, `${name}.js compare_title output`).toContain('22');
        }
    });
});

describe('index.html i18n wiring', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(__dirname, '../public-src/index.html'), 'utf8');

    it('wires the Live Shot heading to the existing live_title key', () => {
        expect(html).toMatch(/<h1[^>]*data-i18n="live_title"[^>]*>Live Shot<\/h1>/);
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
            if (/<\w+/.test(m[3])) offenders.push(m[0].slice(0, 100));
        }
        expect(offenders, `child elements inside [data-i18n] nodes:\n${offenders.join('\n')}`).toEqual([]);
    });
});

describe('shot detail view i18n wiring', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dirname, '../public-src/views/shots/index.js'), 'utf8');

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
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dirname, '../public-src/i18n.js'), 'utf8');

    it('calls window.updateView() when switching language while on the shots view', () => {
        // Regression guard: the Chart.js legend, grind advice and phase tags are only
        // rebuilt when the shot detail re-renders — applyTranslations()'s DOM scan can't
        // reach canvas-drawn text, so a language switch used to leave them stuck in
        // whatever language was active when the shot was first opened.
        expect(src).toMatch(/currentMode === 'shots'.*window\.updateView/);
    });
});

// #811 Phase 5 removed the app's second visual language: text glyphs baked
// into translated status strings (e.g. "✓ Gespeichert") instead of the
// app's own drawn icon set (public-src/icons.js). One sibling key
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
