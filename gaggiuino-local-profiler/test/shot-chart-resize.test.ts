import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// state/charts.ts reads state/index.ts, which touches localStorage at
// module-load time; stub it before the import below is evaluated.
vi.hoisted(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    const store = new Map<string, string>();
    g.localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k) : null),
        setItem: (k: string, v: string) => store.set(k, String(v)),
        removeItem: (k: string) => store.delete(k),
    };
});

import { chartBaseOptions, chartTimeTicks } from '../public-src/state/charts.js';

// #2097: with animations running, Chart.js stores a container resize and
// applies it on the next frame of its shared animation loop, so a stalled
// loop leaves the shot chart at the width of its first draw. The shot chart
// therefore has to take its responsive/aspect-ratio/animation options from
// the shared helper, like the P·Q, fullscreen and live charts do.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS_VIEW = readFileSync(join(__dirname, '../public-src/views/shots/index.ts'), 'utf8');
const FULLSCREEN_CHART = readFileSync(join(__dirname, '../public-src/views/shots/charts.ts'), 'utf8');
const LIVE_VIEW = readFileSync(join(__dirname, '../public-src/views/live.ts'), 'utf8');

describe('chartBaseOptions (#2097)', () => {
    it('fills the container and does not animate', () => {
        expect(chartBaseOptions()).toEqual({
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
        });
    });
});

describe('shot chart options (#2097)', () => {
    it('spreads the shared base options instead of setting its own', () => {
        const start = SHOTS_VIEW.indexOf("chartRegistry.set('chart', new Chart(ctx");
        expect(start).toBeGreaterThan(-1);
        const scales = SHOTS_VIEW.indexOf('scales:', start);
        expect(scales).toBeGreaterThan(start);
        const options = SHOTS_VIEW.slice(start, scales);

        expect(options).toContain('...chartRegistry.chartBaseOptions()');
        expect(options).not.toContain('responsive:');
        expect(options).not.toContain('maintainAspectRatio:');
        expect(options).not.toContain('animation:');
    });
});

describe('shot-time axes (#2201)', () => {
    it('chartTimeTicks draws 5-second mm:ss steps without the axis-end tick', () => {
        const ticks = chartTimeTicks();
        expect(ticks.stepSize).toBe(5);
        expect(ticks.includeBounds).toBe(false);
        expect(ticks.callback(34)).toBe('00:34');
        expect(ticks.callback('65')).toBe('01:05');
    });

    it('every shot-time axis takes its ticks from chartTimeTicks', () => {
        for (const src of [SHOTS_VIEW, FULLSCREEN_CHART, LIVE_VIEW]) {
            expect(src).toContain('...chartRegistry.chartTimeTicks()');
            expect(src).not.toMatch(/stepSize:\s*5\b/);
        }
    });
});
