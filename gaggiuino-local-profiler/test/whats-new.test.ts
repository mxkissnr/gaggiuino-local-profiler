// #610: in-app "What's New" changelog data
// (public-src/shared/whats-new.js). Pure data + getter, no DOM deps, so
// it's tested directly.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WHATS_NEW_ENTRIES, MAX_ENTRIES, getWhatsNewEntries } from '../public-src/shared/whats-new.js';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

describe('WHATS_NEW_ENTRIES', () => {
    it('every entry is well-formed: version, date, non-empty highlights', () => {
        for (const entry of WHATS_NEW_ENTRIES) {
            expect(entry.version).toMatch(SEMVER_RE);
            expect(entry.date).toMatch(DATE_RE);
            expect(Array.isArray(entry.highlights)).toBe(true);
            expect(entry.highlights.length).toBeGreaterThan(0);
            entry.highlights.forEach(h => {
                expect(typeof h).toBe('string');
                expect(h.length).toBeGreaterThan(0);
            });
        }
    });

    it('has at most MAX_ENTRIES entries', () => {
        expect(WHATS_NEW_ENTRIES.length).toBeLessThanOrEqual(MAX_ENTRIES);
    });
});

describe('getWhatsNewEntries', () => {
    it('returns entries sorted newest-first by version', () => {
        const versions = getWhatsNewEntries().map(e => e.version);
        const sorted = [...versions].sort((a, b) => {
            const pa = a.split('.').map(Number);
            const pb = b.split('.').map(Number);
            for (let i = 0; i < 3; i++) {
                const pbPart = pb[i] ?? 0;
                const paPart = pa[i] ?? 0;
                if (pbPart !== paPart) return pbPart - paPart;
            }
            return 0;
        });
        expect(versions).toEqual(sorted);
    });

    it('caps the result at MAX_ENTRIES even if the source list were longer', () => {
        expect(getWhatsNewEntries().length).toBeLessThanOrEqual(MAX_ENTRIES);
    });

    it('does not mutate the underlying WHATS_NEW_ENTRIES array', () => {
        const before = WHATS_NEW_ENTRIES.map(e => e.version);
        getWhatsNewEntries();
        expect(WHATS_NEW_ENTRIES.map(e => e.version)).toEqual(before);
    });
});

describe('whats-new vs release version', () => {
    it('newest entry matches config.yaml version when CHANGELOG has a section for it', () => {
        const root = resolve(import.meta.dirname, '..');
        const version = readFileSync(join(root, 'config.yaml'), 'utf8').match(/^version:\s*"([^"]+)"/m)?.[1];
        const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
        expect(version).toBeDefined();
        if (changelog.includes(`## [${version}]`)) {
            expect(getWhatsNewEntries()[0]?.version).toBe(version);
        }
    });
});
