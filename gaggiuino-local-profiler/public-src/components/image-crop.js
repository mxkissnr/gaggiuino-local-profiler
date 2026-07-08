// Reusable zoom + pan crop editor for photo uploads (#286).
// Opens a modal over the picked file, lets the user zoom (slider/wheel/pinch)
// and pan (drag/touch) an image against a fixed crop guide, then exports a
// square JPEG blob that feeds into the existing upload flow unchanged.
import { t } from '../i18n.js';
import { esc } from '../utils.js';

const PREVIEW_SIZE = 320; // on-screen canvas, CSS px == canvas px (no DPR scaling needed for a preview)
const EXPORT_SIZE   = 480; // exported square buffer, reasonable thumbnail size
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Computes the zoom/pan → source-rect crop math shared between the live
// preview draw and the final export. Kept pure so it's unit-testable.
export function coverBaseScale(naturalW, naturalH, boxSize) {
  return Math.max(boxSize / naturalW, boxSize / naturalH);
}

export function clampOffset(offsetX, offsetY, naturalW, naturalH, scale, boxSize) {
  const scaledW = naturalW * scale;
  const scaledH = naturalH * scale;
  const minX = boxSize - scaledW;
  const minY = boxSize - scaledH;
  return {
    x: Math.min(0, Math.max(minX, offsetX)),
    y: Math.min(0, Math.max(minY, offsetY)),
  };
}

// Opens the crop editor for `file`. `shape` ('circle' | 'square') only
// affects the preview guide — the exported buffer is always a square JPEG,
// consistent with how object-fit:cover + border-radius renders thumbnails
// elsewhere in the app.
// Resolves with a Blob on Apply, or null on Cancel / load failure.
export function openImageCropEditor(file, { shape = 'circle' } = {}) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(null);
      img.onload = () => _buildEditor(img, shape, resolve);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function _buildEditor(img, shape, resolve) {
  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  const baseScale = coverBaseScale(naturalW, naturalH, PREVIEW_SIZE);

  let zoom = MIN_ZOOM;
  let offsetX = (PREVIEW_SIZE - naturalW * baseScale) / 2;
  let offsetY = (PREVIEW_SIZE - naturalH * baseScale) / 2;

  const overlay = document.createElement('div');
  overlay.className = 'crop-editor-overlay';
  overlay.innerHTML = `
    <div class="crop-editor-modal">
      <h3 class="crop-editor-title">${esc(t('crop_editor_title'))}</h3>
      <canvas class="crop-editor-canvas crop-editor-canvas-${shape === 'square' ? 'square' : 'circle'}"
              width="${PREVIEW_SIZE}" height="${PREVIEW_SIZE}"></canvas>
      <div class="crop-editor-zoom-row">
        <span class="crop-editor-zoom-icon">−</span>
        <input type="range" class="crop-editor-zoom-slider" min="${MIN_ZOOM}" max="${MAX_ZOOM}" step="0.01" value="${MIN_ZOOM}" aria-label="${esc(t('crop_editor_zoom'))}">
        <span class="crop-editor-zoom-icon">+</span>
      </div>
      <div class="crop-editor-actions">
        <button type="button" class="lib-btn-sm crop-editor-cancel">${esc(t('lib_cancel'))}</button>
        <button type="button" class="lib-save-btn crop-editor-apply">${esc(t('crop_editor_apply'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const canvas = overlay.querySelector('.crop-editor-canvas');
  const ctx = canvas.getContext('2d');
  const slider = overlay.querySelector('.crop-editor-zoom-slider');

  function draw() {
    ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    const scale = baseScale * zoom;
    ctx.drawImage(img, offsetX, offsetY, naturalW * scale, naturalH * scale);
  }

  function applyClamp() {
    const scale = baseScale * zoom;
    const c = clampOffset(offsetX, offsetY, naturalW, naturalH, scale, PREVIEW_SIZE);
    offsetX = c.x; offsetY = c.y;
  }

  function setZoom(newZoom, focusX, focusY) {
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
    setZoom(parseFloat(slider.value), PREVIEW_SIZE / 2, PREVIEW_SIZE / 2);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const fx = (e.clientX - rect.left) * (PREVIEW_SIZE / rect.width);
    const fy = (e.clientY - rect.top) * (PREVIEW_SIZE / rect.height);
    setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), fx, fy);
  }, { passive: false });

  // ── Pan (drag) + pinch-zoom via Pointer Events (mouse + touch) ───────
  const pointers = new Map();
  let panLast = null;
  let pinchStartDist = null;
  let pinchStartZoom = null;

  function toCanvasPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (PREVIEW_SIZE / rect.width),
      y: (clientY - rect.top) * (PREVIEW_SIZE / rect.height),
    };
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      panLast = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      const pts = [...pointers.values()];
      pinchStartDist = dist(pts[0], pts[1]);
      pinchStartZoom = zoom;
      panLast = null;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && panLast) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = PREVIEW_SIZE / rect.width;
      const scaleY = PREVIEW_SIZE / rect.height;
      const dx = (e.clientX - panLast.x) * scaleX;
      const dy = (e.clientY - panLast.y) * scaleY;
      panLast = { x: e.clientX, y: e.clientY };
      offsetX += dx; offsetY += dy;
      applyClamp();
      draw();
    } else if (pointers.size === 2 && pinchStartDist) {
      const pts = [...pointers.values()];
      const d = dist(pts[0], pts[1]);
      const midClient = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const focus = toCanvasPoint(midClient.x, midClient.y);
      setZoom(pinchStartZoom * (d / pinchStartDist), focus.x, focus.y);
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    pinchStartDist = null;
    if (pointers.size === 1) {
      const [p] = pointers.values();
      panLast = { x: p.x, y: p.y };
    } else {
      panLast = null;
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // ── Apply / Cancel ────────────────────────────────────────────────────
  function close(result) {
    overlay.remove();
    resolve(result);
  }

  overlay.querySelector('.crop-editor-cancel').addEventListener('click', () => close(null));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

  overlay.querySelector('.crop-editor-apply').addEventListener('click', () => {
    const exportScaleFactor = EXPORT_SIZE / PREVIEW_SIZE;
    const scale = baseScale * zoom * exportScaleFactor;
    const exportOffsetX = offsetX * exportScaleFactor;
    const exportOffsetY = offsetY * exportScaleFactor;

    const outCanvas = document.createElement('canvas');
    outCanvas.width = EXPORT_SIZE;
    outCanvas.height = EXPORT_SIZE;
    const outCtx = outCanvas.getContext('2d');
    outCtx.drawImage(img, exportOffsetX, exportOffsetY, naturalW * scale, naturalH * scale);
    outCanvas.toBlob((blob) => close(blob), 'image/jpeg', 0.9);
  });
}
