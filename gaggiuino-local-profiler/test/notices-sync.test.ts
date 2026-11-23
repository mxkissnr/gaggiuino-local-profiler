import { describe, it, expect } from 'vitest';
import {
    builderGoVersion,
    parseGoList,
    readNpmLock,
    syncNotices,
    type Installed,
    type NpmLock,
} from '../scripts/notices-sync.mts';

// #2183: the two notices guards turn red whenever Renovate bumps a runtime
// dependency, because nothing rewrites the version headings of
// THIRD_PARTY_NOTICES.md. `npm run notices:sync` does that, and these tests
// exercise its pure part: it must only touch versions of headings it knows,
// and hand a new or removed package/module to a person.

const fixture = [
    '# Third-party notices',
    '',
    'The app bundles the libraries below.',
    '',
    '## Libraries',
    '',
    '### echarts 6.1.0',
    '',
    'Charting library.',
    '',
    '- Licensed under the Apache License 2.0.',
    '',
    '### tslib 2.3.0',
    '',
    'Runtime helpers.',
    '',
    '- Licensed under the 0BSD License.',
    '',
    '## Fonts',
    '',
    '### Figtree 400, 600',
    '',
    'Interface typeface.',
    '',
    '## Models',
    '',
    '### Segment Anything',
    '',
    'On-device bean cut-out.',
    '',
    '## Server',
    '',
    '### Go standard library 1.27.4',
    '',
    '- Licensed under the BSD 3-Clause License.',
    '',
    '### golang.org/x/sys v0.49.0',
    '',
    'System calls for the machine link.',
    '',
    '- Licence: https://pkg.go.dev/golang.org/x/sys@v0.49.0?tab=licenses',
    '',
    '## Full licence texts',
    '',
    '### MIT License — echarts, x/sys',
    '',
    'Text.',
    '',
].join('\n');

interface Overrides {
    npmDirect?: string[];
    npm?: NpmLock;
    goModules?: Map<string, string>;
    goStdlib?: string;
}

function installed(overrides: Overrides = {}): Installed {
    return {
        npmDirect: overrides.npmDirect ?? ['echarts'],
        npm: overrides.npm ?? { top: new Map([['echarts', '6.1.0'], ['tslib', '2.3.0']]), nested: new Map() },
        goModules: overrides.goModules ?? new Map([['golang.org/x/sys', 'v0.49.0']]),
        goStdlib: overrides.goStdlib ?? '1.27.4',
    };
}

function withNpm(top: [string, string][], nested: [string, string[]][] = []): Installed {
    return installed({ npm: { top: new Map(top), nested: new Map(nested) } });
}

describe('syncNotices (#2183)', () => {
    it('rewrites an npm heading to the locked version', () => {
        const result = syncNotices(fixture, withNpm([['echarts', '6.2.0'], ['tslib', '2.3.0']]));

        expect(result.text).toContain('### echarts 6.2.0');
        expect(result.text).not.toContain('### echarts 6.1.0');
        expect(result.changes).toEqual(['### echarts 6.1.0 -> ### echarts 6.2.0']);
        expect(result.problems).toEqual([]);
    });

    it('rewrites a transitive library that the lock file installs once', () => {
        const result = syncNotices(fixture, withNpm([['echarts', '6.1.0'], ['tslib', '2.8.1']]));

        expect(result.text).toContain('### tslib 2.8.1');
        expect(result.problems).toEqual([]);
    });

    it('rewrites a Go heading and its pkg.go.dev licence link', () => {
        const result = syncNotices(fixture, installed({ goModules: new Map([['golang.org/x/sys', 'v0.50.0']]) }));

        expect(result.text).toContain('### golang.org/x/sys v0.50.0');
        expect(result.text).toContain('https://pkg.go.dev/golang.org/x/sys@v0.50.0?tab=licenses');
        expect(result.text).not.toContain('@v0.49.0');
        expect(result.problems).toEqual([]);
    });

    it('rewrites the Go standard library heading to the builder version', () => {
        const result = syncNotices(fixture, installed({ goStdlib: '1.27.5' }));

        expect(result.text).toContain('### Go standard library 1.27.5');
        expect(result.problems).toEqual([]);
    });

    it('reports a new npm dependency and adds nothing', () => {
        const result = syncNotices(
            fixture,
            installed({
                npmDirect: ['echarts', 'newlib'],
                npm: {
                    top: new Map([['echarts', '6.1.0'], ['tslib', '2.3.0'], ['newlib', '1.0.0']]),
                    nested: new Map(),
                },
            }),
        );

        expect(result.text).toBe(fixture);
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]).toContain('### newlib 1.0.0');
        expect(result.problems[0]).toContain('## Libraries');
    });

    it('reports a new Go module and adds nothing', () => {
        const result = syncNotices(
            fixture,
            installed({
                goModules: new Map([['golang.org/x/sys', 'v0.49.0'], ['example.com/mod', 'v1.2.3']]),
            }),
        );

        expect(result.text).toBe(fixture);
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]).toContain('### example.com/mod v1.2.3');
        expect(result.problems[0]).toContain('## Server');
    });

    it('reports a removed npm package and keeps its section', () => {
        const result = syncNotices(fixture, withNpm([['echarts', '6.1.0']]));

        expect(result.text).toBe(fixture);
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]).toContain('### tslib 2.3.0');
        expect(result.problems[0]).toContain('remove');
    });

    it('reports a removed Go module and keeps its section', () => {
        const result = syncNotices(fixture, installed({ goModules: new Map() }));

        expect(result.text).toBe(fixture);
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]).toContain('### golang.org/x/sys v0.49.0');
        expect(result.problems[0]).toContain('remove');
    });

    it('reports a transitive library the lock file installs at several versions', () => {
        const result = syncNotices(
            fixture,
            withNpm([['echarts', '6.1.0'], ['tslib', '2.8.1']], [['tslib', ['2.3.0']]]),
        );

        expect(result.text).toContain('### tslib 2.3.0');
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]).toContain('2.8.1, 2.3.0');
    });

    it('changes nothing when every version matches', () => {
        const result = syncNotices(fixture, installed());

        expect(result.text).toBe(fixture);
        expect(result.changes).toEqual([]);
        expect(result.problems).toEqual([]);
    });

    it('never touches Fonts, Models or licence-text headings', () => {
        const result = syncNotices(
            fixture,
            installed({
                npm: { top: new Map([['echarts', '6.2.0'], ['tslib', '2.8.1']]), nested: new Map() },
                goModules: new Map([['golang.org/x/sys', 'v0.50.0']]),
                goStdlib: '1.27.5',
            }),
        );

        expect(result.text).toContain('### Figtree 400, 600');
        expect(result.text).toContain('### Segment Anything');
        expect(result.text).toContain('### MIT License — echarts, x/sys');
    });
});

describe('readNpmLock (#2183)', () => {
    it('splits top-level from nested and skips dev packages', () => {
        const lock = {
            lockfileVersion: 3,
            packages: {
                '': { name: 'app', version: '1.0.0' },
                'node_modules/a': { version: '1.0.0' },
                'node_modules/b/node_modules/a': { version: '0.9.0' },
                'node_modules/@s/c': { version: '2.0.0' },
                'node_modules/d': { version: '3.0.0', dev: true },
            },
        };

        const result = readNpmLock(lock);

        expect(result.top.get('a')).toBe('1.0.0');
        expect(result.top.get('@s/c')).toBe('2.0.0');
        expect(result.top.has('d')).toBe(false);
        expect(result.nested.get('a')).toEqual(['0.9.0']);
    });
});

describe('parseGoList (#2183)', () => {
    it('throws on a replaced module', () => {
        expect(() => parseGoList('example.com/x v1.0.0 REPLACED\n')).toThrow(/example\.com\/x/);
        expect(parseGoList('a v1\n\nb v2\n').size).toBe(2);
    });
});

describe('builderGoVersion (#2183)', () => {
    it('wants exactly one golang tag', () => {
        expect(builderGoVersion('FROM golang:1.27.4-alpine@sha256:abc AS builder')).toBe('1.27.4');
        expect(() =>
            builderGoVersion('FROM golang:1.27.4-alpine AS builder\nFROM golang:1.28.0-alpine AS other'),
        ).toThrow();
    });
});
