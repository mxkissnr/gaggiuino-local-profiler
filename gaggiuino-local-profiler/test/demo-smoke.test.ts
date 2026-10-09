import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import { contentTypeFor, resolveRequestPath } from '../scripts/demo-smoke.mts';

// Part of #1193 (S4): the pure helpers behind scripts/demo-smoke.mts. The
// smoke test itself serves demo-dist/ and drives Chromium, so only the two
// helpers that decide what the server reads and how it labels it get unit
// coverage here; the full run is exercised by the deploy workflow.

describe('demo-smoke contentTypeFor (#1193)', () => {
    it('maps the demo asset extensions to their media types', () => {
        expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
        expect(contentTypeFor('assets/index-abc123.js')).toBe('text/javascript; charset=utf-8');
        expect(contentTypeFor('style.css')).toBe('text/css; charset=utf-8');
        expect(contentTypeFor('fixtures/manifest.json')).toBe('application/json; charset=utf-8');
        expect(contentTypeFor('icon.svg')).toBe('image/svg+xml');
        expect(contentTypeFor('photo.png')).toBe('image/png');
        expect(contentTypeFor('photo.webp')).toBe('image/webp');
        expect(contentTypeFor('figtree-400-latin.woff2')).toBe('font/woff2');
    });

    it('matches the extension case-insensitively', () => {
        expect(contentTypeFor('SHOT.PNG')).toBe('image/png');
        expect(contentTypeFor('Index.HTML')).toBe('text/html; charset=utf-8');
    });

    it('falls back to the generic binary type for an unknown extension', () => {
        expect(contentTypeFor('archive.tar')).toBe('application/octet-stream');
        expect(contentTypeFor('LICENSE')).toBe('application/octet-stream');
    });
});

describe('demo-smoke resolveRequestPath (#1193)', () => {
    const root = resolve('/tmp/demo-dist');

    it('resolves a nested path under the root', () => {
        expect(resolveRequestPath(root, '/assets/index-abc123.js')).toBe(
            join(root, 'assets', 'index-abc123.js'),
        );
    });

    it('resolves the bare root to the root directory itself', () => {
        expect(resolveRequestPath(root, '/')).toBe(root);
    });

    it('treats a missing leading slash as relative to the root', () => {
        expect(resolveRequestPath(root, 'index.html')).toBe(join(root, 'index.html'));
    });

    it('strips a query string and a hash', () => {
        expect(resolveRequestPath(root, '/index.html?cache=1#top')).toBe(join(root, 'index.html'));
    });

    it('decodes percent-encoded names', () => {
        expect(resolveRequestPath(root, '/a%20b/c%2Bd.js')).toBe(join(root, 'a b', 'c+d.js'));
    });

    it('refuses a .. traversal', () => {
        expect(resolveRequestPath(root, '/../../etc/passwd')).toBeNull();
        expect(resolveRequestPath(root, '/assets/../../../secret')).toBeNull();
    });

    it('refuses an encoded .. traversal', () => {
        expect(resolveRequestPath(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    });

    it('keeps an absolute path inside the root instead of escaping it', () => {
        expect(resolveRequestPath(root, '/etc/passwd')).toBe(join(root, 'etc', 'passwd'));
    });

    it('refuses malformed percent-encoding', () => {
        expect(resolveRequestPath(root, '/%zz')).toBeNull();
    });

    it('refuses a null byte', () => {
        expect(resolveRequestPath(root, '/index%00.html')).toBeNull();
    });
});
