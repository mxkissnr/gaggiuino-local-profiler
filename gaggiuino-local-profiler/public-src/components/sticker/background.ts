/**
 * Plain/transparent studio-background detection for the sticker cut-out.
 *
 * Shop product shots sit on a plain background (white or light grey, often a
 * soft gradient). Running the models on the whole frame makes them pick the
 * wrong object, so plainBackgroundBox() finds a tight box around the product
 * and the caller runs the models only inside it. cropRgba()/pasteMask() move
 * pixels and masks between box space and the full image.
 *
 * Every export is pure and side-effect free: no DOM, inputs are never mutated.
 */

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Alpha at or above this counts as a real pixel; below it is background. */
const ALPHA_MIN = 16;
const SMOOTH_RADIUS = 4;
const PLAIN_JUMP = 6;
const PLAIN_JUMP_RATIO = 0.1;
const FG_TOLERANCE = 14;
const OCCUPIED_RATIO = 0.02;
const PAD_RATIO = 0.03;
const MAX_AREA_RATIO = 0.9;
const MIN_AREA_RATIO = 0.05;

interface BorderLine {
  /** Three values per sample: r, g, b. */
  rgb: Float32Array;
  /** 1 when the sample's alpha is >= ALPHA_MIN, else 0. */
  present: Uint8Array;
}

interface Borders {
  top: BorderLine;
  bottom: BorderLine;
  left: BorderLine;
  right: BorderLine;
}

function readLine(
  rgba: Uint8ClampedArray,
  len: number,
  pixel: (i: number) => number,
): BorderLine {
  const rgb = new Float32Array(len * 3);
  const present = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const p = pixel(i) * 4;
    if (rgba[p + 3]! < ALPHA_MIN) continue;
    present[i] = 1;
    rgb[i * 3] = rgba[p]!;
    rgb[i * 3 + 1] = rgba[p + 1]!;
    rgb[i * 3 + 2] = rgba[p + 2]!;
  }
  return { rgb, present };
}

/** 1-D median per channel; samples with alpha < ALPHA_MIN are left out. */
function medianFilter(values: Float32Array, present: Uint8Array, radius: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  const buf = new Float32Array(2 * radius + 1);
  for (let i = 0; i < n; i++) {
    let count = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j < 0 || j >= n || present[j] === 0) continue;
      buf[count++] = values[j]!;
    }
    if (count === 0) continue;
    for (let a = 1; a < count; a++) {
      const v = buf[a]!;
      let b = a - 1;
      while (b >= 0 && buf[b]! > v) {
        buf[b + 1] = buf[b]!;
        b--;
      }
      buf[b + 1] = v;
    }
    const mid = count >> 1;
    out[i] = count % 2 === 1 ? buf[mid]! : (buf[mid - 1]! + buf[mid]!) / 2;
  }
  return out;
}

function smoothLine(line: BorderLine): BorderLine {
  const len = line.present.length;
  const rgb = new Float32Array(len * 3);
  for (let c = 0; c < 3; c++) {
    const channel = new Float32Array(len);
    for (let i = 0; i < len; i++) channel[i] = line.rgb[i * 3 + c]!;
    const smoothed = medianFilter(channel, line.present, SMOOTH_RADIUS);
    for (let i = 0; i < len; i++) rgb[i * 3 + c] = smoothed[i]!;
  }
  return { rgb, present: line.present };
}

function borderProfiles(rgba: Uint8ClampedArray, w: number, h: number): Borders {
  return {
    top: smoothLine(readLine(rgba, w, (i) => i)),
    bottom: smoothLine(readLine(rgba, w, (i) => (h - 1) * w + i)),
    left: smoothLine(readLine(rgba, h, (i) => i * w)),
    right: smoothLine(readLine(rgba, h, (i) => i * w + (w - 1))),
  };
}

/** Fraction of neighbouring border samples whose channels jump by > PLAIN_JUMP. */
function jumpRatio(borders: Borders): number {
  let pairs = 0;
  let jumps = 0;
  for (const line of [borders.top, borders.bottom, borders.left, borders.right]) {
    const len = line.present.length;
    for (let i = 1; i < len; i++) {
      pairs++;
      if (line.present[i] === 0 || line.present[i - 1] === 0) continue;
      const a = i * 3;
      const b = (i - 1) * 3;
      const d0 = Math.abs(line.rgb[a]! - line.rgb[b]!);
      const d1 = Math.abs(line.rgb[a + 1]! - line.rgb[b + 1]!);
      const d2 = Math.abs(line.rgb[a + 2]! - line.rgb[b + 2]!);
      if (Math.max(d0, d1, d2) > PLAIN_JUMP) jumps++;
    }
  }
  return pairs === 0 ? 1 : jumps / pairs;
}

function medianOf(line: BorderLine, channel: number): number {
  const values: number[] = [];
  for (let i = 0; i < line.present.length; i++) {
    if (line.present[i] !== 0) values.push(line.rgb[i * 3 + channel]!);
  }
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

/**
 * Mean of the four border-profile medians, used as the fill for transparent
 * pixels when an image has no usable background colour of its own.
 */
export function meanBorderColour(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): [number, number, number] {
  const borders = borderProfiles(rgba, w, h);
  const lines = [borders.top, borders.bottom, borders.left, borders.right];
  const out: number[] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let sum = 0;
    for (const line of lines) sum += medianOf(line, c);
    out[c] = Math.round(sum / lines.length);
  }
  return [out[0]!, out[1]!, out[2]!];
}

/**
 * A tight box around the product on a plain studio background, or null when
 * the border is not uniform enough (a busy photo) or the box would be useless.
 */
export function plainBackgroundBox(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): CropBox | null {
  if (w < 2 || h < 2) return null;

  const borders = borderProfiles(rgba, w, h);
  if (jumpRatio(borders) > PLAIN_JUMP_RATIO) return null;

  const rowCount = new Uint32Array(h);
  const colCount = new Uint32Array(w);
  const dx = 1 / (w - 1);
  const dy = 1 / (h - 1);

  // Coons-style blend of the four border profiles gives the background at every
  // pixel in a single pass; a pixel is foreground when it differs enough.
  for (let y = 0; y < h; y++) {
    const v = y * dy;
    const lb = y * 3;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (rgba[p + 3]! < ALPHA_MIN) continue;
      const u = x * dx;
      const tb = x * 3;
      let foreground = false;
      for (let c = 0; c < 3; c++) {
        const bg =
          ((1 - u) * borders.left.rgb[lb + c]! +
            u * borders.right.rgb[lb + c]! +
            (1 - v) * borders.top.rgb[tb + c]! +
            v * borders.bottom.rgb[tb + c]!) /
          2;
        if (Math.abs(rgba[p + c]! - bg) > FG_TOLERANCE) {
          foreground = true;
          break;
        }
      }
      if (foreground) {
        rowCount[y] = rowCount[y]! + 1;
        colCount[x] = colCount[x]! + 1;
      }
    }
  }

  const minRow = OCCUPIED_RATIO * w;
  const minCol = OCCUPIED_RATIO * h;
  let firstRow = -1;
  let lastRow = -1;
  for (let y = 0; y < h; y++) {
    if (rowCount[y]! >= minRow) {
      if (firstRow === -1) firstRow = y;
      lastRow = y;
    }
  }
  let firstCol = -1;
  let lastCol = -1;
  for (let x = 0; x < w; x++) {
    if (colCount[x]! >= minCol) {
      if (firstCol === -1) firstCol = x;
      lastCol = x;
    }
  }
  if (firstRow === -1 || firstCol === -1) return null;

  const pad = Math.round(PAD_RATIO * Math.max(w, h));
  const x0 = Math.max(0, firstCol - pad);
  const y0 = Math.max(0, firstRow - pad);
  const x1 = Math.min(w - 1, lastCol + pad);
  const y1 = Math.min(h - 1, lastRow + pad);
  const box: CropBox = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };

  const areaRatio = (box.width * box.height) / (w * h);
  if (areaRatio > MAX_AREA_RATIO || areaRatio < MIN_AREA_RATIO) return null;
  return box;
}

/**
 * Copy `box` out of the image. Pixels with alpha < ALPHA_MIN become `fill`
 * with alpha 255, so a transparent PNG reaches the models as a plain background.
 */
export function cropRgba(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  box: CropBox,
  fill: [number, number, number],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    const sy = box.y + y;
    for (let x = 0; x < box.width; x++) {
      const sx = box.x + x;
      const dp = (y * box.width + x) * 4;
      if (sy < 0 || sy >= h || sx < 0 || sx >= w) {
        out[dp] = fill[0];
        out[dp + 1] = fill[1];
        out[dp + 2] = fill[2];
        out[dp + 3] = 255;
        continue;
      }
      const sp = (sy * w + sx) * 4;
      if (rgba[sp + 3]! < ALPHA_MIN) {
        out[dp] = fill[0];
        out[dp + 1] = fill[1];
        out[dp + 2] = fill[2];
        out[dp + 3] = 255;
        continue;
      }
      out[dp] = rgba[sp]!;
      out[dp + 1] = rgba[sp + 1]!;
      out[dp + 2] = rgba[sp + 2]!;
      out[dp + 3] = rgba[sp + 3]!;
    }
  }
  return out;
}

/** Place a box-sized mask back into a full-size (w x h) mask, zero elsewhere. */
export function pasteMask(sub: Uint8Array, box: CropBox, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < box.height; y++) {
    const dy = box.y + y;
    if (dy < 0 || dy >= h) continue;
    for (let x = 0; x < box.width; x++) {
      const dx = box.x + x;
      if (dx < 0 || dx >= w) continue;
      out[dy * w + dx] = sub[y * box.width + x]!;
    }
  }
  return out;
}

/** 1 where alpha >= ALPHA_MIN, or null when the image is fully opaque. */
export function alphaMask(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array | null {
  const n = w * h;
  const out = new Uint8Array(n);
  let transparent = false;
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3]! < ALPHA_MIN) {
      transparent = true;
    } else {
      out[i] = 1;
    }
  }
  return transparent ? out : null;
}
