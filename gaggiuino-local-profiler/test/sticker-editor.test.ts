import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { featherAlpha } from '../public-src/components/sticker/mask.js';

// segment.ts is the lazy on-device cut-out runtime (onnxruntime-web + models).
// The editor imports it, so mock it here: the overlay tests must never build a
// real model session. The factory only returns vi.fn()s, so it needs no
// hoisted state.
vi.mock('../public-src/components/sticker/segment.js', () => ({
  autoCutout: vi.fn(),
  tapMask: vi.fn(),
  resetCutout: vi.fn(),
  isStickerCutoutAvailable: vi.fn(() => Promise.resolve(true)),
}));

// A tiny fake DOM: vitest runs in the node environment and the repo has no
// jsdom dependency, so the overlay's createElement/appendChild/classList/
// addEventListener/querySelector surface is faked just enough to open, cancel
// and fail. Canvas drawing is a no-op (see FakeContext); pixel output is not
// asserted here — the pure helpers above cover the maths.
interface FakeEvent {
  target?: unknown;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  deltaY?: number;
  preventDefault?: () => void;
}

type FakeListener = (event: FakeEvent) => void;

interface ClassHost {
  className: string;
}

class FakeClassList {
  private readonly host: ClassHost;

  constructor(host: ClassHost) {
    this.host = host;
  }

  private names(): string[] {
    return this.host.className.split(' ').filter(Boolean);
  }

  private write(names: string[]): void {
    this.host.className = names.join(' ');
  }

  add(...names: string[]): void {
    this.write([...new Set([...this.names(), ...names])]);
  }

  remove(...names: string[]): void {
    const set = new Set(this.names());
    for (const name of names) set.delete(name);
    this.write([...set]);
  }

  contains(name: string): boolean {
    return this.names().includes(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.contains(name);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

interface FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

class FakeContext {
  fillStyle = '';
  globalAlpha = 1;

  clearRect(_x: number, _y: number, _w: number, _h: number): void {}
  fillRect(_x: number, _y: number, _w: number, _h: number): void {}
  drawImage(..._args: unknown[]): void {}
  putImageData(..._args: unknown[]): void {}

  getImageData(_x: number, _y: number, w: number, h: number): FakeImageData {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }

  createImageData(w: number, h: number): FakeImageData {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }
}

class FakeElement implements ClassHost {
  className = '';
  readonly classList: FakeClassList;
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, FakeListener[]>();
  readonly attributes = new Map<string, string>();
  textContent = '';
  disabled = false;
  focused = false;
  type = '';
  value = '';
  min = '';
  max = '';
  width = 0;
  height = 0;
  parent: FakeElement | null = null;
  private readonly context = new FakeContext();

  constructor(_tag: string) {
    this.classList = new FakeClassList(this);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((entry) => entry !== listener));
  }

  dispatch(type: string, event: FakeEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this, ...event });
  }

  click(): void {
    this.dispatch('click');
  }

  getContext(_kind: string): FakeContext {
    return this.context;
  }

  toBlob(callback: (blob: unknown) => void): void {
    callback(null);
  }

  focus(): void {
    this.focused = true;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }

  setPointerCapture(): void {}
  releasePointerCapture(): void {}

  remove(): void {
    const parent = this.parent;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parent = null;
  }

  querySelector(selector: string): FakeElement | null {
    const className = selector.startsWith('.') ? selector.slice(1) : selector;
    for (const child of this.children) {
      if (child.classList.contains(className)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

class FakeDocument {
  readonly body = new FakeElement('body');
  readonly documentElement = new FakeElement('html');
  private readonly listeners = new Map<string, FakeListener[]>();

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  addEventListener(type: string, listener: FakeListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((entry) => entry !== listener));
  }

  dispatch(type: string, event: FakeEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
// Some modules in the import graph (state/constants) read these browser globals
// at load time; a minimal stub keeps the dynamic import below from throwing.
g.document = new FakeDocument();
g.createImageBitmap = () => Promise.resolve({ width: 120, height: 90 });

const segmentModule = await import('../public-src/components/sticker/segment.js');
const segmentCoreModule = await import('../public-src/components/sticker/segment-core.js');
const editorModule = await import('../public-src/components/sticker/editor.js');

const { maskBounds, paddedAspectCrop, MaskHistory, composeSticker, openStickerEditor, clampView, zoomAround, progressPercent, nextStage, failureMessageKey } = editorModule;
const { MODEL_DOWNLOAD_FAILED } = segmentCoreModule;
const { autoCutout, resetCutout, tapMask } = segmentModule;
const autoCutoutMock = vi.mocked(autoCutout);
const resetCutoutMock = vi.mocked(resetCutout);
const tapMaskMock = vi.mocked(tapMask);

function fillRect(
  mask: { [index: number]: number },
  w: number,
  x0: number,
  y0: number,
  rw: number,
  rh: number,
): void {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) mask[y * w + x] = 1;
  }
}

function centeredMask(w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  fillRect(mask, w, Math.floor(w * 0.3), Math.floor(h * 0.3), Math.ceil(w * 0.4), Math.ceil(h * 0.4));
  return mask;
}

describe('maskBounds', () => {
  it('returns null for an empty mask', () => {
    expect(maskBounds(new Uint8Array(4 * 4), 4, 4)).toBeNull();
  });

  it('returns the tight box of the set pixels', () => {
    const mask = new Uint8Array(5 * 4);
    fillRect(mask, 5, 1, 1, 3, 2);
    expect(maskBounds(mask, 5, 4)).toEqual({ x0:1, y0:1, x1:3, y1:2 });
  });
});

describe('paddedAspectCrop', () => {
  // aspect = 1 must reproduce the historical square results exactly.
  it('aspect 1 makes a square crop and pads it by padFrac of the longer edge', () => {
    const crop = paddedAspectCrop({ x0:50, y0:50, x1:149, y1:99 }, 200, 200, 1);
    expect(crop).toEqual({ x:46, y:21, width:108, height:108 });
  });

  it('aspect 1 clamps at the image edge instead of running off it', () => {
    const crop = paddedAspectCrop({ x0:80, y0:80, x1:99, y1:99 }, 100, 100, 1);
    expect(crop.x + crop.width).toBe(100);
    expect(crop.y + crop.height).toBe(100);
    expect(crop.width).toBe(21);
  });

  it('aspect 1 clamps a crop that would start above the top-left corner', () => {
    const crop = paddedAspectCrop({ x0:10, y0:10, x1:59, y1:39 }, 100, 100, 1);
    expect(crop.y).toBe(0);
    expect(crop.x).toBe(8);
  });

  it('gives a wide mask a 3:4 box that is taller than the mask', () => {
    const crop = paddedAspectCrop({ x0:100, y0:100, x1:199, y1:119 }, 400, 400);
    expect(crop.height).toBeGreaterThan(crop.width);
    expect(crop.height).toBeGreaterThan(20);
    expect(crop.width / crop.height).toBeCloseTo(3 / 4, 6);
  });

  it('keeps a 3:4 box for a tall mask', () => {
    const crop = paddedAspectCrop({ x0:100, y0:100, x1:149, y1:299 }, 400, 400);
    expect(crop.width / crop.height).toBeCloseTo(3 / 4, 6);
  });

  it('pads the 3:4 box beyond the mask bounds', () => {
    const crop = paddedAspectCrop({ x0:100, y0:100, x1:149, y1:149 }, 400, 400);
    expect(crop).toEqual({ x:98, y:89, width:54, height:72 });
  });

  it('clamps the 3:4 box at the image edges instead of running off it', () => {
    const crop = paddedAspectCrop({ x0:350, y0:350, x1:399, y1:399 }, 400, 400);
    expect(crop).toEqual({ x:348, y:339, width:52, height:61 });
  });

  it('returns whole-pixel bounds that still contain the padded mask', () => {
    const crop = paddedAspectCrop({ x0:300, y0:100, x1:699, y1:900 }, 1024, 1024);
    expect(Number.isInteger(crop.x)).toBe(true);
    expect(Number.isInteger(crop.y)).toBe(true);
    expect(Number.isInteger(crop.width)).toBe(true);
    expect(Number.isInteger(crop.height)).toBe(true);

    const pad = Math.round(Math.max(400, 801) * 0.04);
    expect(crop.x).toBeLessThanOrEqual(300 - pad);
    expect(crop.y).toBeLessThanOrEqual(100 - pad);
    expect(crop.x + crop.width - 1).toBeGreaterThanOrEqual(699 + pad);
    expect(crop.y + crop.height - 1).toBeGreaterThanOrEqual(900 + pad);
    expect(Math.abs(crop.width - (crop.height * 3) / 4)).toBeLessThanOrEqual(1);
  });

  it('composes a buffer sized to the whole-pixel crop', () => {
    const w = 1024;
    const h = 1024;
    const crop = paddedAspectCrop({ x0:300, y0:100, x1:699, y1:900 }, w, h);
    const rgba = new Uint8ClampedArray(w * h * 4);
    const out = composeSticker(rgba, new Uint8Array(w * h), w, h, crop);
    expect(out.width).toBe(crop.width);
    expect(out.height).toBe(crop.height);
    expect(out.data.length).toBe(crop.width * crop.height * 4);
  });
});

describe('MaskHistory', () => {
  it('never pops the first (automatic) mask', () => {
    const history = new MaskHistory();
    const auto = new Uint8Array([1, 0]);
    history.push(auto);
    expect(history.canUndo).toBe(false);
    expect(history.undo()).toBeNull();

    history.push(new Uint8Array([1, 1]));
    expect(history.canUndo).toBe(true);
    expect(history.undo()).toEqual(auto);
    expect(history.canUndo).toBe(false);
    expect(history.undo()).toBeNull();
  });

  it('caps at 20 entries while keeping the first one', () => {
    const history = new MaskHistory();
    for (let i = 0; i < 25; i++) history.push(new Uint8Array([i]));

    let undos = 0;
    let last: Uint8Array | null = null;
    while (history.canUndo) {
      const previous = history.undo();
      if (!previous) break;
      undos += 1;
      last = previous;
    }
    expect(undos).toBe(19);
    expect(last?.[0]).toBe(0);
    expect(history.undo()).toBeNull();
  });
});

describe('composeSticker', () => {
  it('copies the crop region and takes alpha from the feathered mask', () => {
    const w = 5;
    const h = 1;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let x = 0; x < w; x++) {
      rgba[x * 4] = x * 10;
      rgba[x * 4 + 1] = 100;
      rgba[x * 4 + 2] = 200;
      rgba[x * 4 + 3] = 255;
    }
    const alpha = new Uint8Array([0, 0, 1, 0, 0]);
    const out = composeSticker(rgba, alpha, w, h, { x:0, y:0, width:5, height:1 });

    expect(out.width).toBe(5);
    expect(out.height).toBe(1);
    expect(out.data[4]).toBe(10);
    expect(out.data[2 * 4 + 3]).toBe(85);
    expect(out.data[3]).toBe(0);
    expect(out.data[4 * 4 + 3]).toBe(0);

    const feathered = featherAlpha(alpha, w, h);
    for (let x = 0; x < w; x++) expect(out.data[x * 4 + 3]).toBe(feathered[x]);
  });

  it('sizes the result to the crop, not the source', () => {
    const w = 4;
    const h = 4;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const out = composeSticker(rgba, new Uint8Array(w * h), w, h, { x:1, y:2, width:2, height:1 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(1);
    expect(out.data.length).toBe(2 * 1 * 4);
  });
});

describe('clampView', () => {
  it('clamps the scale to 1..6 and is the identity at scale 1', () => {
    expect(clampView({ scale: 0.2, x: 0, y: 0 }, 100, 100, 100, 100).scale).toBe(1);
    expect(clampView({ scale: 99, x: 0, y: 0 }, 100, 100, 100, 100).scale).toBe(6);
    expect(clampView({ scale: 1, x: 0, y: 0 }, 100, 100, 100, 100)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('clamps the pan so the scaled canvas always covers the viewport', () => {
    const farLeft = clampView({ scale: 2, x: 1000, y: 1000 }, 100, 100, 100, 100);
    expect(farLeft.x).toBe(0);
    expect(farLeft.y).toBe(0);

    const farRight = clampView({ scale: 2, x: -1000, y: -1000 }, 100, 100, 100, 100);
    expect(farRight.x).toBe(-100);
    expect(farRight.y).toBe(-100);
  });
});

describe('zoomAround', () => {
  it('keeps the content point under the cursor fixed', () => {
    const view = zoomAround({ scale: 1, x: 0, y: 0 }, 2, 50, 40);
    expect(view.scale).toBe(2);
    expect(view.x).toBe(-50);
    expect(view.y).toBe(-40);
    // The point that was at (50, 40) is still at (50, 40).
    expect(50 * view.scale + view.x).toBe(50);
    expect(40 * view.scale + view.y).toBe(40);
  });

  it('clamps the scale at the maximum', () => {
    expect(zoomAround({ scale: 5, x: 0, y: 0 }, 2, 0, 0).scale).toBe(6);
  });
});

describe('progressPercent', () => {
  it('maps each stage to its own share of the bar', () => {
    expect(progressPercent('download', 0, 0)).toBe(0);
    expect(progressPercent('download', 0.5, 0)).toBe(15);
    expect(progressPercent('download', 1, 0)).toBe(30);
    expect(progressPercent('background', null, 0)).toBe(30);
    expect(progressPercent('subject', null, 0)).toBe(65);
  });

  it('eases forward inside a compute stage and caps just below its end', () => {
    const early = progressPercent('background', null, 1000);
    const later = progressPercent('background', null, 4000);
    expect(early).toBeGreaterThan(30);
    expect(later).toBeGreaterThan(early);
    expect(progressPercent('background', null, Number.MAX_SAFE_INTEGER)).toBeLessThan(65);
    expect(progressPercent('subject', null, Number.MAX_SAFE_INTEGER)).toBeLessThan(95);
  });

  it('clamps a download fraction into its range', () => {
    expect(progressPercent('download', 2, 0)).toBe(30);
    expect(progressPercent('download', -1, 0)).toBe(0);
  });
});

describe('nextStage', () => {
  it('advances to a later stage and stays put on the same one', () => {
    expect(nextStage('download', 'background')).toBe('background');
    expect(nextStage('background', 'subject')).toBe('subject');
    expect(nextStage('background', 'background')).toBe('background');
  });

  it('keeps the current stage when an earlier one arrives', () => {
    expect(nextStage('background', 'download')).toBe('background');
    expect(nextStage('subject', 'download')).toBe('subject');
    expect(nextStage('subject', 'background')).toBe('subject');
  });
});

describe('failureMessageKey', () => {
  it('picks the download-specific message for a model download failure', () => {
    expect(failureMessageKey(new Error(`${MODEL_DOWNLOAD_FAILED} (network)`))).toBe('sticker_download_failed');
    expect(failureMessageKey(new Error(`${MODEL_DOWNLOAD_FAILED} (incomplete)`))).toBe('sticker_download_failed');
  });

  it('picks the generic message for any other error or a missing one', () => {
    expect(failureMessageKey(new Error('boom'))).toBe('sticker_failed');
    expect(failureMessageKey('segment: model download failed')).toBe('sticker_failed');
    expect(failureMessageKey(undefined)).toBe('sticker_failed');
  });
});

describe('openStickerEditor overlay', () => {
  let doc: FakeDocument;

  beforeEach(() => {
    doc = new FakeDocument();
    g.document = doc;
    g.createImageBitmap = vi.fn(() => Promise.resolve({ width: 120, height: 90 }));
    autoCutoutMock.mockReset();
    resetCutoutMock.mockReset();
    tapMaskMock.mockReset();
    autoCutoutMock.mockImplementation((_rgba, w, h) => Promise.resolve(centeredMask(w, h)));
    tapMaskMock.mockImplementation((_x, _y, _mode, w, h) => Promise.resolve(new Uint8Array(w * h)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function open(): Promise<Blob | null> {
    return openStickerEditor(new Blob(['photo'], { type: 'image/png' }));
  }

  async function openReady(): Promise<{ overlay: FakeElement; promise: Promise<Blob | null> }> {
    const promise = open();
    await vi.waitFor(() => expect(doc.body.children.length).toBe(1));
    const overlay = doc.body.children[0];
    if (!overlay) throw new Error('overlay not found');
    await vi.waitFor(() => expect(overlay.querySelector('.sticker-apply')?.disabled).toBe(false));
    return { overlay, promise };
  }

  function node(overlay: FakeElement, selector: string): FakeElement {
    const found = overlay.querySelector(selector);
    if (!found) throw new Error(`${selector} not found`);
    return found;
  }

  function readScale(canvas: FakeElement): number {
    const match = /scale\(([-\d.]+)\)/.exec(canvas.style.transform ?? '');
    return match?.[1] !== undefined ? Number(match[1]) : Number.NaN;
  }

  it('maps a tap through the canvas transform', async () => {
    const { overlay } = await openReady();
    const canvas = node(overlay, '.sticker-canvas');
    const viewport = node(overlay, '.sticker-viewport');
    // The canvas is displayed at 2x and offset by (10, 20); the buffer stays
    // 120x90, so client pixels must be divided back through that rect.
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 240, height: 180 });

    viewport.dispatch('pointerdown', { pointerId: 1, clientX: 70, clientY: 80 });
    viewport.dispatch('pointerup', { pointerId: 1, clientX: 70, clientY: 80 });

    await vi.waitFor(() => expect(tapMaskMock).toHaveBeenCalled());
    expect(tapMaskMock).toHaveBeenCalledWith(30, 30, 1, 120, 90);
  });

  it('raises the scale on a pinch and rolls a running brush stroke back', async () => {
    const { overlay } = await openReady();
    const canvas = node(overlay, '.sticker-canvas');
    const viewport = node(overlay, '.sticker-viewport');
    const undo = node(overlay, '.sticker-undo');
    const brush = node(overlay, '.sticker-brush-toggle');

    brush.click();
    expect(brush.getAttribute('aria-pressed')).toBe('true');

    viewport.dispatch('pointerdown', { pointerId: 1, clientX: 40, clientY: 40 });
    viewport.dispatch('pointermove', { pointerId: 1, clientX: 55, clientY: 40 });
    // A second finger switches to gesture mode and aborts the stroke.
    viewport.dispatch('pointerdown', { pointerId: 2, clientX: 100, clientY: 40 });
    // The finger span goes from 45px (100 - 55) to 90px, doubling the scale.
    viewport.dispatch('pointermove', { pointerId: 2, clientX: 145, clientY: 40 });

    expect(readScale(canvas)).toBe(2);
    // The aborted stroke was rolled back, so nothing was committed to history.
    expect(undo.disabled).toBe(true);

    // Lifting one finger after a pinch fires no tap; the gesture lasts until
    // every pointer is up.
    viewport.dispatch('pointerup', { pointerId: 2, clientX: 145, clientY: 40 });
    viewport.dispatch('pointerup', { pointerId: 1, clientX: 40, clientY: 40 });
    expect(tapMaskMock).not.toHaveBeenCalled();
  });

  it('zooms around the cursor on wheel', async () => {
    const { overlay } = await openReady();
    const canvas = node(overlay, '.sticker-canvas');
    const viewport = node(overlay, '.sticker-viewport');
    const preventDefault = vi.fn();

    viewport.dispatch('wheel', { deltaY: -100, clientX: 60, clientY: 45, preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(readScale(canvas)).toBeCloseTo(1.1);
  });

  it('Fit resets the zoom and is disabled at scale 1', async () => {
    const { overlay } = await openReady();
    const canvas = node(overlay, '.sticker-canvas');
    const viewport = node(overlay, '.sticker-viewport');
    const fit = node(overlay, '.sticker-fit');

    expect(fit.disabled).toBe(true);
    viewport.dispatch('pointerdown', { pointerId: 1, clientX: 40, clientY: 40 });
    viewport.dispatch('pointerdown', { pointerId: 2, clientX: 100, clientY: 40 });
    viewport.dispatch('pointermove', { pointerId: 2, clientX: 160, clientY: 40 });
    expect(fit.disabled).toBe(false);

    fit.click();
    expect(fit.disabled).toBe(true);
    expect(canvas.style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('closes the decoded bitmap when the editor closes', async () => {
    const close = vi.fn();
    g.createImageBitmap = vi.fn(() => Promise.resolve({ width: 120, height: 90, close }));
    const { overlay, promise } = await openReady();

    node(overlay, '.sticker-cancel').click();

    await expect(promise).resolves.toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('drops a cut-out that resolves after the editor was closed', async () => {
    const deferred: { resolve?: (mask: Uint8Array) => void } = {};
    autoCutoutMock.mockReset();
    autoCutoutMock.mockImplementation(
      () => new Promise<Uint8Array>((resolve) => {
        deferred.resolve = resolve;
      }),
    );

    const promise = open();
    await vi.waitFor(() => expect(doc.body.children.length).toBe(1));
    const overlay = doc.body.children[0];
    if (!overlay) throw new Error('overlay not found');
    node(overlay, '.sticker-cancel').click();
    await expect(promise).resolves.toBeNull();
    expect(resetCutoutMock).toHaveBeenCalledTimes(1);

    const resolveCut = deferred.resolve;
    if (!resolveCut) throw new Error('autoCutout was not called');
    resolveCut(new Uint8Array(4));
    // The late ready() must drop the embeddings it computed after the close.
    await vi.waitFor(() => expect(resetCutoutMock).toHaveBeenCalledTimes(2));
  });

  it('opens the overlay after a successful cut-out and Cancel resolves null', async () => {
    const promise = open();
    await vi.waitFor(() => expect(doc.body.children.length).toBe(1));
    const overlay = doc.body.children[0];
    expect(overlay).toBeDefined();
    expect(autoCutoutMock).toHaveBeenCalledTimes(1);

    const cancel = overlay?.querySelector('.sticker-cancel');
    if (!cancel) throw new Error('cancel button not found');
    cancel.click();

    await expect(promise).resolves.toBeNull();
    expect(doc.body.children.length).toBe(0);
    expect(resetCutoutMock).toHaveBeenCalledTimes(1);
  });

  it('renders a progress bar that is hidden once the cut-out is ready', async () => {
    const { overlay } = await openReady();

    const bar = node(overlay, '.sticker-progress');
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    expect(bar.style.display).toBe('none');
  });

  it('shows the failure line and only Close when the model fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    autoCutoutMock.mockReset();
    autoCutoutMock.mockRejectedValue(new Error('model boom'));

    const promise = open();
    await vi.waitFor(() => expect(doc.body.children.length).toBe(1));
    const overlay = doc.body.children[0];

    await vi.waitFor(() => {
      expect(overlay?.querySelector('.sticker-failed')?.textContent)
        .toBe('This photo would not peel. You can still use it as it is.');
    });
    const close = overlay?.querySelector('.sticker-close');
    if (!close) throw new Error('close button not found');
    expect(close.style.display).not.toBe('none');
    expect(errorSpy).toHaveBeenCalled();

    close.click();
    await expect(promise).resolves.toBeNull();
    expect(doc.body.children.length).toBe(0);
  });
});
