// #1845 slice 4: openCropEditor() returns the crop rectangle and the
// uncropped original next to the main JPEG, so a later slice can re-crop a
// stored photo. vitest runs in the node environment with no DOM, so the sliver
// the dialog touches is faked here (same approach as test/photo-capture.test.ts
// and test/backup-modal-preview.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };

// The dialog only needs a handle back; the real helper needs a live document.
vi.mock('../public-src/components/dialog-a11y.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/components/dialog-a11y.js')>();
  return { ...actual, attachDialogKeyboard: () => ({ release: () => {} }) };
});

const { openCropEditor, viewToCrop, coverBaseScale } =
  await import('../public-src/components/image-crop.js');

interface BlobCall {
  type: string | undefined;
  quality: number | undefined;
  width: number;
  height: number;
}

interface FakeCanvas extends FakeEl {
  width: number;
  height: number;
  toBlob: (cb: (blob: Blob | null) => void, type?: string, quality?: number) => void;
  getContext: () => Record<string, unknown>;
}

type Listener = (event?: unknown) => void;

class FakeEl {
  className = '';
  innerHTML = '';
  value = '';
  removed = false;
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly children: FakeEl[] = [];

  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  appendChild(child: FakeEl): FakeEl { this.children.push(child); return child; }
  remove(): void { this.removed = true; }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  fire(type: string, event?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  querySelector(selector: string): FakeEl | null { return this.parts.get(selector) ?? null; }
  querySelectorAll(): FakeEl[] { return []; }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 320, height: 320 };
  }
  setPointerCapture(): void { /* pointer capture is browser-only */ }
  focus(): void { /* focus is browser-only */ }
  readonly parts = new Map<string, FakeEl>();
}

function fakeDocument(): Record<string, unknown> {
  const canvases: FakeCanvas[] = [];
  const overlays: FakeEl[] = [];
  const doc: Record<string, unknown> = {
    canvases,
    overlays,
    onToBlob: null as ((canvas: FakeCanvas, cb: (blob: Blob | null) => void) => void) | null,
    createElement(tag: string): FakeEl {
      if (tag === 'canvas') {
        const canvas = new FakeEl() as FakeCanvas;
        canvas.width = 0;
        canvas.height = 0;
        canvas.getContext = (): Record<string, unknown> => ({
          clearRect: () => {},
          drawImage: () => {},
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
        });
        canvas.toBlob = (cb: (blob: Blob | null) => void, type?: string, quality?: number): void => {
          blobCalls.push({ type, quality, width: canvas.width, height: canvas.height });
          const handler = doc['onToBlob'] as ((c: FakeCanvas, b: (blob: Blob | null) => void) => void) | null;
          if (handler) handler(canvas, cb);
          else cb({ size: 1 } as Blob);
        };
        canvases.push(canvas);
        return canvas;
      }
      const el = new FakeEl();
      if (tag === 'div') {
        // The overlay's modal markup: give querySelector the real hooks.
        el.parts.set('.crop-editor-canvas', Object.assign(new FakeEl(), {
          getContext: () => ({
            clearRect: () => {},
            drawImage: () => {},
            imageSmoothingEnabled: false,
            imageSmoothingQuality: 'low',
          }),
        }));
        el.parts.set('.crop-editor-zoom-slider', new FakeEl());
        el.parts.set('.crop-editor-cancel', new FakeEl());
        el.parts.set('.crop-editor-apply', new FakeEl());
        overlays.push(el);
      }
      return el;
    },
    body: new FakeEl(),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    contains: (): boolean => true,
  };
  return doc;
}

let blobCalls: BlobCall[] = [];

class FakeFileReader {
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  result = 'data:image/jpeg;base64,AAAA';
  readAsDataURL(): void {
    queueMicrotask(() => this.onload?.());
  }
}

class FakeImage {
  naturalWidth = 4000;
  naturalHeight = 3000;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function lastOverlay(): FakeEl {
  const doc = g.document as { overlays: FakeEl[] };
  const overlay = doc.overlays[doc.overlays.length - 1];
  if (!overlay) throw new Error('no overlay created');
  return overlay;
}

function part(name: string): FakeEl {
  const el = lastOverlay().parts.get(name);
  if (!el) throw new Error(`missing ${name}`);
  return el;
}

beforeEach(() => {
  blobCalls = [];
  g.document = fakeDocument();
  g.FileReader = FakeFileReader;
  g.Image = FakeImage;
});

afterEach(() => {
  delete g.document;
  delete g.FileReader;
  delete g.Image;
});

const FILE = { size: 10, type: 'image/jpeg' } as Blob;

describe('openCropEditor() apply (#1845)', () => {
  it('resolves the main JPEG, the crop and a 1600 px original', async () => {
    const pending = openCropEditor(FILE);
    await flush();
    part('.crop-editor-apply').fire('click');
    const result = await pending;

    expect(result).not.toBeNull();
    expect(result?.crop).toEqual({ x: 0.125, y: 0, w: 0.75, h: 1 });
    expect(result?.blob).toBeTruthy();
    expect(result?.original).toBeTruthy();

    expect(blobCalls).toEqual([
      { type: 'image/jpeg', quality: 0.92, width: 1600, height: 1600 },
      { type: 'image/jpeg', quality: 0.85, width: 1600, height: 1200 },
    ]);
    expect(lastOverlay().removed).toBe(true);
  });

  it('starts from initialCrop and returns it unchanged', async () => {
    const base = coverBaseScale(4000, 3000, 320, 320);
    const scale = base * 2;
    const crop = viewToCrop(-500, -100, scale, 4000, 3000, 320, 320);

    const pending = openCropEditor(FILE, { initialCrop: crop });
    await flush();
    part('.crop-editor-apply').fire('click');
    const result = await pending;

    expect(result?.crop.x).toBeCloseTo(crop.x, 5);
    expect(result?.crop.y).toBeCloseTo(crop.y, 5);
    expect(result?.crop.w).toBeCloseTo(crop.w, 5);
    expect(result?.crop.h).toBeCloseTo(crop.h, 5);
  });

  it('ignores an invalid initialCrop and starts centred', async () => {
    const pending = openCropEditor(FILE, { initialCrop: { x: -1, y: 0, w: 1, h: 1 } });
    await flush();
    part('.crop-editor-apply').fire('click');
    const result = await pending;
    expect(result?.crop).toEqual({ x: 0.125, y: 0, w: 0.75, h: 1 });
  });

  it('resolves with original: null when the original cannot be encoded', async () => {
    const doc = g.document as Record<string, unknown>;
    doc['onToBlob'] = (canvas: FakeCanvas, cb: (blob: Blob | null) => void): void => {
      cb(canvas.width === 1600 && canvas.height === 1200 ? null : ({ size: 1 } as Blob));
    };

    const pending = openCropEditor(FILE);
    await flush();
    part('.crop-editor-apply').fire('click');
    const result = await pending;

    expect(result?.blob).toBeTruthy();
    expect(result?.original).toBeNull();
  });
});

describe('openCropEditor() hint (#1845)', () => {
  it('renders the escaped hint under the title', async () => {
    const pending = openCropEditor(FILE, { hint: 'Some <hint> & more' });
    await flush();
    const markup = lastOverlay().innerHTML;
    expect(markup).toContain('crop-editor-hint');
    expect(markup).toContain('Some &lt;hint&gt; &amp; more');
    part('.crop-editor-cancel').fire('click');
    expect(await pending).toBeNull();
  });

  it('adds no hint element when there is no hint', async () => {
    const pending = openCropEditor(FILE);
    await flush();
    expect(lastOverlay().innerHTML).not.toContain('crop-editor-hint');
    part('.crop-editor-cancel').fire('click');
    expect(await pending).toBeNull();
  });
});

describe('openCropEditor() cancel (#1845)', () => {
  it('resolves null from the cancel button without exporting', async () => {
    const pending = openCropEditor(FILE);
    await flush();
    part('.crop-editor-cancel').fire('click');
    expect(await pending).toBeNull();
    expect(blobCalls).toEqual([]);
    expect(lastOverlay().removed).toBe(true);
  });

  it('resolves null from a backdrop click without exporting', async () => {
    const pending = openCropEditor(FILE);
    await flush();
    const overlay = lastOverlay();
    overlay.fire('click', { target: overlay });
    expect(await pending).toBeNull();
    expect(blobCalls).toEqual([]);
  });
});

describe('openCropEditor() portrait export (#1845)', () => {
  it('exports the main image in the portrait box and the original in the source aspect', async () => {
    const pending = openCropEditor(FILE, { aspect: 'portrait' });
    await flush();
    part('.crop-editor-apply').fire('click');
    const result = await pending;

    expect(result?.blob).toBeTruthy();
    expect(result?.original).toBeTruthy();
    // Main export follows the portrait box; the original keeps the source aspect.
    expect(blobCalls.map((c) => `${c.width}x${c.height}`)).toEqual(['1200x1600', '1600x1200']);
  });
});
