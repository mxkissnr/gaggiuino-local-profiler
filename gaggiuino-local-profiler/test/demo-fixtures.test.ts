import { describe, it, expect } from 'vitest';
import {
    fixtureKey,
    fixtureFileName,
    extForContentType,
    findLeaks,
    parseOpenApiGetPaths,
} from '../scripts/demo-fixtures.mts';

// Part of #1193 (S1): the pure helpers behind scripts/demo-fixtures.mts. The
// recorder itself boots the Go server and drives Chromium, so only the pure
// functions get unit coverage here; the full run is exercised by the
// maintainer with `npm run demo:fixtures`.

describe('demo-fixtures fixtureKey (#1193)', () => {
    it('uppercases the method and keeps a bare path', () => {
        expect(fixtureKey('get', '/api/shots?limit=50')).toBe('GET /api/shots?limit=50');
    });

    it('normalises the host away, so the throwaway port never leaks into the key', () => {
        expect(fixtureKey('GET', 'http://127.0.0.1:8199/api/status')).toBe('GET /api/status');
    });

    it('sorts query params so ordering does not split one resource', () => {
        expect(fixtureKey('GET', '/api/library?b=2&a=1')).toBe(fixtureKey('GET', '/api/library?a=1&b=2'));
    });

    it('drops cache-buster params', () => {
        expect(fixtureKey('GET', '/api/shots/5?t=1699999999')).toBe('GET /api/shots/5');
        expect(fixtureKey('GET', '/api/shots?limit=50&t=1&_=2')).toBe('GET /api/shots?limit=50');
    });

    it('has no question mark when nothing is left after filtering', () => {
        expect(fixtureKey('GET', '/api/status?t=1')).toBe('GET /api/status');
    });
});

describe('demo-fixtures fixtureFileName (#1193)', () => {
    const key = 'GET /api/shots?limit=50';

    it('uses only safe filename characters and the given extension', () => {
        const name = fixtureFileName(key, 'json');
        expect(name).toMatch(/^[a-z0-9-]+\.[a-z0-9]+$/);
        expect(name.endsWith('.json')).toBe(true);
    });

    it('is deterministic for the same key', () => {
        expect(fixtureFileName(key, 'json')).toBe(fixtureFileName(key, 'json'));
    });

    it('maps distinct keys to distinct names', () => {
        expect(fixtureFileName(key, 'json')).not.toBe(fixtureFileName('GET /api/shots?limit=20', 'json'));
    });

    it('sanitizes an unsafe extension instead of trusting it', () => {
        expect(fixtureFileName(key, '../evil')).toMatch(/\.evil$/);
    });
});

describe('demo-fixtures extForContentType (#1193)', () => {
    it('strips content-type parameters', () => {
        expect(extForContentType('application/json; charset=utf-8')).toBe('json');
    });

    it('maps the image types the SPA stores', () => {
        expect(extForContentType('image/png')).toBe('png');
        expect(extForContentType('image/jpeg')).toBe('jpg');
        expect(extForContentType('image/svg+xml')).toBe('svg');
    });

    it('falls back to bin for anything unknown or missing', () => {
        expect(extForContentType('application/octet-stream')).toBe('bin');
        expect(extForContentType('')).toBe('bin');
        expect(extForContentType(undefined)).toBe('bin');
    });
});

describe('demo-fixtures findLeaks (#1193)', () => {
    it('flags an unexpected IPv4 literal', () => {
        expect(findLeaks('machine_host=10.0.0.5')).toContain('10.0.0.5');
        expect(findLeaks('machine_host=8.8.8.8')).toContain('8.8.8.8');
    });

    it('allows the harness loopback and fake LAN addresses', () => {
        expect(findLeaks('a=127.0.0.1 b=192.168.1.50')).toEqual([]);
    });

    it('allows loopback addresses in a resolver error', () => {
        const err = 'lookup gaggiuino.local on 127.0.0.53:53: server misbehaving';
        expect(findLeaks(err)).toEqual([]);
    });

    it('allows the sanitized placeholder hex runs', () => {
        expect(findLeaks('a'.repeat(32))).toEqual([]);
        expect(findLeaks('b'.repeat(32))).toEqual([]);
    });

    it('allows an extra value such as the harness API token', () => {
        const token = 'f'.repeat(40);
        expect(findLeaks(`token ${token}`, [token])).toEqual([]);
    });

    it('flags an e-mail address', () => {
        expect(findLeaks('mail me at jane.doe@example.com')).toContain('jane.doe@example.com');
    });

    it('flags an unknown long hex run', () => {
        expect(findLeaks('sha 0123456789abcdef0123456789abcdef')).toContain('0123456789abcdef0123456789abcdef');
    });
});

describe('demo-fixtures parseOpenApiGetPaths (#1193)', () => {
    it('returns only the GET operation paths, in order', () => {
        const yaml = [
            'paths:',
            '  /api/a:',
            '    get:',
            '      tags: [X]',
            '  /api/b:',
            '    post:',
            '  /api/c/{id}:',
            '    get:',
            '    put:',
        ].join('\n');
        expect(parseOpenApiGetPaths(yaml)).toEqual(['/api/a', '/api/c/{id}']);
    });

    it('ignores inline non-method lines', () => {
        const yaml = [
            '  /api/d:',
            '    get: { tags: [X] }',
            '  /api/e:',
            '    get:',
        ].join('\n');
        expect(parseOpenApiGetPaths(yaml)).toEqual(['/api/e']);
    });
});
