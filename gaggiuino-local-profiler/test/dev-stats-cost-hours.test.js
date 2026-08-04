import { describe, it, expect } from 'vitest';
import { monthsSinceStart, clusterIntoSessions } from '../scripts/dev-stats.mjs';

// #623: replaced the token/line-based cost estimate (scripts/dev-stats.pricing.json,
// now deleted) with the real flat-rate Claude Pro subscription cost, and added a
// commit-clustering hours-of-development estimate. Both derive from small, easy to
// get subtly wrong date/time math, so they get direct unit coverage independent of
// the full DEVELOPMENT.md generation in main().
describe('dev-stats monthsSinceStart (#623)', () => {
    it('counts a partial month as a full month, per the issue\'s own example', () => {
        // First commit Jan 15, "today" Feb 3 — 2 distinct calendar months touched.
        expect(monthsSinceStart('2026-01-15', new Date('2026-02-03'))).toBe(2);
    });

    it('is 1 when the first commit and today are in the same month', () => {
        expect(monthsSinceStart('2026-01-05', new Date('2026-01-20'))).toBe(1);
    });

    it('spans a year boundary correctly', () => {
        expect(monthsSinceStart('2025-12-20', new Date('2026-01-05'))).toBe(2);
    });

    it('returns 0 for a missing firstDate', () => {
        expect(monthsSinceStart(undefined, new Date('2026-01-05'))).toBe(0);
    });
});

describe('dev-stats clusterIntoSessions (#623)', () => {
    const H = 60 * 60 * 1000;
    const M = 60 * 1000;

    it('returns 0 for no commits', () => {
        expect(clusterIntoSessions([])).toBe(0);
    });

    it('a single commit is one session: 0 span + 30min lead-in', () => {
        expect(clusterIntoSessions([1000])).toBeCloseTo(0.5, 5);
    });

    it('commits within the gap threshold merge into one session', () => {
        const start = 0;
        // Three commits an hour apart (well within the 2h default gap).
        const timestamps = [start, start + H, start + 2 * H];
        // Session span is 2h + 30min lead-in = 2.5h.
        expect(clusterIntoSessions(timestamps)).toBeCloseTo(2.5, 5);
    });

    it('commits past the gap threshold split into separate sessions', () => {
        const start = 0;
        // Second commit 3h after the first — past the 2h default gap.
        const timestamps = [start, start + 3 * H];
        // Two single-commit sessions: 0.5h + 0.5h = 1h.
        expect(clusterIntoSessions(timestamps)).toBeCloseTo(1, 5);
    });

    it('is order-independent (sorts timestamps internally)', () => {
        const start = 0;
        const forward  = [start, start + H, start + 2 * H];
        const shuffled = [start + 2 * H, start, start + H];
        expect(clusterIntoSessions(shuffled)).toBeCloseTo(clusterIntoSessions(forward), 5);
    });

    it('treats exactly the gap threshold as still the same session', () => {
        const start = 0;
        const timestamps = [start, start + 2 * H];
        expect(clusterIntoSessions(timestamps)).toBeCloseTo(2.5, 5);
    });

    it('one minute past the gap threshold starts a new session', () => {
        const start = 0;
        const timestamps = [start, start + 2 * H + M];
        expect(clusterIntoSessions(timestamps)).toBeCloseTo(1, 5);
    });
});
