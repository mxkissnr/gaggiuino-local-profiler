import { describe, it, expect } from 'vitest';

// library-profile-editor.js imports state.js/i18n.js/api.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals needed so the module graph can be imported under vitest's node
// environment (same pattern as test/milk-deduct-gate.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { _synthesizeSeries } = await import('../public-src/views/library-profile-editor.js');

// Phase boundaries land on the same x (e.g. phase 1 ends and phase 2 starts
// both at x=1) — pick the point belonging to the given phase's type among
// the points at that x, in array order.
function pointAt(points, x, type, occurrence = 0) {
  return points.filter(pt => pt.x === x && pt.type === type)[occurrence];
}

describe('_synthesizeSeries', () => {
  it('carries a blank target.start over from the previous same-type phase\'s resolved end', () => {
    const points = _synthesizeSeries([
      { type: 'PRESSURE', target: { start: 0, end: 7, curve: 'LINEAR', time: 1000 } },
      { type: 'PRESSURE', target: { end: 3, curve: 'LINEAR', time: 1000 } }, // blank start
    ]);
    // Second occurrence at x=1: the first is phase 1's last point, the
    // second is phase 2's first point.
    expect(pointAt(points, 1, 'PRESSURE', 1).y).toBe(7); // carried over from phase 1's end
  });

  it('falls back to 0 when the previous phase has a different type', () => {
    const points = _synthesizeSeries([
      { type: 'FLOW', target: { start: 0, end: 4, curve: 'LINEAR', time: 1000 } },
      { type: 'PRESSURE', target: { end: 7, curve: 'LINEAR', time: 1000 } }, // blank start, type change
    ]);
    expect(pointAt(points, 1, 'PRESSURE', 0).y).toBe(0);
  });

  it('falls back to 0 for the first phase when target.start is blank', () => {
    const points = _synthesizeSeries([
      { type: 'PRESSURE', target: { end: 6, curve: 'LINEAR', time: 1000 } },
    ]);
    expect(points[0].y).toBe(0);
  });

  it('an explicit target.start always wins over carry-over', () => {
    const points = _synthesizeSeries([
      { type: 'PRESSURE', target: { start: 0, end: 7, curve: 'LINEAR', time: 1000 } },
      { type: 'PRESSURE', target: { start: 1, end: 3, curve: 'LINEAR', time: 1000 } },
    ]);
    expect(pointAt(points, 1, 'PRESSURE', 1).y).toBe(1);
  });

  it('skips skipped phases entirely, including for carry-over purposes', () => {
    const points = _synthesizeSeries([
      { type: 'PRESSURE', target: { start: 0, end: 7, curve: 'LINEAR', time: 1000 } },
      { type: 'PRESSURE', skip: true, target: { start: 0, end: 9, curve: 'LINEAR', time: 1000 } },
      { type: 'PRESSURE', target: { end: 2, curve: 'LINEAR', time: 1000 } }, // blank start
    ]);
    // Skipped phase contributes no time and is not the carry-over source.
    expect(pointAt(points, 1, 'PRESSURE', 1).y).toBe(7);
  });
});
