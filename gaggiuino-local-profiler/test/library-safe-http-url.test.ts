import { describe, it, expect } from 'vitest';

// library.js's import chain touches state/index.ts, which reads
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-frozen-portion-age-badge.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { safeHttpUrl } = await import('../public-src/views/library.js');

describe('safeHttpUrl', () => {
    it('accepts absolute http and https URLs', () => {
        expect(safeHttpUrl('https://example.com/shop/bean')).toBe('https://example.com/shop/bean');
        expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
    });

    it('rejects non-http(s) schemes, empty and unparseable values', () => {
        expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
        expect(safeHttpUrl('data:text/html,x')).toBeNull();
        expect(safeHttpUrl('ftp://example.com')).toBeNull();
        expect(safeHttpUrl('')).toBeNull();
        expect(safeHttpUrl('not a url')).toBeNull();
        expect(safeHttpUrl(undefined)).toBeNull();
    });
});
