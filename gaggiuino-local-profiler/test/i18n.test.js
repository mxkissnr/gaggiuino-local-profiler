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

const LANGS = { de, en, it: itLang, fr, es, nl };
const NEW_KEYS = ['machine_ready', 'export_csv_title', 'export_shot_title', 'share_card_tooltip'];

describe('i18n language files', () => {
    it('all 6 languages export the same key set', () => {
        const base = Object.keys(de).sort();
        for (const [name, obj] of Object.entries(LANGS)) {
            expect(Object.keys(obj).sort(), `key mismatch in ${name}.js`).toEqual(base);
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
});
