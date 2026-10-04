/**
 * Model input/output tensor conversion for the on-device sticker cut-out,
 * matching the ONNX models the later slices ship. Pure and side-effect free.
 */

import { resizeBilinear } from './mask.js';

const ISNET_SIZE = 1024;
const SAM_SIZE = 1024;
const SAM_MASK = 256;

export interface Point {
  x: number;
  y: number;
}

export interface SamResize {
  scale: number;
  rw: number;
  rh: number;
}

/** IS-Net input `input_image` [1,3,1024,1024]: CHW, value = v/255 - 0.5. */
export function isnetInput(rgba1024: Uint8ClampedArray): Float32Array {
  const n = ISNET_SIZE * ISNET_SIZE;
  const out = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const offset = c * n;
    for (let i = 0; i < n; i++) {
      out[offset + i] = rgba1024[i * 4 + c]! / 255 - 0.5;
    }
  }
  return out;
}

/** IS-Net output `output_image` [1,1,1024,1024] -> alpha at w x h. */
export function isnetOutputToAlpha(out: Float32Array, w: number, h: number): Float32Array {
  const n = ISNET_SIZE * ISNET_SIZE;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = out[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const norm = new Float32Array(n);
  for (let i = 0; i < n; i++) norm[i] = range > 0 ? (out[i]! - min) / range : 0;
  return resizeBilinear(norm, ISNET_SIZE, ISNET_SIZE, w, h);
}

/** SlimSAM encoder resize: longest side to 1024, aspect ratio kept. */
export function samResizeDims(w: number, h: number): SamResize {
  const longest = Math.max(w, h);
  const scale = longest > 0 ? SAM_SIZE / longest : 1;
  return { scale, rw: Math.round(w * scale), rh: Math.round(h * scale) };
}

/**
 * SlimSAM encoder input `pixel_values` [1,3,1024,1024]: CHW, ImageNet
 * normalisation of v/255, zero padding on the right and bottom.
 */
export function samInput(rgbaResized: Uint8ClampedArray, rw: number, rh: number): Float32Array {
  const n = SAM_SIZE * SAM_SIZE;
  const out = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++) {
    const offset = c * n;
    const meanC = mean[c]!;
    const stdC = std[c]!;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const v = rgbaResized[(y * rw + x) * 4 + c]! / 255;
        out[offset + y * SAM_SIZE + x] = (v - meanC) / stdC;
      }
    }
  }
  return out;
}

/** Decoder `input_points` [1,1,N,2]: original coordinates scaled by `scale`. */
export function samPoints(points: Point[], w: number, h: number): Float32Array {
  const { scale } = samResizeDims(w, h);
  const out = new Float32Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    out[i * 2] = points[i]!.x * scale;
    out[i * 2 + 1] = points[i]!.y * scale;
  }
  return out;
}

export function samLabels(labels: number[]): BigInt64Array {
  const out = new BigInt64Array(labels.length);
  for (let i = 0; i < labels.length; i++) out[i] = BigInt(labels[i]!);
  return out;
}

/** Five positive prompts: the centre and four points at +-30% of width/height. */
export function autoPromptPoints(w: number, h: number): Point[] {
  const cx = w / 2;
  const cy = h / 2;
  const dx = w * 0.3;
  const dy = h * 0.3;
  return [
    { x: cx, y: cy },
    { x: cx - dx, y: cy },
    { x: cx + dx, y: cy },
    { x: cx, y: cy - dy },
    { x: cx, y: cy + dy },
  ];
}

export function bestMaskIndex(iou: Float32Array): number {
  let best = 0;
  for (let i = 1; i < iou.length; i++) {
    if (iou[i]! > iou[best]!) best = i;
  }
  return best;
}

/**
 * Turn one 256x256 logit plane into a w x h mask: upscale to 1024x1024, crop
 * to the top-left rw x rh, resize to w x h and threshold at zero.
 */
export function samMaskToFull(pred: Float32Array, index: number, w: number, h: number): Uint8Array {
  const { rw, rh } = samResizeDims(w, h);
  const plane = new Float32Array(SAM_MASK * SAM_MASK);
  const offset = index * SAM_MASK * SAM_MASK;
  for (let i = 0; i < plane.length; i++) plane[i] = pred[offset + i]!;
  const full = resizeBilinear(plane, SAM_MASK, SAM_MASK, SAM_SIZE, SAM_SIZE);
  const crop = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const sy = Math.min(y, SAM_SIZE - 1);
    for (let x = 0; x < rw; x++) {
      const sx = Math.min(x, SAM_SIZE - 1);
      crop[y * rw + x] = full[sy * SAM_SIZE + sx]!;
    }
  }
  const resized = resizeBilinear(crop, rw, rh, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = resized[i]! > 0 ? 1 : 0;
  return out;
}
