/**
 * Pure mask helpers for the on-device bean photo "sticker" cut-out.
 *
 * Masks are `Uint8Array`s of length `w*h` holding 0 or 1 in row-major order.
 * RGBA images are `Uint8ClampedArray`s of length `w*h*4`. Every export is
 * side-effect free and returns new arrays, never mutating its inputs.
 */

export function resizeBilinear(
  src: Float32Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float32Array {
  const out = new Float32Array(dw * dh);
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return out;
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * yRatio - 0.5;
    const y0 = Math.min(sh - 1, Math.max(0, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xRatio - 0.5;
      const x0 = Math.min(sw - 1, Math.max(0, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const v00 = src[y0 * sw + x0]!;
      const v01 = src[y0 * sw + x1]!;
      const v10 = src[y1 * sw + x0]!;
      const v11 = src[y1 * sw + x1]!;
      const top = v00 + (v01 - v00) * fx;
      const bottom = v10 + (v11 - v10) * fx;
      out[y * dw + x] = top + (bottom - top) * fy;
    }
  }
  return out;
}

/**
 * Keep only the largest 8-connected region of ones. Iterative (explicit
 * stack), so large masks never overflow the call stack. All-zero stays zero.
 */
export function largestComponent(m: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n);
  if (n === 0) return out;

  const component = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const sizes: number[] = [];
  let nextId = 0;

  for (let start = 0; start < n; start++) {
    if (m[start] !== 1 || component[start] !== -1) continue;
    let top = 0;
    stack[top++] = start;
    component[start] = nextId;
    let size = 0;
    while (top > 0) {
      const idx = stack[--top]!;
      size++;
      const x = idx % w;
      const y = (idx - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (m[ni] === 1 && component[ni] === -1) {
            component[ni] = nextId;
            stack[top++] = ni;
          }
        }
      }
    }
    sizes.push(size);
    nextId++;
  }

  let bestId = -1;
  let bestSize = 0;
  for (let id = 0; id < sizes.length; id++) {
    if (sizes[id]! > bestSize) {
      bestSize = sizes[id]!;
      bestId = id;
    }
  }
  if (bestId === -1) return out;

  for (let i = 0; i < n; i++) {
    if (component[i] === bestId) out[i] = 1;
  }
  return out;
}

/**
 * Flood-fill zeros from every border pixel (4-connected); every zero not
 * reached becomes one, closing enclosed holes.
 */
export function fillHoles(m: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(m);
  if (n === 0) return out;

  const reached = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const push = (i: number): void => {
    if (reached[i] === 0 && m[i] === 0) {
      reached[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (top > 0) {
    const idx = stack[--top]!;
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) push(idx - 1);
    if (x < w - 1) push(idx + 1);
    if (y > 0) push(idx - w);
    if (y < h - 1) push(idx + w);
  }

  for (let i = 0; i < n; i++) {
    if (m[i] === 0 && reached[i] === 0) out[i] = 1;
  }
  return out;
}

export function union(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] !== 0 || b[i] !== 0 ? 1 : 0;
  }
  return out;
}

export function subtract(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] !== 0 && b[i] === 0 ? 1 : 0;
  }
  return out;
}

/**
 * One separable morph pass along rows (horizontal) or columns (vertical).
 * Out-of-bounds window samples count as 0, so erosion also trims borders.
 */
function morphPass(
  src: Uint8Array,
  w: number,
  h: number,
  r: number,
  dilate: boolean,
  horizontal: boolean,
): Uint8Array {
  const out = new Uint8Array(w * h);
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const identity = dilate ? 0 : 1;
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w : l;
    const step = horizontal ? 1 : w;
    for (let i = 0; i < len; i++) {
      let acc = identity;
      for (let j = i - r; j <= i + r; j++) {
        let v = 0;
        if (j >= 0 && j < len) v = src[base + j * step]!;
        if (dilate) {
          if (v > acc) acc = v;
        } else if (v < acc) {
          acc = v;
        }
      }
      out[base + i * step] = acc;
    }
  }
  return out;
}

export function erode(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0 || w === 0 || h === 0) return new Uint8Array(m);
  return morphPass(morphPass(m, w, h, r, false, true), w, h, r, false, false);
}

export function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0 || w === 0 || h === 0) return new Uint8Array(m);
  return morphPass(morphPass(m, w, h, r, true, true), w, h, r, true, false);
}

export function openMask(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return dilate(erode(m, w, h, r), w, h, r);
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  const delta = 6 / 29;
  return t > delta * delta * delta ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
}

/** sRGB -> linear -> XYZ (D65) -> CIELAB, scaled to the OpenCV 8-bit convention. */
export function rgbToLab8(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  const l = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bb = 200 * (fy - fz);
  return [(l * 255) / 100, a + 128, bb + 128];
}

function median(sorted: Float32Array): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function maxRowCount(m: Uint8Array, w: number, h: number): number {
  let best = 0;
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < w; x++) if (m[y * w + x] !== 0) count++;
    if (count > best) best = count;
  }
  return best;
}

function maxColCount(m: Uint8Array, w: number, h: number): number {
  let best = 0;
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < h; y++) if (m[y * w + x] !== 0) count++;
    if (count > best) best = count;
  }
  return best;
}

/**
 * "Packaging base colour" filter: find the dominant Lab colour of the mask's
 * eroded core, drop rows/columns that lack it and keep the largest remaining
 * region. Used to cut reflections and side clutter off a bag photo.
 */
export function baseColourTrim(
  m: Uint8Array,
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8Array {
  const n = w * h;
  const core = erode(m, w, h, 12);
  let coreCount = 0;
  for (let i = 0; i < n; i++) if (core[i] !== 0) coreCount++;
  if (coreCount === 0) return new Uint8Array(m);

  const c0 = new Float32Array(coreCount);
  const c1 = new Float32Array(coreCount);
  const c2 = new Float32Array(coreCount);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (core[i] === 0) continue;
    const p = i * 4;
    const lab = rgbToLab8(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!);
    c0[k] = lab[0];
    c1[k] = lab[1];
    c2[k] = lab[2];
    k++;
  }
  c0.sort();
  c1.sort();
  c2.sort();
  const base: [number, number, number] = [median(c0), median(c1), median(c2)];

  const dist = new Float32Array(n);
  const coreDist = new Float32Array(coreCount);
  let ck = 0;
  for (let i = 0; i < n; i++) {
    if (m[i] === 0) continue;
    const p = i * 4;
    const lab = rgbToLab8(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!);
    const dL = lab[0] - base[0];
    const dA = lab[1] - base[1];
    const dB = lab[2] - base[2];
    const d = Math.sqrt(dL * dL + dA * dA + dB * dB);
    dist[i] = d;
    if (core[i] !== 0) coreDist[ck++] = d;
  }
  coreDist.sort();
  const p75 = coreDist[Math.floor(0.75 * (coreCount - 1))]!;
  const threshold = Math.max(28, 1.3 * p75);

  const like = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (m[i] !== 0 && dist[i]! < threshold) like[i] = 1;
  }

  const maxRow = maxRowCount(m, w, h);
  let firstRow = -1;
  let lastRow = -1;
  for (let y = 0; y < h; y++) {
    let maskCount = 0;
    let likeCount = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (m[i] !== 0) maskCount++;
      if (like[i] !== 0) likeCount++;
    }
    if (maskCount > 0 && likeCount / maskCount > 0.35 && maskCount > 0.2 * maxRow) {
      if (firstRow === -1) firstRow = y;
      lastRow = y;
    }
  }

  const maxCol = maxColCount(m, w, h);
  let firstCol = -1;
  let lastCol = -1;
  for (let x = 0; x < w; x++) {
    let maskCount = 0;
    let likeCount = 0;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      if (m[i] !== 0) maskCount++;
      if (like[i] !== 0) likeCount++;
    }
    if (maskCount > 0 && likeCount / maskCount > 0.35 && maskCount > 0.2 * maxCol) {
      if (firstCol === -1) firstCol = x;
      lastCol = x;
    }
  }

  if (firstRow === -1 || firstCol === -1) return new Uint8Array(m);

  const trimmed = new Uint8Array(n);
  for (let y = firstRow; y <= lastRow; y++) {
    for (let x = firstCol; x <= lastCol; x++) {
      const i = y * w + x;
      if (m[i] !== 0) trimmed[i] = 1;
    }
  }
  return largestComponent(trimmed, w, h);
}

/** Automatic merge of the IS-Net alpha and the SlimSAM mask, then base-colour trim. */
export function combineMasks(
  isnetAlpha: Float32Array,
  sam: Uint8Array,
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8Array {
  const n = w * h;
  const isn = new Uint8Array(n);
  for (let i = 0; i < n; i++) isn[i] = isnetAlpha[i]! > 0.5 ? 1 : 0;
  const s = openMask(sam, w, h, 4);
  let m = fillHoles(largestComponent(union(isn, s), w, h), w, h);
  m = openMask(m, w, h, 4);
  m = fillHoles(largestComponent(m, w, h), w, h);
  return baseColourTrim(m, rgba, w, h);
}

/** Apply a tap edit. No hole filling, so a user edit is never undone. */
export function applyTap(
  m: Uint8Array,
  tapMask: Uint8Array,
  mode: 'add' | 'remove',
  w: number,
  h: number,
): Uint8Array {
  return mode === 'add' ? union(m, tapMask) : subtract(m, dilate(tapMask, w, h, 1));
}

export function paintBrush(
  m: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  radius: number,
  value: 0 | 1,
): Uint8Array {
  const out = new Uint8Array(m);
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy * dy <= r2) out[y * w + x] = value;
    }
  }
  return out;
}

/** 3x3 box blur of `m*255`, for a soft one-pixel result edge. */
export function featherAlpha(m: Uint8Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          sum += m[ny * w + nx]! * 255;
          count++;
        }
      }
      out[y * w + x] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}
