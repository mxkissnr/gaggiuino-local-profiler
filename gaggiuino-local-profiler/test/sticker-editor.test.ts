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
const editorModule = await import('../public-src/components/sticker/editor.js');

const { maskBounds, paddedSquareCrop, MaskHistory, composeSticker, openStickerEditor } = editorModule;
const { autoCutout, resetCutout } = segmentModule;
const autoCutoutMock = vi.mocked(autoCutout);
const resetCutoutMock = vi.mocked(resetCutout);

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

describe('paddedSquareCrop', () => {
  it('makes a square crop and pads it by padFrac of the longer edge', () => {
    const crop = paddedSquareCrop({ x0:50, y0:50, x1:149, y1:99 }, 200, 200);
    expect(crop).toEqual({ x:46, y:21, width:108, height:108 });
  });

  it('clamps at the image edge instead of running off it', () => {
    const crop = paddedSquareCrop({ x0:80, y0:80, x1:99, y1:99 }, 100, 100);
    expect(crop.x + crop.width).toBe(100);
    expect(crop.y + crop.height).toBe(100);
    expect(crop.width).toBe(21);
  });

  it('clamps a crop that would start above the top-left corner', () => {
    const crop = paddedSquareCrop({ x0:10, y0:10, x1:59, y1:39 }, 100, 100);
    expect(crop.y).toBe(0);
    expect(crop.x).toBe(8);
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

describe('openStickerEditor overlay', () => {
  let doc: FakeDocument;

  beforeEach(() => {
    doc = new FakeDocument();
    g.document = doc;
    g.createImageBitmap = vi.fn(() => Promise.resolve({ width: 120, height: 90 }));
    autoCutoutMock.mockReset();
    resetCutoutMock.mockReset();
    autoCutoutMock.mockImplementation((_rgba, w, h) => Promise.resolve(centeredMask(w, h)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function open(): Promise<Blob | null> {
    return openStickerEditor(new Blob(['photo'], { type: 'image/png' }));
  }

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
