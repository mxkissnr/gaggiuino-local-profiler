// The crop editor's pure zoom/pan math (#286, generalised to a width/height
// box for the 3:4 bean crop, #1346). image-crop.ts pulls in the i18n/state
// chain, which reads localStorage at module load — stub it so the module
// graph imports under vitest's node environment.
import { describe, it, expect } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };

const {
  coverBaseScale, clampOffset, cropExportSize,
  viewToCrop, cropToView, isValidCrop, cropQuery, originalExportSize,
} = await import('../public-src/components/image-crop.js');

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
    // 100x100 zoomed to scale 4.8 => 480x480; both mins are 320 - 480 = -160.
    expect(clampOffset(20, 20, 100, 100, 4.8, 320, 320)).toEqual({ x: 0, y: 0 });
    expect(clampOffset(-999, -999, 100, 100, 4.8, 320, 320)).toEqual({ x: -160, y: -160 });
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

describe('cropExportSize (#1836)', () => {
  it('exports a 1600 px square for a large source', () => {
    // A 4000x3000 photo in the 320 px square preview: ~9 source px per
    // preview px, far more than the 5x the export needs.
    expect(cropExportSize('square', coverBaseScale(4000, 3000, 320, 320)))
      .toEqual({ width: 1600, height: 1600, factor: 5 });
  });

  it('exports 1200x1600 for a large source in the portrait shape', () => {
    const out = cropExportSize('portrait', coverBaseScale(4000, 3000, 240, 320));
    expect(out).toEqual({ width: 1200, height: 1600, factor: 5 });
  });

  it('never upscales a source smaller than the export', () => {
    // 320 preview px holding only 320 source px: the export stays at the
    // source's own resolution instead of doubling it.
    const out = cropExportSize('square', 1);
    expect(out).toEqual({ width: 320, height: 320, factor: 1 });
    const portrait = cropExportSize('portrait', 1);
    expect(portrait).toEqual({ width: 240, height: 320, factor: 1 });
  });

  it('caps the export at the source resolution in between', () => {
    // 2x source density => 640x640, still under the 1600 target.
    expect(cropExportSize('square', 0.5)).toEqual({ width: 640, height: 640, factor: 2 });
  });

  it('keeps the aspect ratio of the box', () => {
    const out = cropExportSize('portrait', 0.03);
    expect(out.width / out.height).toBeCloseTo(3 / 4);
  });
});

describe('viewToCrop (#1845)', () => {
  const box = (nw: number, nh: number, bw: number, bh: number, zoom: number) => {
    const scale = coverBaseScale(nw, nh, bw, bh) * zoom;
    return { scale, offsetX: (bw - nw * scale) / 2, offsetY: (bh - nh * scale) / 2 };
  };

  it('reports the centred zoom-1 view of a landscape photo in the square box', () => {
    const { scale, offsetX, offsetY } = box(4000, 3000, 320, 320, 1);
    expect(viewToCrop(offsetX, offsetY, scale, 4000, 3000, 320, 320))
      .toEqual({ x: 0.125, y: 0, w: 0.75, h: 1 });
  });

  it('reports the centred zoom-1 view of a landscape photo in the portrait box', () => {
    // 240/320 box on 4000x3000: the height decides the cover, so the sides go.
    const { scale, offsetX, offsetY } = box(4000, 3000, 240, 320, 1);
    const crop = viewToCrop(offsetX, offsetY, scale, 4000, 3000, 240, 320);
    expect(crop.w).toBeCloseTo(240 / (4000 * scale), 6);
    expect(crop.h).toBe(1);
    expect(crop.y).toBe(0);
    expect(crop.x).toBeCloseTo((1 - crop.w) / 2, 6);
  });

  it('keeps a landscape photo inside the unit square at zoom 1', () => {
    const { scale, offsetX, offsetY } = box(4000, 3000, 320, 320, 1);
    expect(viewToCrop(offsetX, offsetY, scale, 4000, 3000, 320, 320).y).toBe(0);
  });

  it('always produces a server-accepted crop', () => {
    const cases: [number, number, number, number][] = [[4000, 3000, 320, 320], [3000, 4000, 320, 320], [4000, 3000, 240, 320], [500, 2000, 240, 320]];
    for (const [nw, nh, bw, bh] of cases) {
      for (const zoom of [1, 1.7, 4]) {
        const scale = coverBaseScale(nw, nh, bw, bh) * zoom;
        const offsets: [number, number][] = [[0, 0], [-9999, -9999], [(bw - nw * scale) / 2, (bh - nh * scale) / 2]];
        for (const [ox, oy] of offsets) {
          expect(isValidCrop(viewToCrop(ox, oy, scale, nw, nh, bw, bh))).toBe(true);
        }
      }
    }
  });
});

describe('cropToView round trip (#1845)', () => {
  const sizes: [number, number][] = [[4000, 3000], [3000, 4000], [1600, 1600], [500, 2000]];
  const boxes: [number, number][] = [[320, 320], [240, 320]];

  it('recovers the crop and the zoom from every tested view', () => {
    for (const [nw, nh] of sizes) {
      for (const [bw, bh] of boxes) {
        const base = coverBaseScale(nw, nh, bw, bh);
        for (const zoom of [1, 1.7, 4]) {
          const scale = base * zoom;
          const scaledW = nw * scale;
          const scaledH = nh * scale;
          const offsets: [number, number][] = [
            [(bw - scaledW) / 2, (bh - scaledH) / 2],
            [0, 0],
            [-1e9, -1e9],
          ];
          for (const [ox, oy] of offsets) {
            const view = clampOffset(ox, oy, nw, nh, scale, bw, bh);
            const crop = viewToCrop(view.x, view.y, scale, nw, nh, bw, bh);
            const back = cropToView(crop, nw, nh, bw, bh);
            expect(back.zoom).toBeCloseTo(zoom, 4);
            const again = viewToCrop(back.offsetX, back.offsetY, base * back.zoom, nw, nh, bw, bh);
            expect(again.x).toBeCloseTo(crop.x, 5);
            expect(again.y).toBeCloseTo(crop.y, 5);
            expect(again.w).toBeCloseTo(crop.w, 5);
            expect(again.h).toBeCloseTo(crop.h, 5);
          }
        }
      }
    }
  });
});

describe('isValidCrop (#1845)', () => {
  it('applies the server rule with its 1e-3 far-edge tolerance', () => {
    expect(isValidCrop({ x: 0.2, y: 0, w: 0.8005, h: 1 })).toBe(true);
    expect(isValidCrop({ x: 0.2, y: 0, w: 0.802, h: 1 })).toBe(false);
  });

  it('rejects anything the server would reject', () => {
    const bad: unknown[] = [
      null, undefined, 'crop', 42, {},
      { x: NaN, y: 0, w: 1, h: 1 },
      { x: Infinity, y: 0, w: 1, h: 1 },
      { x: -0.1, y: 0, w: 1, h: 1 },
      { x: 0, y: -0.1, w: 1, h: 1 },
      { x: 0, y: 0, w: 0, h: 1 },
      { x: 0, y: 0, w: 1, h: 0 },
      { x: 0, y: 0, w: 1.1, h: 1 },
      { x: '0', y: 0, w: 1, h: 1 },
      { x: 0, y: 0, w: '1', h: 1 },
    ];
    for (const c of bad) expect(isValidCrop(c)).toBe(false);
  });
});

describe('cropQuery (#1845)', () => {
  const DECIMALS = /^\d+(\.\d+)?(,\d+(\.\d+)?){3}$/;

  it('prints four plain decimals', () => {
    expect(cropQuery({ x: 0.125, y: 0, w: 0.75, h: 1 })).toBe('0.125,0,0.75,1');
    expect(cropQuery({ x: 0.125, y: 0, w: 0.75, h: 1 })).toMatch(DECIMALS);
  });

  it('never prints exponent notation for a tiny value', () => {
    const q = cropQuery({ x: 1e-7, y: 0, w: 0.75, h: 1 });
    expect(String(1e-7)).toBe('1e-7');
    expect(q).toMatch(DECIMALS);
  });

  it('matches the plain-decimal shape for arbitrary fractions', () => {
    for (const c of [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, { x: 0, y: 0, w: 1, h: 1 }, { x: 0.123456, y: 0.000001, w: 0.876544, h: 0.999999 }]) {
      expect(cropQuery(c)).toMatch(DECIMALS);
    }
  });
});

describe('originalExportSize (#1845)', () => {
  it('caps the long edge at 1600 px and keeps the aspect', () => {
    expect(originalExportSize(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(originalExportSize(3000, 4000)).toEqual({ width: 1200, height: 1600 });
  });

  it('never upscales a source under the cap', () => {
    expect(originalExportSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(originalExportSize(1600, 900)).toEqual({ width: 1600, height: 900 });
  });
});
