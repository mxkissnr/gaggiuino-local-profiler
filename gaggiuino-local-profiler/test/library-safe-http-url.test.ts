import { describe, it, expect } from 'vitest';
import { safeHttpUrl } from '../public-src/views/library.js';

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
