import { describe, it, expect } from 'vitest';

// #1622: the one five-step score scale used app-wide. The colour names a theme
// token (see tokens.css --ok/--score-good/--warn/--score-low/--err); a null
// score falls back to the muted gray role.
const { scoreColor, scoreClass, SCORE_STEPS } = await import('../public-src/utils.js');

describe('scoreColor (#1622 five-step scale)', () => {
    it('exports the shared thresholds once', () => {
        expect(SCORE_STEPS).toEqual({ great: 88, good: 75, ok: 60, low: 45 });
    });

    it('maps every boundary to the right token', () => {
        expect(scoreColor(88)).toBe('var(--ok)');
        expect(scoreColor(87)).toBe('var(--score-good)');
        expect(scoreColor(75)).toBe('var(--score-good)');
        expect(scoreColor(74)).toBe('var(--warn)');
        expect(scoreColor(60)).toBe('var(--warn)');
        expect(scoreColor(59)).toBe('var(--score-low)');
        expect(scoreColor(45)).toBe('var(--score-low)');
        expect(scoreColor(44)).toBe('var(--err)');
    });

    it('keeps a missing score on the muted gray token', () => {
        expect(scoreColor(null)).toBe('var(--gray-600)');
        expect(scoreColor(undefined)).toBe('var(--gray-600)');
    });
});

// scoreClass (#1622): the same five-step scale as CSS classes, so the sidebar,
// the tables and the charts colour a score identically.
describe('scoreClass (#1622 five-step scale)', () => {
    it('maps every boundary to the right class', () => {
        expect(scoreClass(44)).toBe('score-bad');
        expect(scoreClass(45)).toBe('score-low');
        expect(scoreClass(59)).toBe('score-low');
        expect(scoreClass(60)).toBe('score-ok');
        expect(scoreClass(74)).toBe('score-ok');
        expect(scoreClass(75)).toBe('score-good');
        expect(scoreClass(87)).toBe('score-good');
        expect(scoreClass(88)).toBe('score-great');
    });

    it('names the same step scoreColor() resolves to', () => {
        const tokenFor: Record<string, string> = {
            'score-great': 'var(--ok)', 'score-good': 'var(--score-good)',
            'score-ok': 'var(--warn)', 'score-low': 'var(--score-low)',
            'score-bad': 'var(--err)',
        };
        for (const n of [44, 45, 59, 60, 74, 75, 87, 88]) {
            expect(scoreColor(n)).toBe(tokenFor[scoreClass(n)]);
        }
    });
});
