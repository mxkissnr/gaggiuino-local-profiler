import { describe, it, expect } from 'vitest';
import { checkAcceptanceProtocol } from '../scripts/release-check.mjs';

// #1241: the release's acceptance protocol (docs/acceptance/v<version>.md) is
// a public Markdown file with one results table. Check 6 only inspects its
// shape and content — it never runs the acceptance pass — so it is a pure
// function taking the Markdown plus the release version.
const VERSION = '3.2.0';

function protocol(resultCell: string, opts: { caseName?: string; evidence?: string } = {}): string {
    const caseName = opts.caseName ?? 'app loads through ingress';
    const evidence = opts.evidence ?? 'no console errors';
    return [
        `# Acceptance protocol v${VERSION}`,
        '',
        `App version: ${VERSION}`,
        'Dev build tested: dev@abc1234',
        'Gaggiuino firmware: 1.0.0',
        'GaggiMate firmware: simulator',
        'Home Assistant version: 2026.9.0',
        '',
        '| # | Case | Source | Method | Result | Evidence |',
        '|---|------|--------|--------|--------|----------|',
        `| 1 | ${caseName} | #1241 | UI | ${resultCell} | ${evidence} |`,
        '',
    ].join('\n');
}

describe('checkAcceptanceProtocol (#1241)', () => {
    it('reports nothing when every case passes', () => {
        expect(checkAcceptanceProtocol(protocol('pass'), VERSION)).toEqual([]);
    });

    it('reports a failing case with its # and Case', () => {
        const failures = checkAcceptanceProtocol(
            protocol('fail', { caseName: 'order completes with milk deduction' }),
            VERSION
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('Check 6 (acceptance protocol):');
        expect(failures[0]).toContain('1');
        expect(failures[0]).toContain('order completes with milk deduction');
    });

    it('reports a still-pending manual case', () => {
        const failures = checkAcceptanceProtocol(
            protocol('manual-pending', { caseName: 'pull a real shot' }),
            VERSION
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('manual-pending');
        expect(failures[0]).toContain('pull a real shot');
    });

    it('accepts a waive with a reason and rejects a bare waive', () => {
        expect(checkAcceptanceProtocol(protocol('waived: no machine available'), VERSION)).toEqual([]);

        const bare = checkAcceptanceProtocol(protocol('waived:'), VERSION);
        expect(bare).toHaveLength(1);
        expect(bare[0]).toContain('waived without a reason');
    });

    it('reports an unknown result value', () => {
        const failures = checkAcceptanceProtocol(protocol('maybe'), VERSION);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('maybe');
    });

    it('reports a missing table', () => {
        const failures = checkAcceptanceProtocol(`# Acceptance protocol v${VERSION}\n\nNo table here.\n`, VERSION);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('no table');
    });

    it('flags a private IPv4 address', () => {
        const failures = checkAcceptanceProtocol(
            protocol('pass', { evidence: 'reached the box at 192.168.1.10' }),
            VERSION
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('192.168.1.10');
    });

    it('flags a .local/.lan hostname', () => {
        const failures = checkAcceptanceProtocol(
            protocol('pass', { evidence: 'http://homeassistant.local:8123' }),
            VERSION
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('homeassistant.local');
    });

    it('flags a JWT-like string', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0';
        const failures = checkAcceptanceProtocol(protocol('pass', { evidence: jwt }), VERSION);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('eyJ');
    });

    it('flags a GitHub token prefix', () => {
        const failures = checkAcceptanceProtocol(
            protocol('pass', { evidence: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }),
            VERSION
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('ghp_');
    });

    it('does not flag a public IP or a version number', () => {
        const doc = protocol('pass', { evidence: 'reachable at 8.8.8.8, version 3.2.0' });
        expect(checkAcceptanceProtocol(doc, VERSION)).toEqual([]);
    });
});
