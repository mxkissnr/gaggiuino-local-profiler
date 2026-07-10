import { describe, it, expect } from 'vitest';
import { layoutLeaderLabels } from '../public-src/flavor-wheel-labels.js';

describe('layoutLeaderLabels', () => {
  it('leaves a single label untouched', () => {
    const [item] = layoutLeaderLabels([{ id: 'a', angle: 0, labelY: 0 }]);
    expect(item.y).toBe(0);
    expect(item.side).toBe('right');
  });

  it('splits into left/right hemispheres by the wedge angle', () => {
    const [right, left] = layoutLeaderLabels([
      { id: 'right', angle: 0.1, labelY: 0 },
      { id: 'left', angle: Math.PI - 0.1, labelY: 0 },
    ]);
    expect(right.side).toBe('right');
    expect(left.side).toBe('left');
  });

  it('pushes apart two overlapping labels on the same side to at least minGap', () => {
    // Two right-side wedges (angles near 0) whose naive labelY lands
    // 5px apart — well under the 20px minimum.
    const result = layoutLeaderLabels([
      { id: 'a', angle: 0.05, labelY: 100 },
      { id: 'b', angle: 0.06, labelY: 105 },
    ], { minGap: 20 });
    const [a, b] = result.sort((x, y) => x.y - y.y);
    expect(b.y - a.y).toBeGreaterThanOrEqual(20 - 1e-6);
  });

  it('resolves a dense cluster of many overlapping labels with no pair closer than minGap', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      angle: 0.2 + i * 0.01, // all clustered on the right hemisphere
      labelY: 50, // identical initial target — worst-case overlap
    }));
    const result = layoutLeaderLabels(items, { minGap: 15 });
    const ys = result.map(r => r.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(15 - 1e-6);
    }
  });

  it('keeps left and right hemispheres independent of each other', () => {
    // A crowded right side must not push anything into the left side's y-range bookkeeping.
    const items = [
      { id: 'r1', angle: 0.1, labelY: 0 },
      { id: 'r2', angle: 0.1, labelY: 2 },
      { id: 'l1', angle: Math.PI - 0.1, labelY: 0 },
    ];
    const result = layoutLeaderLabels(items, { minGap: 20 });
    const left = result.filter(r => r.side === 'left');
    const right = result.filter(r => r.side === 'right');
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(2);
    // The lone left-side label should be untouched since it has no left-side neighbor.
    expect(left[0].y).toBe(0);
  });

  it('falls back to sin(angle) * r when labelY is not provided', () => {
    const [item] = layoutLeaderLabels([{ id: 'a', angle: Math.PI / 2, r: 40 }]);
    expect(item.y).toBeCloseTo(40, 5);
  });
});
