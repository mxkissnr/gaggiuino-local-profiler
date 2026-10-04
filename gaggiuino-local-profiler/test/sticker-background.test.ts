import { describe, it, expect } from 'vitest';
import {
  plainBackgroundBox,
  cropRgba,
  pasteMask,
  alphaMask,
  meanBorderColour,
  type CropBox,
} from '../public-src/components/sticker/background.js';

function filled(
  w: number,
  h: number,
  rgb: [number, number, number],
  alpha = 255,
): Uint8ClampedArray {
  const img = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    img[i * 4] = rgb[0];
    img[i * 4 + 1] = rgb[1];
    img[i * 4 + 2] = rgb[2];
    img[i * 4 + 3] = alpha;
  }
  return img;
}

function fillRect(
  img: Uint8ClampedArray,
  w: number,
  x0: number,
  y0: number,
  rw: number,
  rh: number,
  rgb: [number, number, number],
): void {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const p = (y * w + x) * 4;
      img[p] = rgb[0];
      img[p + 1] = rgb[1];
      img[p + 2] = rgb[2];
      img[p + 3] = 255;
    }
  }
}

function contains(box: CropBox, x0: number, y0: number, x1: number, y1: number): boolean {
  return box.x <= x0 && box.y <= y0 && box.x + box.width >= x1 && box.y + box.height >= y1;
}

/** Deterministic pseudo-random noise, so a busy-photo test never flakes. */
function noisy(w: number, h: number, seed: number): Uint8ClampedArray {
  const img = new Uint8ClampedArray(w * h * 4);
  let state = seed;
  for (let i = 0; i < w * h; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    img[i * 4] = state & 255;
    img[i * 4 + 1] = (state >> 8) & 255;
    img[i * 4 + 2] = (state >> 16) & 255;
    img[i * 4 + 3] = 255;
  }
  return img;
}

describe('plainBackgroundBox', () => {
  const w = 100;
  const h = 100;

  it('finds a tight box around a dark product on white', () => {
    const img = filled(w, h, [255, 255, 255]);
    fillRect(img, w, 30, 30, 40, 40, [20, 20, 20]);

    const box = plainBackgroundBox(img, w, h);

    expect(box).not.toBeNull();
    expect(contains(box!, 30, 30, 69, 69)).toBe(true);
    expect(box!.width * box!.height).toBeLessThan(w * h * 0.6);
  });

  it('treats a vertical gradient background as plain, not as product', () => {
    const img = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const g = Math.round(200 + (40 * y) / (h - 1));
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        img[p] = g;
        img[p + 1] = g;
        img[p + 2] = g;
        img[p + 3] = 255;
      }
    }
    fillRect(img, w, 30, 30, 40, 40, [128, 128, 128]);

    const box = plainBackgroundBox(img, w, h);

    expect(box).not.toBeNull();
    expect(contains(box!, 30, 30, 69, 69)).toBe(true);
  });

  it('finds a white bag on a white background via its soft edge', () => {
    const img = filled(w, h, [255, 255, 255]);
    fillRect(img, w, 30, 30, 40, 40, [225, 225, 225]);
    fillRect(img, w, 31, 31, 38, 38, [245, 245, 245]);

    const box = plainBackgroundBox(img, w, h);

    expect(box).not.toBeNull();
    expect(contains(box!, 30, 30, 69, 69)).toBe(true);
  });

  it('returns null for a busy background', () => {
    expect(plainBackgroundBox(noisy(w, h, 7), w, h)).toBeNull();
  });

  it('returns null when the product fills almost the whole frame', () => {
    const img = filled(w, h, [255, 255, 255]);
    fillRect(img, w, 4, 4, 92, 92, [0, 0, 0]);
    expect(plainBackgroundBox(img, w, h)).toBeNull();
  });

  it('returns null for an empty plain image', () => {
    expect(plainBackgroundBox(filled(w, h, [255, 255, 255]), w, h)).toBeNull();
  });

  it('finds the box for a transparent PNG', () => {
    const img = filled(w, h, [0, 0, 0], 0);
    fillRect(img, w, 30, 30, 40, 40, [50, 120, 200]);

    const box = plainBackgroundBox(img, w, h);

    expect(box).not.toBeNull();
    expect(contains(box!, 30, 30, 69, 69)).toBe(true);
  });
});

describe('alphaMask', () => {
  it('returns null for a fully opaque image', () => {
    expect(alphaMask(filled(4, 4, [1, 2, 3]), 4, 4)).toBeNull();
  });

  it('marks transparent pixels as zero', () => {
    const img = filled(4, 4, [1, 2, 3], 0);
    img[3] = 255;
    const mask = alphaMask(img, 4, 4);
    expect(mask).not.toBeNull();
    expect(mask![0]).toBe(1);
    expect(mask![1]).toBe(0);
    expect(mask!.length).toBe(16);
  });
});

describe('cropRgba', () => {
  it('copies the box and fills transparent pixels with the fill colour', () => {
    const img = filled(10, 10, [0, 0, 0], 0);
    fillRect(img, 10, 2, 3, 4, 5, [200, 210, 220]);
    const box: CropBox = { x: 2, y: 3, width: 4, height: 5 };

    const crop = cropRgba(img, 10, 10, box, [1, 2, 3]);

    expect(crop.length).toBe(4 * 5 * 4);
    expect([crop[0], crop[1], crop[2], crop[3]]).toEqual([200, 210, 220, 255]);
  });

  it('replaces transparent pixels inside the box', () => {
    const img = filled(10, 10, [0, 0, 0], 0);
    fillRect(img, 10, 2, 3, 4, 5, [200, 210, 220]);
    const box: CropBox = { x: 0, y: 0, width: 3, height: 3 };

    const crop = cropRgba(img, 10, 10, box, [7, 8, 9]);

    expect([crop[0], crop[1], crop[2], crop[3]]).toEqual([7, 8, 9, 255]);
  });
});

describe('pasteMask', () => {
  it('places the sub-mask at the box offset and zeroes the rest', () => {
    const box: CropBox = { x: 2, y: 3, width: 3, height: 2 };
    const sub = Uint8Array.from([1, 0, 1, 0, 1, 0]);

    const full = pasteMask(sub, box, 6, 6);

    expect(full.length).toBe(36);
    expect(full[3 * 6 + 2]).toBe(1);
    expect(full[3 * 6 + 3]).toBe(0);
    expect(full[3 * 6 + 4]).toBe(1);
    expect(full[4 * 6 + 2]).toBe(0);
    expect(full[4 * 6 + 3]).toBe(1);
    expect(full[4 * 6 + 4]).toBe(0);
    expect(full[0]).toBe(0);
  });
});

describe('meanBorderColour', () => {
  it('returns the border colour of a plain image', () => {
    expect(meanBorderColour(filled(8, 8, [200, 100, 50]), 8, 8)).toEqual([200, 100, 50]);
  });
});
