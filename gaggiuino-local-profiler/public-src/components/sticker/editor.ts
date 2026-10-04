// Sticker editor overlay (#1336, slice 3a): turns a photo blob into a
// transparent PNG "sticker". The pure helpers (maskBounds, paddedSquareCrop,
// MaskHistory, composeSticker) are exported and unit-tested directly; the
// overlay is the DOM shell that drives the slice-2 cut-out runtime
// (segment.ts) and the slice-1 mask helpers (mask.ts).
//
// Nothing imports this module yet — slice 3b wires it into the photo flow — so
// it never reaches the first-load bundle.
// mask.ts and segment.ts are the two earlier slices of this epic, already
// merged to `dev`: mask.ts holds slice 1's pure mask maths (applyTap,
// paintBrush, featherAlpha) and segment.ts holds slice 2's lazy cut-out runtime
// (autoCutout, tapMask, resetCutout). This slice is deliberately only the UI
// shell around them, so both are imported and consumed unchanged and neither
// file is edited here.
import { t } from '../../i18n.js';
import { applyTap, featherAlpha, paintBrush } from './mask.js';
import { autoCutout, resetCutout, tapMask } from './segment.js';

const MAX_WORK_EDGE = 1024;
const EXPORT_MAX_EDGE = 480;
const HISTORY_CAP = 20;
const WORKING_ROTATE_MS = 1500;
const PEEL_MS = 450;
const TAP_SLOP_PX = 6;
const DEFAULT_BRUSH = 16;
const BRUSH_MIN = 4;
const BRUSH_MAX = 60;

const WORKING_KEYS = ['sticker_working_1', 'sticker_working_2', 'sticker_working_3'] as const;

export interface MaskBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageDataLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Tight bounding box of the set pixels, or null when the mask is empty. */
export function maskBounds(m: Uint8Array, w: number, h: number): MaskBounds | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (m[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * A square crop centred on `bounds`: the side is the longer bounding-box edge,
 * grown by `padFrac` of that side on every side, then clamped to the image.
 */
export function paddedSquareCrop(bounds: MaskBounds, w: number, h: number, padFrac = 0.04): CropRect {
  const boxWidth = bounds.x1 - bounds.x0 + 1;
  const boxHeight = bounds.y1 - bounds.y0 + 1;
  const longer = Math.max(boxWidth, boxHeight);
  const pad = Math.round(longer * padFrac);
  const side = longer + pad * 2;
  const centreX = (bounds.x0 + bounds.x1 + 1) / 2;
  const centreY = (bounds.y0 + bounds.y1 + 1) / 2;

  let x = Math.round(centreX - side / 2);
  let y = Math.round(centreY - side / 2);
  let width = side;
  let height = side;
  if (x < 0) {
    width += x;
    x = 0;
  }
  if (y < 0) {
    height += y;
    y = 0;
  }
  if (x + width > w) width = Math.max(0, w - x);
  if (y + height > h) height = Math.max(0, h - y);
  return { x, y, width, height };
}

/**
 * Undo stack for the user's mask edits. The first entry pushed is the
 * automatic mask and is always kept: undo() returns the previous mask and
 * never pops it, and the oldest *edit* is dropped once the cap is reached.
 */
export class MaskHistory {
  private readonly entries: Uint8Array[] = [];

  push(mask: Uint8Array): void {
    this.entries.push(new Uint8Array(mask));
    if (this.entries.length > HISTORY_CAP) {
      this.entries.splice(1, 1);
    }
  }

  get canUndo(): boolean {
    return this.entries.length > 1;
  }

  undo(): Uint8Array | null {
    if (this.entries.length <= 1) return null;
    this.entries.pop();
    const previous = this.entries[this.entries.length - 1];
    return previous ? new Uint8Array(previous) : null;
  }
}

/** Crop the photo and use the feathered mask as its alpha channel. */
export function composeSticker(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  w: number,
  h: number,
  crop: CropRect,
): ImageDataLike {
  const feathered = featherAlpha(alpha, w, h);
  const data = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const src = ((crop.y + y) * w + (crop.x + x)) * 4;
      const dst = (y * crop.width + x) * 4;
      data[dst] = rgba[src]!;
      data[dst + 1] = rgba[src + 1]!;
      data[dst + 2] = rgba[src + 2]!;
      data[dst + 3] = feathered[(crop.y + y) * w + (crop.x + x)]!;
    }
  }
  return { data, width: crop.width, height: crop.height };
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;

export interface StickerView {
  scale: number;
  x: number;
  y: number;
}

/**
 * Limit the scale to [MIN_SCALE, MAX_SCALE] and clamp the translation so the
 * scaled canvas always covers the viewport: no viewport edge shows a gap.
 */
export function clampView(
  view: StickerView,
  viewportW: number,
  viewportH: number,
  canvasW: number,
  canvasH: number,
): StickerView {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale));
  const scaledW = canvasW * scale;
  const scaledH = canvasH * scale;
  const minX = Math.min(0, viewportW - scaledW);
  const maxX = Math.max(0, viewportW - scaledW);
  const minY = Math.min(0, viewportH - scaledH);
  const maxY = Math.max(0, viewportH - scaledH);
  return {
    scale,
    x: Math.min(maxX, Math.max(minX, view.x)),
    y: Math.min(maxY, Math.max(minY, view.y)),
  };
}

/** Scale by `factor` while keeping the content point under (px, py) fixed. */
export function zoomAround(view: StickerView, factor: number, px: number, py: number): StickerView {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const contentX = (px - view.x) / view.scale;
  const contentY = (py - view.y) / view.scale;
  return { scale, x: px - contentX * scale, y: py - contentY * scale };
}

interface DecodedPhoto {
  source: CanvasImageSource;
  width: number;
  height: number;
}

async function decodePhoto(photo: Blob): Promise<DecodedPhoto> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(photo);
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // fall through to the <img> path below
    }
  }
  return await new Promise<DecodedPhoto>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('sticker: could not read the photo'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('sticker: could not decode the photo'));
      img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight });
      img.src = reader.result as string;
    };
    reader.readAsDataURL(photo);
  });
}

// Draw the decoded photo at the working size (longer edge max 1024) and read
// its pixels back, so all mask maths runs on one fixed buffer.
function readWorkRgba(decoded: DecodedPhoto): { rgba: Uint8ClampedArray; w: number; h: number } {
  const longer = Math.max(decoded.width, decoded.height) || 1;
  const scale = longer > MAX_WORK_EDGE ? MAX_WORK_EDGE / longer : 1;
  const w = Math.max(1, Math.round(decoded.width * scale));
  const h = Math.max(1, Math.round(decoded.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.drawImage(decoded.source, 0, 0, w, h);
  return { rgba: ctx.getImageData(0, 0, w, h).data, w, h };
}

/** Release a decoded ImageBitmap (the <img> fallback has no close()). */
function closeSource(source: CanvasImageSource | null): void {
  if (!source) return;
  const closable = source as unknown as { close?: () => void };
  if (typeof closable.close === 'function') closable.close();
}

/**
 * Open the sticker editor for `photo`. Resolves with a PNG blob on Apply, or
 * null on Cancel, Escape, load failure or model failure.
 */
export function openStickerEditor(photo: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    void (async () => {
      let decoded: DecodedPhoto;
      let work: { rgba: Uint8ClampedArray; w: number; h: number };
      let source: CanvasImageSource | null = null;
      try {
        decoded = await decodePhoto(photo);
        source = decoded.source;
        work = readWorkRgba(decoded);
      } catch (err) {
        console.error(err);
        closeSource(source);
        resolve(null);
        return;
      }
      buildEditor(decoded, work.rgba, work.w, work.h, resolve);
    })();
  });
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function themedButton(className: string, label: string): HTMLButtonElement {
  const button = element('button', className);
  button.type = 'button';
  button.textContent = label;
  return button;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function buildEditor(
  decoded: DecodedPhoto,
  rgba: Uint8ClampedArray,
  workW: number,
  workH: number,
  resolve: (value: Blob | null) => void,
): void {
  const overlay = element('div', 'crop-editor-overlay sticker-overlay');
  const modal = element('div', 'crop-editor-modal');

  const title = element('h3', 'crop-editor-title');
  title.textContent = t('sticker_title');

  const viewport = element('div', 'sticker-viewport');
  const canvas = element('canvas', 'sticker-canvas');
  canvas.width = workW;
  canvas.height = workH;
  viewport.appendChild(canvas);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  const workingLine = element('p', 'sticker-working');
  workingLine.textContent = t(WORKING_KEYS[0]);
  workingLine.setAttribute('role', 'status');

  const tools = element('div', 'sticker-tools');
  const addBtn = themedButton('lib-btn-sm sticker-mode-add', t('sticker_add'));
  const removeBtn = themedButton('lib-btn-sm sticker-mode-remove', t('sticker_remove'));
  const brushBtn = themedButton('lib-btn-sm sticker-brush-toggle', t('sticker_brush'));
  const sizeInput = element('input', 'sticker-brush-size');
  sizeInput.type = 'range';
  sizeInput.min = String(BRUSH_MIN);
  sizeInput.max = String(BRUSH_MAX);
  sizeInput.value = String(DEFAULT_BRUSH);
  sizeInput.setAttribute('aria-label', t('sticker_brush_size'));
  const undoBtn = themedButton('lib-btn-sm sticker-undo', t('sticker_undo'));
  const resetBtn = themedButton('lib-btn-sm sticker-reset', t('sticker_reset'));
  const originalBtn = themedButton('lib-btn-sm sticker-original', t('sticker_original'));
  const fitBtn = themedButton('lib-btn-sm sticker-fit', t('sticker_fit'));
  for (const child of [addBtn, removeBtn, brushBtn, sizeInput, undoBtn, resetBtn, originalBtn, fitBtn]) {
    tools.appendChild(child);
  }

  const actions = element('div', 'crop-editor-actions');
  const cancelBtn = themedButton('lib-btn-sm crop-editor-cancel sticker-cancel', t('lib_cancel'));
  const applyBtn = themedButton('lib-save-btn crop-editor-apply sticker-apply', t('sticker_apply'));
  const closeBtn = themedButton('lib-btn-sm sticker-close', t('sticker_close'));
  closeBtn.style.display = 'none';
  for (const child of [cancelBtn, applyBtn, closeBtn]) actions.appendChild(child);

  for (const child of [title, viewport, workingLine, tools, actions]) modal.appendChild(child);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const offscreen = document.createElement('canvas');
  offscreen.width = workW;
  offscreen.height = workH;
  const offCtx = offscreen.getContext('2d') as CanvasRenderingContext2D;

  const history = new MaskHistory();
  let current: Uint8Array | null = null;
  let autoMask: Uint8Array | null = null;
  let mode: 'add' | 'remove' = 'add';
  let brushOn = false;
  let brushSize = DEFAULT_BRUSH;
  let busy = false;
  let working = true;
  let showOriginal = false;
  let closed = false;
  let workingTimer: ReturnType<typeof setInterval> | null = null;
  let peelTimer: ReturnType<typeof setTimeout> | null = null;
  let view: StickerView = { scale: 1, x: 0, y: 0 };

  function themeColor(name: string): string | null {
    if (typeof getComputedStyle !== 'function') return null;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || null;
  }

  function applyView(): void {
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }

  function layoutSize(): { w: number; h: number } {
    return { w: canvas.offsetWidth || workW, h: canvas.offsetHeight || workH };
  }

  function clampCurrent(): void {
    const layout = layoutSize();
    const rect = viewport.getBoundingClientRect();
    view = clampView(view, rect.width || layout.w, rect.height || layout.h, layout.w, layout.h);
  }

  function drawCheckerboard(): void {
    const light = themeColor('--gray-800') ?? 'rgba(255,255,255,.08)';
    const dark = themeColor('--gray-900') ?? 'rgba(255,255,255,.16)';
    const size = 8;
    for (let y = 0; y < workH; y += size) {
      for (let x = 0; x < workW; x += size) {
        ctx.fillStyle = (x / size + y / size) % 2 === 0 ? light : dark;
        ctx.fillRect(x, y, size, size);
      }
    }
  }

  function draw(): void {
    ctx.clearRect(0, 0, workW, workH);
    if (working) {
      ctx.globalAlpha = 0.4;
      ctx.drawImage(decoded.source, 0, 0, workW, workH);
      ctx.globalAlpha = 1;
      return;
    }
    if (showOriginal || !current) {
      ctx.drawImage(decoded.source, 0, 0, workW, workH);
      return;
    }
    drawCheckerboard();
    const out = new Uint8ClampedArray(rgba.length);
    for (let i = 0; i < current.length; i++) {
      out[i * 4] = rgba[i * 4]!;
      out[i * 4 + 1] = rgba[i * 4 + 1]!;
      out[i * 4 + 2] = rgba[i * 4 + 2]!;
      out[i * 4 + 3] = current[i] ? 255 : 0;
    }
    const image = offCtx.createImageData(workW, workH);
    image.data.set(out);
    offCtx.putImageData(image, 0, 0);
    ctx.drawImage(offscreen, 0, 0);
  }

  function refreshControls(): void {
    const canEdit = !working && !busy;
    const hasMask = canEdit && current !== null && maskBounds(current, workW, workH) !== null;
    addBtn.disabled = !canEdit;
    removeBtn.disabled = !canEdit;
    brushBtn.disabled = !canEdit;
    sizeInput.disabled = !canEdit;
    resetBtn.disabled = !canEdit || autoMask === null;
    originalBtn.disabled = !canEdit;
    fitBtn.disabled = view.scale === 1;
    undoBtn.disabled = !canEdit || !history.canUndo;
    applyBtn.disabled = !hasMask;
    addBtn.setAttribute('aria-pressed', String(mode === 'add'));
    removeBtn.setAttribute('aria-pressed', String(mode === 'remove'));
    brushBtn.setAttribute('aria-pressed', String(brushOn));
  }

  function startWorkingRotation(): void {
    workingLine.textContent = t(WORKING_KEYS[0]);
    let index = 0;
    workingTimer = setInterval(() => {
      index = (index + 1) % WORKING_KEYS.length;
      workingLine.textContent = t(WORKING_KEYS[index]!);
    }, WORKING_ROTATE_MS);
  }

  function stopWorkingRotation(): void {
    if (workingTimer !== null) {
      clearInterval(workingTimer);
      workingTimer = null;
    }
  }

  function close(result: Blob | null): void {
    if (closed) return;
    closed = true;
    stopWorkingRotation();
    if (peelTimer !== null) {
      clearTimeout(peelTimer);
      peelTimer = null;
    }
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
    closeSource(decoded.source);
    resetCutout();
    resolve(result);
  }

  function fail(err?: unknown): void {
    if (closed) {
      resetCutout();
      return;
    }
    if (err !== undefined) console.error(err);
    working = false;
    busy = false;
    stopWorkingRotation();
    workingLine.textContent = t('sticker_failed');
    workingLine.classList.add('sticker-failed');
    tools.style.display = 'none';
    cancelBtn.style.display = 'none';
    applyBtn.style.display = 'none';
    closeBtn.style.display = '';
    refreshControls();
  }

  function ready(mask: Uint8Array): void {
    if (closed) {
      resetCutout();
      return;
    }
    autoMask = new Uint8Array(mask);
    current = new Uint8Array(mask);
    history.push(current);
    working = false;
    stopWorkingRotation();
    workingLine.textContent = '';
    workingLine.style.display = 'none';
    refreshControls();
    draw();
    applyBtn.focus();
  }

  function toImagePoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || workW;
    const height = rect.height || workH;
    const x = Math.min(workW - 1, Math.max(0, Math.round((clientX - rect.left) * (workW / width))));
    const y = Math.min(workH - 1, Math.max(0, Math.round((clientY - rect.top) * (workH / height))));
    return { x, y };
  }

  function paintAt(clientX: number, clientY: number): void {
    if (!current) return;
    const point = toImagePoint(clientX, clientY);
    current = paintBrush(current, workW, workH, point.x, point.y, brushSize / 2, mode === 'add' ? 1 : 0);
    draw();
  }

  async function handleTap(clientX: number, clientY: number): Promise<void> {
    if (working || busy) return;
    busy = true;
    refreshControls();
    overlay.classList.add('sticker-busy');
    try {
      const point = toImagePoint(clientX, clientY);
      const tap = await tapMask(point.x, point.y, mode === 'add' ? 1 : 0, workW, workH);
      if (closed) {
        resetCutout();
        return;
      }
      const base = current;
      if (!base) return;
      current = applyTap(base, tap, mode, workW, workH);
      history.push(current);
      draw();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
      overlay.classList.remove('sticker-busy');
      refreshControls();
    }
  }

  function doUndo(): void {
    if (working || busy) return;
    const previous = history.undo();
    if (!previous) return;
    current = previous;
    refreshControls();
    draw();
  }

  function finishApply(blob: Blob | null): void {
    if (!blob) {
      close(null);
      return;
    }
    if (prefersReducedMotion()) {
      close(blob);
      return;
    }
    canvas.classList.add('sticker-peel');
    peelTimer = setTimeout(() => close(blob), PEEL_MS);
  }

  function onApply(): void {
    if (working || busy || !current) return;
    const bounds = maskBounds(current, workW, workH);
    if (!bounds) return;

    const crop = paddedSquareCrop(bounds, workW, workH);
    const composed = composeSticker(rgba, current, workW, workH, crop);
    const longer = Math.max(composed.width, composed.height);
    const scale = longer > EXPORT_MAX_EDGE ? EXPORT_MAX_EDGE / longer : 1;
    const outW = Math.max(1, Math.round(composed.width * scale));
    const outH = Math.max(1, Math.round(composed.height * scale));

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = composed.width;
    cropCanvas.height = composed.height;
    const cropCtx = cropCanvas.getContext('2d') as CanvasRenderingContext2D;
    const image = cropCtx.createImageData(composed.width, composed.height);
    image.data.set(composed.data);
    cropCtx.putImageData(image, 0, 0);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext('2d') as CanvasRenderingContext2D;
    outCtx.drawImage(cropCanvas, 0, 0, outW, outH);

    outCanvas.toBlob((blob) => finishApply(blob), 'image/png');
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(null);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
      event.preventDefault();
      doUndo();
    }
  }

  addBtn.addEventListener('click', () => {
    mode = 'add';
    refreshControls();
  });
  removeBtn.addEventListener('click', () => {
    mode = 'remove';
    refreshControls();
  });
  brushBtn.addEventListener('click', () => {
    brushOn = !brushOn;
    refreshControls();
  });
  sizeInput.addEventListener('input', () => {
    brushSize = Number(sizeInput.value) || DEFAULT_BRUSH;
  });
  undoBtn.addEventListener('click', doUndo);
  resetBtn.addEventListener('click', () => {
    if (working || busy || !autoMask) return;
    current = new Uint8Array(autoMask);
    history.push(current);
    refreshControls();
    draw();
  });
  originalBtn.addEventListener('pointerdown', () => {
    showOriginal = true;
    draw();
  });
  const endOriginal = (): void => {
    if (!showOriginal) return;
    showOriginal = false;
    draw();
  };
  for (const eventName of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) {
    originalBtn.addEventListener(eventName, endOriginal);
  }
  fitBtn.addEventListener('click', () => {
    view = { scale: 1, x: 0, y: 0 };
    applyView();
    refreshControls();
  });

  let strokeId: number | null = null;
  let strokeStart: { x: number; y: number } | null = null;
  let strokeMoved = 0;
  let strokePainting = false;
  let strokeStartMask: Uint8Array | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let gestureMode = false;
  let gestureStart: { dist: number; mid: { x: number; y: number }; view: StickerView } | null = null;

  function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(b.x - a.x, b.y - a.y) || 1;
  }

  function midpoint(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function startStroke(event: PointerEvent): void {
    strokeId = event.pointerId;
    strokeStart = { x: event.clientX, y: event.clientY };
    strokeMoved = 0;
    strokePainting = brushOn;
    strokeStartMask = brushOn ? current : null;
    if (typeof viewport.setPointerCapture === 'function') viewport.setPointerCapture(event.pointerId);
    if (strokePainting) paintAt(event.clientX, event.clientY);
  }

  function abortStroke(): void {
    if (strokePainting && strokeStartMask) {
      current = strokeStartMask;
      draw();
    }
    if (strokeId !== null && typeof viewport.releasePointerCapture === 'function') {
      viewport.releasePointerCapture(strokeId);
    }
    strokeId = null;
    strokeStart = null;
    strokeMoved = 0;
    strokePainting = false;
    strokeStartMask = null;
  }

  function rebaseGesture(): void {
    const values = [...pointers.values()];
    const a = values[0];
    const b = values[1];
    if (!a || !b) {
      gestureStart = null;
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const mid = midpoint(a, b);
    gestureStart = {
      dist: distance(a, b),
      mid: { x: mid.x - rect.left, y: mid.y - rect.top },
      view: { ...view },
    };
  }

  function beginGesture(): void {
    abortStroke();
    gestureMode = true;
    rebaseGesture();
  }

  function updateGesture(): void {
    if (!gestureStart) return;
    const values = [...pointers.values()];
    const a = values[0];
    const b = values[1];
    if (!a || !b) return;
    const rect = viewport.getBoundingClientRect();
    const mid = midpoint(a, b);
    const midX = mid.x - rect.left;
    const midY = mid.y - rect.top;
    const seeded = zoomAround(gestureStart.view, distance(a, b) / gestureStart.dist, gestureStart.mid.x, gestureStart.mid.y);
    view = {
      scale: seeded.scale,
      x: seeded.x + (midX - gestureStart.mid.x),
      y: seeded.y + (midY - gestureStart.mid.y),
    };
    clampCurrent();
    applyView();
    refreshControls();
  }

  function onWheel(event: WheelEvent): void {
    if (closed) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    view = zoomAround(view, event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - rect.left, event.clientY - rect.top);
    clampCurrent();
    applyView();
    refreshControls();
  }

  viewport.addEventListener('wheel', onWheel, { passive: false });

  viewport.addEventListener('pointerdown', (event) => {
    if (closed) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      if (gestureMode) rebaseGesture();
      else beginGesture();
      return;
    }
    if (working || busy || !current) return;
    startStroke(event);
  });

  viewport.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gestureMode) {
      updateGesture();
      return;
    }
    if (strokeId !== event.pointerId || !strokeStart) return;
    strokeMoved = Math.max(strokeMoved, Math.hypot(event.clientX - strokeStart.x, event.clientY - strokeStart.y));
    if (strokePainting) paintAt(event.clientX, event.clientY);
  });

  function finishPointer(event: PointerEvent, cancelled: boolean): void {
    pointers.delete(event.pointerId);
    if (gestureMode) {
      if (pointers.size === 0) {
        gestureMode = false;
        gestureStart = null;
      } else if (pointers.size >= 2) {
        rebaseGesture();
      }
      if (typeof viewport.releasePointerCapture === 'function') viewport.releasePointerCapture(event.pointerId);
      return;
    }
    if (strokeId !== event.pointerId) return;
    if (cancelled) {
      abortStroke();
      refreshControls();
      return;
    }
    const painting = strokePainting;
    const moved = strokeMoved;
    const start = strokeStart;
    strokeId = null;
    strokeStart = null;
    strokePainting = false;
    strokeStartMask = null;
    if (typeof viewport.releasePointerCapture === 'function') viewport.releasePointerCapture(event.pointerId);
    if (painting) {
      if (current) history.push(current);
      refreshControls();
      draw();
    } else if (start && moved < TAP_SLOP_PX && !working && !busy && current) {
      void handleTap(event.clientX, event.clientY);
    }
  }

  viewport.addEventListener('pointerup', (event) => finishPointer(event, false));
  viewport.addEventListener('pointercancel', (event) => finishPointer(event, true));

  cancelBtn.addEventListener('click', () => close(null));
  closeBtn.addEventListener('click', () => close(null));
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close(null);
  });
  applyBtn.addEventListener('click', onApply);
  document.addEventListener('keydown', onKeyDown);

  startWorkingRotation();
  applyView();
  refreshControls();
  draw();
  void autoCutout(rgba, workW, workH)
    .then(ready)
    .catch((err: unknown) => {
      fail(err);
    });
}
