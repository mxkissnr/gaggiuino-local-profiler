// Reusable zoom + pan crop editor for photo uploads (#286).
// Opens a modal over the picked file, lets the user zoom (slider/wheel/pinch)
// and pan (drag/touch) an image against a fixed crop guide, then exports a
// JPEG blob that feeds into the existing upload flow unchanged.
import { t } from '../i18n.js';
import { esc, html } from '../utils.js';

// 'square' is the historical 1:1 crop (grinders, baskets, puck screens, shots);
// 'portrait' is the 3:4 bag shape bean photos are shown at on the shelf (#1346).
type CropAspect = 'square' | 'portrait';

// Per-aspect canvas boxes: CSS px == canvas px for the preview (no DPR scaling
// needed), the export is a larger buffer of the same shape.
const BOX = {
  square:   { previewW: 320, previewH: 320, exportW: 480, exportH: 480 },
  portrait: { previewW: 240, previewH: 320, exportW: 600, exportH: 800 },
} satisfies Record<CropAspect, { previewW: number; previewH: number; exportW: number; exportH: number }>;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

interface Point {
  x: number;
  y: number;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Computes the zoom/pan → source-rect crop math shared between the live
// preview draw and the final export. Kept pure so it's unit-testable.
export function coverBaseScale(naturalW: number, naturalH: number, boxW: number, boxH: number): number {
  return Math.max(boxW / naturalW, boxH / naturalH);
}

export function clampOffset(offsetX: number, offsetY: number, naturalW: number, naturalH: number, scale: number, boxW: number, boxH: number): Point {
  const scaledW = naturalW * scale;
  const scaledH = naturalH * scale;
  const minX = boxW - scaledW;
  const minY = boxH - scaledH;
  return {
    x: Math.min(0, Math.max(minX, offsetX)),
    y: Math.min(0, Math.max(minY, offsetY)),
  };
}

// Opens the crop editor for `file`. `shape` ('circle' | 'square') picks the
// preview guide, `aspect` ('square' | 'portrait') picks the 1:1 vs 3:4 export
// shape — the exported JPEG matches the box, consistent with how
// object-fit:cover + border-radius renders thumbnails elsewhere in the app.
// Resolves with a Blob on Apply, or null on Cancel / load failure.
export function openImageCropEditor(
  file: Blob,
  { shape = 'circle', aspect = 'square' }: { shape?: 'circle' | 'square'; aspect?: CropAspect } = {},
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(null);
      img.onload = () => _buildEditor(img, shape, aspect, resolve);
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function _buildEditor(img: HTMLImageElement, shape: 'circle' | 'square', aspect: CropAspect, resolve: (value: Blob | null) => void): void {
  const box = BOX[aspect];
  const previewW = box.previewW;
  const previewH = box.previewH;
  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  const baseScale = coverBaseScale(naturalW, naturalH, previewW, previewH);

  let zoom = MIN_ZOOM;
  let offsetX = (previewW - naturalW * baseScale) / 2;
  let offsetY = (previewH - naturalH * baseScale) / 2;

  const guideClass = shape === 'square' ? 'square' : 'circle';
  const portraitClass = aspect === 'portrait' ? ' crop-editor-canvas-portrait' : '';
  const canvasClass = `crop-editor-canvas crop-editor-canvas-${guideClass}${portraitClass}`;
  const overlay = document.createElement('div');
  overlay.className = 'crop-editor-overlay';
  overlay.innerHTML = html`
    <div class="crop-editor-modal">
      <h3 class="crop-editor-title">${esc(t('crop_editor_title'))}</h3>
      <canvas class="${esc(canvasClass)}"
              width="${esc(previewW)}" height="${esc(previewH)}"></canvas>
      <div class="crop-editor-zoom-row">
        <span class="crop-editor-zoom-icon">−</span>
        <input type="range" class="crop-editor-zoom-slider" min="${esc(MIN_ZOOM)}" max="${esc(MAX_ZOOM)}" step="0.01" value="${esc(MIN_ZOOM)}" aria-label="${esc(t('crop_editor_zoom'))}">
        <span class="crop-editor-zoom-icon">+</span>
      </div>
      <div class="crop-editor-actions">
        <button type="button" class="lib-btn-sm crop-editor-cancel">${esc(t('lib_cancel'))}</button>
        <button type="button" class="lib-save-btn crop-editor-apply">${esc(t('crop_editor_apply'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector('.crop-editor-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const slider = overlay.querySelector('.crop-editor-zoom-slider') as HTMLInputElement;

  function draw(): void {
    ctx.clearRect(0, 0, previewW, previewH);
    const scale = baseScale * zoom;
    ctx.drawImage(img, offsetX, offsetY, naturalW * scale, naturalH * scale);
  }

  function applyClamp(): void {
    const scale = baseScale * zoom;
    const c = clampOffset(offsetX, offsetY, naturalW, naturalH, scale, previewW, previewH);
    offsetX = c.x; offsetY = c.y;
  }

  function setZoom(newZoom: number, focusX: number, focusY: number): void {
    newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
    const oldScale = baseScale * zoom;
    const newScale = baseScale * newZoom;
    const imgX = (focusX - offsetX) / oldScale;
    const imgY = (focusY - offsetY) / oldScale;
    offsetX = focusX - imgX * newScale;
    offsetY = focusY - imgY * newScale;
    zoom = newZoom;
    applyClamp();
    slider.value = String(zoom);
    draw();
  }

  draw();

  // ── Zoom: slider, wheel ──────────────────────────────────────────────
  slider.addEventListener('input', () => {
    setZoom(parseFloat(slider.value), previewW / 2, previewH / 2);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const fx = (e.clientX - rect.left) * (previewW / rect.width);
    const fy = (e.clientY - rect.top) * (previewH / rect.height);
    setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), fx, fy);
  }, { passive: false });

  // ── Pan (drag) + pinch-zoom via Pointer Events (mouse + touch) ───────
  const pointers = new Map<number, Point>();
  let panLast: Point | null = null;
  let pinchStartDist: number | null = null;
  let pinchStartZoom: number | null = null;

  function toCanvasPoint(clientX: number, clientY: number): Point {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (previewW / rect.width),
      y: (clientY - rect.top) * (previewH / rect.height),
    };
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      panLast = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (a === undefined || b === undefined) return;
      pinchStartDist = dist(a, b);
      pinchStartZoom = zoom;
      panLast = null;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && panLast) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = previewW / rect.width;
      const scaleY = previewH / rect.height;
      const dx = (e.clientX - panLast.x) * scaleX;
      const dy = (e.clientY - panLast.y) * scaleY;
      panLast = { x: e.clientX, y: e.clientY };
      offsetX += dx; offsetY += dy;
      applyClamp();
      draw();
    } else if (pointers.size === 2 && pinchStartDist) {
      const [a, b] = [...pointers.values()];
      if (a === undefined || b === undefined) return;
      const d = dist(a, b);
      const midClient = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const focus = toCanvasPoint(midClient.x, midClient.y);
      setZoom((pinchStartZoom ?? zoom) * (d / pinchStartDist), focus.x, focus.y);
    }
  });

  function endPointer(e: PointerEvent): void {
    pointers.delete(e.pointerId);
    pinchStartDist = null;
    if (pointers.size === 1) {
      const [p] = pointers.values();
      if (p === undefined) return;
      panLast = { x: p.x, y: p.y };
    } else {
      panLast = null;
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // ── Apply / Cancel ────────────────────────────────────────────────────
  function close(result: Blob | null): void {
    overlay.remove();
    resolve(result);
  }

  (overlay.querySelector('.crop-editor-cancel') as HTMLElement).addEventListener('click', () => close(null));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

  (overlay.querySelector('.crop-editor-apply') as HTMLElement).addEventListener('click', () => {
    const exportScaleX = box.exportW / previewW;
    const exportScaleY = box.exportH / previewH;
    const scale = baseScale * zoom;
    const exportOffsetX = offsetX * exportScaleX;
    const exportOffsetY = offsetY * exportScaleY;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = box.exportW;
    outCanvas.height = box.exportH;
    const outCtx = outCanvas.getContext('2d') as CanvasRenderingContext2D;
    outCtx.drawImage(img, exportOffsetX, exportOffsetY, naturalW * scale * exportScaleX, naturalH * scale * exportScaleY);
    outCanvas.toBlob((blob) => close(blob), 'image/jpeg', 0.9);
  });
}
