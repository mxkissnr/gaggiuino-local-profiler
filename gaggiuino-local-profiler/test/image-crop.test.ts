// The crop editor's pure zoom/pan math (#286, generalised to a width/height
// box for the 3:4 bean crop, #1346). image-crop.js pulls in the i18n/state
// chain, which reads localStorage at module load — stub it so the module
// graph imports under vitest's node environment.
import { describe, it, expect } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };

const { coverBaseScale, clampOffset } = await import('../public-src/components/image-crop.js');

describe('coverBaseScale', () => {
  it('scales a landscape image to cover a square box', () => {
    expect(coverBaseScale(200, 100, 320, 320)).toBe(3.2);
  });

  it('scales a portrait image to cover a square box', () => {
    expect(coverBaseScale(100, 200, 320, 320)).toBe(3.2);
  });

  it('scales a wide landscape image to cover a 240x320 portrait box', () => {
    expect(coverBaseScale(400, 100, 240, 320)).toBe(3.2);
  });

  it('scales a tall portrait image to cover a 240x320 portrait box', () => {
    expect(coverBaseScale(100, 400, 240, 320)).toBe(2.4);
  });

  it('always leaves the scaled image at least as large as the box', () => {
    const cases: [number, number, number, number][] = [
      [200, 100, 320, 320],
      [100, 200, 320, 320],
      [400, 100, 240, 320],
      [100, 400, 240, 320],
      [240, 320, 240, 320],
      [320, 240, 240, 320],
    ];
    for (const [nw, nh, bw, bh] of cases) {
      const scale = coverBaseScale(nw, nh, bw, bh);
      expect(nw * scale).toBeGreaterThanOrEqual(bw - 1e-9);
      expect(nh * scale).toBeGreaterThanOrEqual(bh - 1e-9);
    }
  });
});

describe('clampOffset', () => {
  it('keeps a square box offset that is already in range', () => {
    // 200x100 at scale 3.2 => 640x320; box 320x320 => x in [-320, 0], y = 0.
    expect(clampOffset(-100, 50, 200, 100, 3.2, 320, 320)).toEqual({ x: -100, y: 0 });
  });

  it('clamps a square box offset back into range on both axes', () => {
    expect(clampOffset(20, 20, 100, 100, 3.2, 320, 320)).toEqual({ x: 0, y: 0 });
    expect(clampOffset(-999, -999, 100, 100, 3.2, 320, 320)).toEqual({ x: -320, y: -320 });
  });

  it('clamps a landscape image in a 240x320 box to [box - scaled, 0]', () => {
    // 400x100 at scale 3.2 => 1280x320; minX = 240 - 1280 = -1040, y = 0.
    expect(clampOffset(-500, 0, 400, 100, 3.2, 240, 320)).toEqual({ x: -500, y: 0 });
    expect(clampOffset(-9999, 0, 400, 100, 3.2, 240, 320)).toEqual({ x: -1040, y: 0 });
  });

  it('clamps a portrait image in a 240x320 box to [box - scaled, 0]', () => {
    // 100x400 at scale 2.4 => 240x960; x = 0, minY = 320 - 960 = -640.
    expect(clampOffset(0, -200, 100, 400, 2.4, 240, 320)).toEqual({ x: 0, y: -200 });
    expect(clampOffset(0, -9999, 100, 400, 2.4, 240, 320)).toEqual({ x: 0, y: -640 });
  });
});
