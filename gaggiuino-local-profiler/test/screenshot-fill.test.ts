import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    emptyBandFraction, fillProblem, aspectClip, MAX_EMPTY_FRACTION,
} from '../scripts/screenshot-fill.mts';

// Part of #2189: the pure helpers behind the README fill check. The screenshot
// script boots a server at import time (and its harness creates a temp dir), so
// it is never imported here — only its import-free helper module and its text.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('emptyBandFraction (#2189)', () => {
    it('is zero when content reaches the frame bottom', () => {
        expect(emptyBandFraction([{ top: 60, bottom: 950 }], { top: 0, height: 900 })).toBe(0);
    });

    it('measures the band below the lowest content', () => {
        expect(emptyBandFraction([{ top: 100, bottom: 300 }, { top: 600, bottom: 680 }], { top: 0, height: 900 }))
            .toBeCloseTo(220 / 900);
    });

    it('ignores empty boxes and boxes outside the frame', () => {
        const boxes = [
            { top: 0, bottom: 0 },
            { top: 950, bottom: 1000 },
            { top: -200, bottom: -10 },
            { top: 50, bottom: 450 },
        ];
        expect(emptyBandFraction(boxes, { top: 0, height: 900 })).toBe(0.5);
    });

    it('counts an image without content as empty', () => {
        expect(emptyBandFraction([], { top: 0, height: 900 })).toBe(1);
    });

    it('measures against a cropped frame', () => {
        expect(emptyBandFraction([{ top: 120, bottom: 775 }], { top: 110, height: 680 }))
            .toBeCloseTo(15 / 680);
    });
});

describe('fillProblem (#2189)', () => {
    it('fails a view that is too short and names it', () => {
        expect(fillProblem('library', [{ top: 60, bottom: 680 }], { top: 0, height: 900 }))
            .toBe('library: 24.4% of the frame height is empty background below the content (limit 10%)');
    });

    it('accepts exactly the limit', () => {
        expect(MAX_EMPTY_FRACTION).toBe(0.1);
        expect(fillProblem('maintenance', [{ top: 60, bottom: 810 }], { top: 0, height: 900 })).toBeNull();
        expect(fillProblem('maintenance', [{ top: 60, bottom: 809 }], { top: 0, height: 900 }))
            .toMatch(/^maintenance: 10\.1%/);
    });
});

describe('aspectClip (#2189)', () => {
    it('crops a centred dialog to the window aspect', () => {
        expect(aspectClip({ x: 220, y: 110, width: 960, height: 680 }, { width: 1400, height: 900 }))
            .toEqual({ x: 171, y: 110, width: 1058, height: 680 });
    });

    it('keeps the crop inside the window', () => {
        expect(aspectClip({ x: 1200, y: 100, width: 200, height: 600 }, { width: 1400, height: 900 }))
            .toEqual({ x: 467, y: 100, width: 933, height: 600 });
    });

    it('falls back to the whole window when the crop does not fit', () => {
        expect(aspectClip({ x: 100, y: 50, width: 1200, height: 880 }, { width: 1400, height: 900 }))
            .toEqual({ x: 0, y: 0, width: 1400, height: 900 });
    });
});

describe('README screenshot table (#2189)', () => {
    it('fill-checks every image of the README screenshot table', () => {
        const readme = read('../../README.md');
        const start = readme.indexOf('## Screenshots');
        expect(start).toBeGreaterThanOrEqual(0);
        const table = readme.slice(start, readme.indexOf('</table>', start));
        const names = [...table.matchAll(/docs\/screenshots\/([\w-]+)\.png/g)].map(m => m[1] ?? '');
        expect(names).toEqual([
            'library', 'bean-sheet', 'flavor-wheel', 'analytics', 'analytics-machines', 'maintenance',
        ]);
        const script = read('../scripts/screenshots.mts');
        for (const name of names) {
            expect(script).toContain(`checkFill(page, '${name}',`);
        }
    });
});
