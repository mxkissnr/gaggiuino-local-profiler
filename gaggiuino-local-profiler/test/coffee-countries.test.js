import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { mapOriginToCode, COFFEE_COUNTRY_CODES, findCountriesInText } = require('../lib/coffee-countries');

describe('mapOriginToCode', () => {
    it('maps German country names from roaster pages', () => {
        expect(mapOriginToCode('Äthiopien')).toBe('ET');
        expect(mapOriginToCode('Brasilien')).toBe('BR');
        expect(mapOriginToCode('Kolumbien')).toBe('CO');
    });

    it('maps English country names', () => {
        expect(mapOriginToCode('Ethiopia')).toBe('ET');
        expect(mapOriginToCode('Vietnam')).toBe('VN');
    });

    it('is case- and whitespace-insensitive', () => {
        expect(mapOriginToCode('  äthiopien ')).toBe('ET');
    });

    it('handles aliases Intl does not cover', () => {
        expect(mapOriginToCode('Hawaii')).toBe('US');
        expect(mapOriginToCode('Kongo')).toBe('CD');
    });

    it('returns null for blends and unknown strings', () => {
        expect(mapOriginToCode('Brasilien, Indien')).toBeNull();
        expect(mapOriginToCode('Mondbasis Alpha')).toBeNull();
        expect(mapOriginToCode('')).toBeNull();
        expect(mapOriginToCode(undefined)).toBeNull();
    });

    it('covers every country in the list in both languages', () => {
        for (const code of COFFEE_COUNTRY_CODES) {
            for (const lang of ['de', 'en']) {
                const name = new Intl.DisplayNames([lang], { type: 'region' }).of(code);
                expect(mapOriginToCode(name), `${lang} name for ${code}`).toBe(code);
            }
        }
    });
});

describe('findCountriesInText', () => {
    it('returns a single-element array for prose naming exactly one country', () => {
        expect(findCountriesInText('Dieser Kaffee kommt aus Äthiopien.')).toEqual(['ET']);
    });

    it('returns an empty array when no country is mentioned', () => {
        expect(findCountriesInText('Ein Espresso ohne jede Herkunftsangabe.')).toEqual([]);
        expect(findCountriesInText('')).toEqual([]);
        expect(findCountriesInText(undefined)).toEqual([]);
    });

    it('detects a genuine two-country blend, in first-appearance order', () => {
        expect(findCountriesInText('Ein Blend aus Brasilien und Indien.')).toEqual(['BR', 'IN']);
        expect(findCountriesInText('Ein Blend aus Indien und Brasilien.')).toEqual(['IN', 'BR']);
    });

    it('treats more than maxCount distinct countries as noise, not a blend', () => {
        const boilerplate = 'Wir importieren aus Brasilien, Kolumbien, Äthiopien, Kenia und Vietnam.';
        expect(findCountriesInText(boilerplate)).toEqual([]); // 5 distinct > default maxCount of 3
        expect(findCountriesInText(boilerplate, 5)).toHaveLength(5); // raising maxCount allows it
    });

    it('tolerates a trailing genitive s', () => {
        expect(findCountriesInText('Der Charakter Äthiopiens bleibt erhalten.')).toEqual(['ET']);
    });
});
