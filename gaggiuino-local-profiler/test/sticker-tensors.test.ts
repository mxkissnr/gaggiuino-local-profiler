import { describe, it, expect } from 'vitest';
import {
  isnetInput,
  isnetOutputToAlpha,
  samResizeDims,
  samInput,
  samPoints,
  samLabels,
  autoPromptPoints,
  bestMaskIndex,
  samMaskToFull,
} from '../public-src/components/sticker/tensors.js';

const ISNET = 1024 * 1024;
const SAM = 1024 * 1024;

describe('isnetInput', () => {
  it('lays out CHW and scales a known pixel', () => {
    const rgba = new Uint8ClampedArray(ISNET * 4);
    // pixel 1: r=255, g=0, b=0, a=255
    rgba[4] = 255;
    rgba[7] = 255;
    const out = isnetInput(rgba);
    expect(out.length).toBe(3 * ISNET);
    expect(out[0]).toBeCloseTo(-0.5, 6);
    expect(out[ISNET]).toBeCloseTo(-0.5, 6);
    expect(out[2 * ISNET]).toBeCloseTo(-0.5, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
    expect(out[ISNET + 1]).toBeCloseTo(-0.5, 6);
  });
});

describe('isnetOutputToAlpha', () => {
  it('does not divide by zero on a flat output', () => {
    const out = new Float32Array(ISNET).fill(0.3);
    const alpha = isnetOutputToAlpha(out, 4, 4);
    expect(alpha.length).toBe(16);
    for (let i = 0; i < alpha.length; i++) {
      expect(Number.isNaN(alpha[i]!)).toBe(false);
      expect(alpha[i]).toBeCloseTo(0, 6);
    }
  });

  it('min-max normalises a stepped output', () => {
    const out = new Float32Array(ISNET);
    for (let i = ISNET / 2; i < ISNET; i++) out[i] = 1;
    const alpha = isnetOutputToAlpha(out, 4, 4);
    expect(alpha[0]).toBeCloseTo(0, 6);
    expect(alpha[15]).toBeCloseTo(1, 6);
  });
});

describe('samResizeDims', () => {
  it('keeps a long side of 1024 unchanged', () => {
    const d = samResizeDims(577, 1024);
    expect(d.scale).toBeCloseTo(1, 9);
    expect(d.rw).toBe(577);
    expect(d.rh).toBe(1024);
  });

  it('scales the long side to 1024', () => {
    const d = samResizeDims(2048, 1024);
    expect(d.scale).toBeCloseTo(0.5, 9);
    expect(d.rw).toBe(1024);
    expect(d.rh).toBe(512);
  });
});

describe('samInput', () => {
  it('zero-pads and applies the ImageNet formula to one pixel', () => {
    const rw = 2;
    const rh = 2;
    const rgba = new Uint8ClampedArray(rw * rh * 4);
    rgba[0] = 255;
    rgba[3] = 255;
    const out = samInput(rgba, rw, rh);
    expect(out.length).toBe(3 * SAM);
    expect(out[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(out[SAM]).toBeCloseTo((0 - 0.456) / 0.224, 5);
    expect(out[2 * SAM]).toBeCloseTo((0 - 0.406) / 0.225, 5);
    expect(out[1023 * 1024 + 1023]).toBe(0);
  });
});

describe('samPoints', () => {
  it('scales original points by the resize scale', () => {
    const out = samPoints([{ x: 100, y: 200 }], 2048, 1024);
    expect(Array.from(out)).toEqual([50, 100]);
    const two = samPoints([{ x: 0, y: 0 }, { x: 2048, y: 1024 }], 2048, 1024);
    expect(Array.from(two)).toEqual([0, 0, 1024, 512]);
  });
});

describe('samLabels', () => {
  it('produces int64 labels', () => {
    const l = samLabels([1, 0, 1]);
    expect(l.length).toBe(3);
    expect(l[0]).toBe(1n);
    expect(l[1]).toBe(0n);
  });
});

describe('autoPromptPoints', () => {
  it('returns five positive points around the centre', () => {
    const p = autoPromptPoints(100, 200);
    expect(p).toHaveLength(5);
    expect(p[0]).toEqual({ x: 50, y: 100 });
    expect(p[1]).toEqual({ x: 20, y: 100 });
    expect(p[2]).toEqual({ x: 80, y: 100 });
    expect(p[3]).toEqual({ x: 50, y: 40 });
    expect(p[4]).toEqual({ x: 50, y: 160 });
  });
});

describe('bestMaskIndex', () => {
  it('picks the argmax', () => {
    expect(bestMaskIndex(new Float32Array([0.1, 0.9, 0.4]))).toBe(1);
    expect(bestMaskIndex(new Float32Array([0.7, 0.2]))).toBe(0);
  });
});

describe('samMaskToFull', () => {
  it('maps a synthetic logit square back to the right region', () => {
    const w = 256;
    const h = 256;
    const pred = new Float32Array(3 * 256 * 256).fill(-1);
    for (let y = 96; y < 160; y++) {
      for (let x = 96; x < 160; x++) pred[y * 256 + x] = 1;
    }
    const out = samMaskToFull(pred, 0, w, h);
    expect(out.length).toBe(w * h);
    expect(out[128 * w + 128]).toBe(1);
    expect(out[0]).toBe(0);
    expect(out[(h - 1) * w + (w - 1)]).toBe(0);
  });

  it('selects the requested mask plane', () => {
    const w = 256;
    const h = 256;
    const pred = new Float32Array(3 * 256 * 256).fill(-1);
    for (let y = 96; y < 160; y++) {
      for (let x = 96; x < 160; x++) pred[256 * 256 + y * 256 + x] = 1;
    }
    expect(samMaskToFull(pred, 1, w, h)[128 * w + 128]).toBe(1);
    expect(samMaskToFull(pred, 0, w, h)[128 * w + 128]).toBe(0);
  });
});
