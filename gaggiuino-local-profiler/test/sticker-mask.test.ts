import { describe, it, expect } from 'vitest';
import {
  resizeBilinear,
  largestComponent,
  fillHoles,
  union,
  subtract,
  erode,
  dilate,
  openMask,
  rgbToLab8,
  baseColourTrim,
  combineMasks,
  applyTap,
  paintBrush,
  featherAlpha,
} from '../public-src/components/sticker/mask.js';

function onesCount(m: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i] !== 0) n++;
  return n;
}

function fillRect(m: { [index: number]: number }, w: number, x0: number, y0: number, rw: number, rh: number): void {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) m[y * w + x] = 1;
  }
}

function rgbaFill(w: number, h: number, rgb: [number, number, number]): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    a[i * 4] = rgb[0];
    a[i * 4 + 1] = rgb[1];
    a[i * 4 + 2] = rgb[2];
    a[i * 4 + 3] = 255;
  }
  return a;
}

function setPixel(rgba: Uint8ClampedArray, i: number, r: number, g: number, b: number): void {
  rgba[i * 4] = r;
  rgba[i * 4 + 1] = g;
  rgba[i * 4 + 2] = b;
  rgba[i * 4 + 3] = 255;
}

describe('resizeBilinear', () => {
  it('keeps a constant field constant at a different size', () => {
    const src = new Float32Array([0.25, 0.25, 0.25, 0.25]);
    const out = resizeBilinear(src, 2, 2, 4, 4);
    expect(out.length).toBe(16);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(0.25);
  });

  it('returns an empty array for a degenerate target', () => {
    expect(resizeBilinear(new Float32Array([1]), 1, 1, 0, 0).length).toBe(0);
  });
});

describe('largestComponent', () => {
  it('picks the bigger of two separate squares', () => {
    const w = 10;
    const m = new Uint8Array(w * w);
    fillRect(m, w, 0, 0, 2, 2);
    fillRect(m, w, 5, 5, 3, 3);
    const out = largestComponent(m, w, w);
    expect(onesCount(out)).toBe(9);
    expect(out[6 * w + 6]).toBe(1);
    expect(out[0]).toBe(0);
  });

  it('leaves an all-zero mask all-zero', () => {
    const m = new Uint8Array(25);
    expect(onesCount(largestComponent(m, 5, 5))).toBe(0);
  });

  it('does not mutate its input', () => {
    const m = new Uint8Array(25);
    fillRect(m, 5, 1, 1, 3, 3);
    const before = Array.from(m);
    largestComponent(m, 5, 5);
    expect(Array.from(m)).toEqual(before);
  });
});

describe('fillHoles', () => {
  it('fills the interior of a closed ring', () => {
    const w = 5;
    const m = new Uint8Array(w * w);
    for (let i = 0; i < w; i++) {
      m[i] = 1;
      m[(w - 1) * w + i] = 1;
      m[i * w] = 1;
      m[i * w + w - 1] = 1;
    }
    expect(onesCount(fillHoles(m, w, w))).toBe(25);
  });

  it('does not fill an open C shape', () => {
    const w = 5;
    const m = new Uint8Array(w * w);
    for (let y = 1; y < w; y++) {
      m[y * w] = 1;
      m[y * w + w - 1] = 1;
    }
    for (let x = 0; x < w; x++) m[(w - 1) * w + x] = 1;
    const out = fillHoles(m, w, w);
    expect(onesCount(out)).toBe(11);
    expect(out[2 * w + 2]).toBe(0);
  });
});

describe('union / subtract', () => {
  it('combines and removes disjoint masks', () => {
    const a = new Uint8Array([1, 0, 1, 0]);
    const b = new Uint8Array([0, 0, 1, 1]);
    expect(Array.from(union(a, b))).toEqual([1, 0, 1, 1]);
    expect(Array.from(subtract(a, b))).toEqual([1, 0, 0, 0]);
  });
});

describe('erode / dilate / openMask', () => {
  it('shrinks and grows a solid square by the radius', () => {
    const w = 20;
    const m = new Uint8Array(w * w);
    fillRect(m, w, 5, 5, 10, 10);
    expect(onesCount(erode(m, w, w, 2))).toBe(6 * 6);
    expect(onesCount(dilate(erode(m, w, w, 2), w, w, 2))).toBe(10 * 10);
  });

  it('keeps a 30px square but removes a 2px speckle', () => {
    const w = 40;
    const m = new Uint8Array(w * w);
    fillRect(m, w, 5, 5, 30, 30);
    fillRect(m, w, 35, 35, 2, 2);
    const out = openMask(m, w, w, 4);
    expect(onesCount(out)).toBe(900);
    expect(out[20 * w + 20]).toBe(1);
    expect(out[35 * w + 35]).toBe(0);
  });
});

describe('rgbToLab8', () => {
  it('maps white and black to the OpenCV 8-bit Lab convention', () => {
    expect(rgbToLab8(255, 255, 255)[0]).toBeCloseTo(255, 3);
    expect(rgbToLab8(255, 255, 255)[1]).toBeCloseTo(128, 3);
    expect(rgbToLab8(255, 255, 255)[2]).toBeCloseTo(128, 3);
    expect(rgbToLab8(0, 0, 0)[0]).toBeCloseTo(0, 3);
    expect(rgbToLab8(0, 0, 0)[1]).toBeCloseTo(128, 3);
    expect(rgbToLab8(0, 0, 0)[2]).toBeCloseTo(128, 3);
  });
});

describe('baseColourTrim', () => {
  const w = 60;
  const h = 80;

  function bagWithReflection(): { mask: Uint8Array; rgba: Uint8ClampedArray } {
    const mask = new Uint8Array(w * h);
    const rgba = rgbaFill(w, h, [128, 128, 128]);
    for (let y = 5; y <= 44; y++) {
      for (let x = 10; x <= 49; x++) {
        mask[y * w + x] = 1;
        setPixel(rgba, y * w + x, 245, 245, 245);
      }
    }
    for (let y = 45; y <= 64; y++) {
      for (let x = 10; x <= 49; x++) {
        mask[y * w + x] = 1;
        setPixel(rgba, y * w + x, 40, 40, 40);
      }
    }
    return { mask, rgba };
  }

  it('drops the dark reflection rows and keeps the white bag', () => {
    const { mask, rgba } = bagWithReflection();
    const out = baseColourTrim(mask, rgba, w, h);
    expect(onesCount(out)).toBe(40 * 40);
    expect(out[20 * w + 20]).toBe(1);
    expect(out[50 * w + 20]).toBe(0);
  });

  it('returns the input unchanged when the eroded core is empty', () => {
    const thin = new Uint8Array(20);
    thin.fill(1);
    const out = baseColourTrim(thin, rgbaFill(20, 1, [200, 200, 200]), 20, 1);
    expect(Array.from(out)).toEqual(Array.from(thin));
  });

  it('does not mutate its inputs', () => {
    const { mask, rgba } = bagWithReflection();
    const maskBefore = Array.from(mask);
    const rgbaBefore = Array.from(rgba);
    baseColourTrim(mask, rgba, w, h);
    expect(Array.from(mask)).toEqual(maskBefore);
    expect(Array.from(rgba)).toEqual(rgbaBefore);
  });
});

describe('combineMasks', () => {
  it('keeps a solid salient block when the SAM mask is empty', () => {
    const w = 40;
    const isn = new Float32Array(w * w);
    fillRect(isn, w, 10, 10, 20, 20);
    const sam = new Uint8Array(w * w);
    const out = combineMasks(isn, sam, rgbaFill(w, w, [200, 200, 200]), w, w);
    expect(onesCount(out)).toBe(400);
  });
});

describe('applyTap', () => {
  it('adds a disjoint tap region', () => {
    const w = 10;
    const m = new Uint8Array(w * w);
    fillRect(m, w, 2, 2, 3, 3);
    const tap = new Uint8Array(w * w);
    fillRect(tap, w, 6, 6, 2, 2);
    expect(onesCount(applyTap(m, tap, 'add', w, w))).toBe(13);
  });

  it('removes a tap region grown by one pixel', () => {
    const w = 10;
    const m = new Uint8Array(w * w);
    fillRect(m, w, 2, 2, 3, 3);
    const tap = new Uint8Array(w * w);
    tap[4 * w + 4] = 1;
    // dilate(tap, 1) covers (3..5)x(3..5); its overlap with the square is 2x2.
    expect(onesCount(applyTap(m, tap, 'remove', w, w))).toBe(5);
  });
});

describe('paintBrush', () => {
  it('paints a filled disc and clears it again', () => {
    const w = 10;
    const painted = paintBrush(new Uint8Array(w * w), w, w, 5, 5, 2, 1);
    expect(onesCount(painted)).toBe(13);
    expect(painted[5 * w + 5]).toBe(1);
    expect(painted[0]).toBe(0);
    const cleared = paintBrush(painted, w, w, 5, 5, 1, 0);
    expect(onesCount(cleared)).toBe(8);
  });

  it('does not mutate its input', () => {
    const m = new Uint8Array(25);
    const before = Array.from(m);
    paintBrush(m, 5, 5, 2, 2, 1, 1);
    expect(Array.from(m)).toEqual(before);
  });
});

describe('featherAlpha', () => {
  it('blurs a single dot into its 3x3 neighbourhood', () => {
    const m = new Uint8Array(9);
    m[4] = 1;
    const out = featherAlpha(m, 3, 3);
    expect(out[4]).toBeCloseTo(255 / 9, 3);
    expect(out[0]).toBeCloseTo(255 / 4, 3);
  });
});
