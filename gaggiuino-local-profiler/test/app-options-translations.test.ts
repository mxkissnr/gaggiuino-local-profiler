import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const I18N_DIR = join(ROOT, 'public-src', 'i18n');
const TRANSLATIONS_DIR = join(ROOT, 'translations');

function read(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8');
}

// #1495: the option keys Home Assistant renders come straight from config.yaml's
// `schema:` block. Parsed line by line on purpose — this repo has no YAML
// dependency, and scripts/sync-dev-config.mts reads the same block the same way.
function schemaKeys(): string[] {
    const lines = read('config.yaml').split('\n');
    const start = lines.findIndex((line) => line === 'schema:');
    if (start === -1) return [];
    const keys: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (/^[^\s#]/.test(line)) break;
        const match = /^\s{2}([A-Za-z0-9_]+):/.exec(line);
        if (match?.[1]) keys.push(match[1]);
    }
    return keys;
}

interface OptionText {
    name?: string;
    description?: string;
}

// Reads the `configuration:` block of one translations file into
// { optionKey: { name, description } }, the shape Home Assistant expects:
// two-space indented option keys, four-space indented name/description pairs.
function parseTranslations(text: string): Map<string, OptionText> {
    const result = new Map<string, OptionText>();
    let inConfiguration = false;
    let current: OptionText | null = null;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        if (/^[^\s]/.test(line)) {
            inConfiguration = line === 'configuration:';
            current = null;
            continue;
        }
        if (!inConfiguration) continue;
        const option = /^\s{2}([A-Za-z0-9_]+):\s*$/.exec(line);
        if (option?.[1]) {
            current = {};
            result.set(option[1], current);
            continue;
        }
        const field = /^\s{4}(name|description):\s*(.+)$/.exec(line);
        if (field?.[1] && field[2] && current) {
            current[field[1] as 'name' | 'description'] = field[2].trim();
        }
    }
    return result;
}

const optionKeys = schemaKeys();
const languages = readdirSync(I18N_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();

describe('app option translations (#1495)', () => {
    it('reads the option keys from config.yaml', () => {
        expect(optionKeys).toContain('sync_interval');
        expect(optionKeys).toContain('allowed_hosts');
    });

    it('has one translation file per app language', () => {
        expect(languages.length).toBeGreaterThan(0);
        const files = readdirSync(TRANSLATIONS_DIR)
            .filter((file) => file.endsWith('.yaml'))
            .map((file) => file.replace(/\.yaml$/, ''))
            .sort();
        expect(files).toEqual(languages);
    });

    for (const lang of languages) {
        it(`names and describes every option in ${lang}.yaml`, () => {
            const translated = parseTranslations(
                readFileSync(join(TRANSLATIONS_DIR, `${lang}.yaml`), 'utf8'),
            );
            expect([...translated.keys()].sort()).toEqual([...optionKeys].sort());
            for (const key of optionKeys) {
                const entry = translated.get(key);
                expect(entry?.name, `${lang}.yaml ${key} name`).toBeTruthy();
                expect(entry?.description, `${lang}.yaml ${key} description`).toBeTruthy();
            }
        });
    }
});
