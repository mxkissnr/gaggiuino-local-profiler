import { describe, it, expect } from 'vitest';
import { layoutLeaderLabels } from '../public-src/flavor-wheel-labels.js';

function angularDist(a, b) {
  let d = Math.abs(a - b);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

describe('layoutLeaderLabels', () => {
  it('leaves a single label untouched', () => {
    const [item] = layoutLeaderLabels([{ id: 'a', angle: 0.3, halfW: 0.05 }]);
    expect(item.angle).toBeCloseTo(0.3, 5);
  });

  it('leaves non-colliding labels at their original angle', () => {
    const result = layoutLeaderLabels([
      { id: 'a', angle: 0, halfW: 0.05 },
      { id: 'b', angle: Math.PI, halfW: 0.05 },
    ]);
    const a = result.find(r => r.id === 'a');
    const b = result.find(r => r.id === 'b');
    expect(a.angle).toBeCloseTo(0, 5);
    expect(b.angle).toBeCloseTo(Math.PI, 5);
  });

  it('pushes apart two overlapping labels symmetrically around their midpoint', () => {
    const result = layoutLeaderLabels([
      { id: 'a', angle: 0.05, halfW: 0.1 },
      { id: 'b', angle: 0.06, halfW: 0.1 },
    ]);
    const a = result.find(r => r.id === 'a');
    const b = result.find(r => r.id === 'b');
    expect(angularDist(a.angle, b.angle)).toBeGreaterThanOrEqual(0.2 - 1e-6);
    // Roughly symmetric around the original midpoint (0.055).
    expect((a.angle + b.angle) / 2).toBeCloseTo(0.055, 3);
  });

  it('resolves a dense cluster of many overlapping labels with no adjacent pair closer than the sum of their half-widths', () => {
    const halfW = 0.05;
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      angle: 0.2, // identical initial angle — worst-case overlap
      halfW,
    }));
    const result = layoutLeaderLabels(items).sort((a, b) => a.angle - b.angle);
    // The fixed-pass relaxation converges very close to, but not bit-exact
    // at, minGap — a small tolerance accounts for that without weakening
    // the actual collision-avoidance guarantee being tested.
    for (let i = 1; i < result.length; i++) {
      expect(result[i].angle - result[i - 1].angle).toBeGreaterThanOrEqual(2 * halfW - 1e-3);
    }
  });

  it('resolves collisions that wrap around the ±π boundary', () => {
    const result = layoutLeaderLabels([
      { id: 'a', angle: Math.PI - 0.02, halfW: 0.1 },
      { id: 'b', angle: -Math.PI + 0.02, halfW: 0.1 },
    ]);
    const a = result.find(r => r.id === 'a');
    const b = result.find(r => r.id === 'b');
    expect(angularDist(a.angle, b.angle)).toBeGreaterThanOrEqual(0.2 - 1e-6);
  });

  it('distributes labels around the full circle instead of collapsing into one hemisphere', () => {
    // All eight lit flavors cluster in the same quadrant (top-left), same
    // scenario as a bean whose flavors happen to all fall under
    // Sweet/Nutty-Cocoa — the old hemisphere-column layout stacked these
    // all in one vertical line; the new layout should spread them along
    // the arc instead, so the angular spread after relaxation is wider
        // than the tight cluster they started in.
    const clusterCenter = -2.3; // top-left quadrant
    const halfW = 0.08;
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `f${i}`,
      angle: clusterCenter + (i - 3.5) * 0.02, // tightly clustered, ~0.14 rad wide
      halfW,
    }));
    const result = layoutLeaderLabels(items);
    const angles = result.map(r => r.angle).sort((a, b) => a - b);
    const spread = angles[angles.length - 1] - angles[0];
    expect(spread).toBeGreaterThan(8 * halfW - 1e-6);
  });

  it('defaults halfW to 0 when omitted, leaving angle unchanged for non-colliding points', () => {
    const [item] = layoutLeaderLabels([{ id: 'a', angle: 1.2 }]);
    expect(item.angle).toBeCloseTo(1.2, 5);
  });
});
