import { describe, it, expect } from 'vitest';
import { scanSourceLeaks } from '../scripts/release-check.mts';

// #1624 slice 2: check 8 scans the shipped source for references to a private
// local notes directory and internal-only hostnames. The scanner is a pure
// function over (path, content) pairs, so these tests never touch git. The
// literals are assembled from parts so this file does not itself contain what
// the scanner looks for (test/ is in scope for the check).
const NOTES_DIR = '.cl' + 'aude';
const INTERNAL_HOST = 'box.' + 'intern';

describe('scanSourceLeaks (#1624)', () => {
    it('flags a private notes path with its file and line', () => {
        const failures = scanSourceLeaks([
            { path: 'public-src/example.ts', content: 'const a = 1;\n// see ~/' + NOTES_DIR + '/plans/x.md\n' },
        ]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('Check 8 (source leaks):');
        expect(failures[0]).toContain('public-src/example.ts:2');
        expect(failures[0]).toContain('private notes path');
    });

    it('flags an internal-only hostname', () => {
        const failures = scanSourceLeaks([
            { path: 'go/internal/system/status.go', content: 'fallback := "http://' + INTERNAL_HOST + '/api/shots"\n' },
        ]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('go/internal/system/status.go:1');
        expect(failures[0]).toContain('internal-only hostname');
    });

    it('passes a clean file even with example LAN addresses and mDNS names', () => {
        const clean = [
            'const box = "192.168.1.5";',
            'const mdns = "gaggiuino.local";',
            'const lan = "printer.lan";',
        ].join('\n');
        expect(scanSourceLeaks([{ path: 'public-src/clean.ts', content: clean }])).toEqual([]);
    });

    it('reports one finding per match', () => {
        const failures = scanSourceLeaks([
            { path: 'a.ts', content: '~/' + NOTES_DIR + '/plans/x.md\n' },
            { path: 'b.ts', content: 'server.' + 'intern\n' },
        ]);
        expect(failures).toHaveLength(2);
        expect(failures[0]).toContain('a.ts:1');
        expect(failures[1]).toContain('b.ts:1');
    });
});
