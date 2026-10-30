// #1836: openPhotoInput()/canTakePhoto() drive the "Take photo" buttons that
// reuse each field's existing hidden file input. vitest runs in the node
// environment with no browser globals, so the sliver each function touches is
// faked here (same approach as test/theme.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openPhotoInput, canTakePhoto, showCameraButtons, closeCameraModal } from '../public-src/photo-capture.js';

const g = globalThis as unknown as Record<string, unknown>;

interface FakeInput {
  attrs: Map<string, string>;
  clicks: number;
  files: File[] | null;
  events: { type: string; bubbles?: boolean }[];
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  click: () => void;
  dispatchEvent: (event: { type: string; bubbles?: boolean }) => void;
}

function fakeInput(): FakeInput {
  const input: FakeInput = {
    attrs: new Map<string, string>(),
    clicks: 0,
    files: null,
    events: [],
    setAttribute: (name, value) => { input.attrs.set(name, value); },
    removeAttribute: (name) => { input.attrs.delete(name); },
    click: () => { input.clicks += 1; },
    dispatchEvent: (event) => { input.events.push(event); },
  };
  return input;
}

const asInput = (input: FakeInput): HTMLInputElement => input as unknown as HTMLInputElement;

function stubMedia(coarse: boolean): void {
  g.window = {
    matchMedia: (query: string) => ({ matches: coarse && query === '(pointer: coarse)' }),
  };
}

beforeEach(() => {
  delete g.window;
});

afterEach(() => {
  delete g.window;
  delete g.document;
});

describe('openPhotoInput() with a live camera (#1836)', () => {
  interface FakeTrack {
    stopped: boolean;
    stop: () => void;
    getCapabilities?: () => FocusCaps;
    applyConstraints: (constraints: unknown) => Promise<void>;
  }
  interface FocusCaps { focusMode?: string[]; pointsOfInterest?: unknown }
  interface FakeStream { getTracks: () => FakeTrack[]; getVideoTracks: () => FakeTrack[] }

  function fakeStream(caps?: FocusCaps): { stream: FakeStream; tracks: FakeTrack[]; applied: unknown[] } {
    const applied: unknown[] = [];
    const track = (): FakeTrack => ({
      stopped: false,
      stop(): void { this.stopped = true; },
      applyConstraints: (constraints): Promise<void> => {
        applied.push(constraints);
        return Promise.resolve();
      },
    });
    const video = track();
    if (caps) video.getCapabilities = (): FocusCaps => caps;
    const tracks: FakeTrack[] = [video, track()];
    return {
      stream: { getTracks: () => tracks, getVideoTracks: () => [video] },
      tracks,
      applied,
    };
  }

  interface FakeEl {
    id: string;
    tone: Set<string>;
    classList: { add: (t: string) => void; remove: (t: string) => void; contains: (t: string) => boolean };
    srcObject: unknown;
    videoWidth: number;
    videoHeight: number;
    attrs: Map<string, string>;
    listeners: Map<string, (event?: unknown) => void>;
    style: Record<string, string>;
    className: string;
    parentElement: { appendChild: (child: FakeEl) => void } | null;
    setAttribute: (name: string, value: string) => void;
    hasAttribute: (name: string) => boolean;
    focus: () => void;
    querySelectorAll: () => unknown[];
    getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
    addEventListener: (type: string, fn: (event?: unknown) => void, opts?: { signal?: AbortSignal }) => void;
    removeEventListener: (type: string) => void;
    fire: (type: string, event?: unknown) => void;
    remove: () => void;
  }

  function fakeEl(id: string): FakeEl {
    const el: FakeEl = {
      id,
      tone: new Set<string>(),
      classList: {
        add: (t): void => { el.tone.add(t); },
        remove: (t): void => { el.tone.delete(t); },
        contains: (t): boolean => el.tone.has(t),
      },
      srcObject: null,
      videoWidth: 640,
      videoHeight: 480,
      attrs: new Map<string, string>(),
      listeners: new Map<string, (event?: unknown) => void>(),
      style: {},
      className: '',
      parentElement: null,
      setAttribute: (name, value): void => { el.attrs.set(name, value); },
      hasAttribute: (name): boolean => el.attrs.has(name),
      focus: (): void => {},
      querySelectorAll: (): unknown[] => [],
      getBoundingClientRect: (): { left: number; top: number; width: number; height: number } => ({
        left: 0, top: 0, width: 640, height: 480,
      }),
      addEventListener: (type, fn, opts): void => {
        el.listeners.set(type, fn);
        opts?.signal?.addEventListener('abort', () => el.listeners.delete(type));
      },
      removeEventListener: (type): void => { el.listeners.delete(type); },
      fire: (type, event?: unknown): void => { el.listeners.get(type)?.(event); },
      remove: (): void => { el.tone.add('removed'); },
    };
    return el;
  }

  interface FakeContext {
    drawImage: (...args: unknown[]) => void;
    imageSmoothingEnabled?: boolean;
    imageSmoothingQuality?: string;
  }

  interface FakeCanvas {
    width: number;
    height: number;
    getContext: () => FakeContext | null;
    toBlob: (cb: (blob: Blob | null) => void, type?: string, quality?: number) => void;
  }

  type KeydownFn = (e: { key: string; preventDefault: () => void }) => void;

  function stubDom(drawable = true, withBlob = true) {
    const modal = fakeEl('photoCameraModal');
    const video = fakeEl('photoCameraVideo');
    const shutter = fakeEl('photoCameraShutter');
    const cancel = fakeEl('photoCameraCancelBtn');
    const keydown = new Set<KeydownFn>();
    const canvases: FakeCanvas[] = [];
    const draws: unknown[][] = [];
    const rings: FakeEl[] = [];
    // The viewport wrapper that receives the tap-to-focus ring.
    video.parentElement = { appendChild: (child: FakeEl): void => { rings.push(child); } };
    const els: Record<string, FakeEl> = {
      photoCameraModal: modal, photoCameraVideo: video,
      photoCameraShutter: shutter, photoCameraCancelBtn: cancel,
    };
    g.document = {
      getElementById: (id: string): FakeEl | null => els[id] ?? null,
      createElement: (tag?: string): FakeCanvas | FakeEl => {
        if (tag === 'div') return fakeEl('div');
        const canvas: FakeCanvas = {
          width: 0,
          height: 0,
          getContext: (): FakeContext | null => (drawable
            ? {
              imageSmoothingEnabled: false,
              imageSmoothingQuality: 'low',
              drawImage: (...args: unknown[]): void => { draws.push(args); },
            }
            : null),
          toBlob: (cb): void => {
            cb(withBlob ? new Blob(['jpeg'], { type: 'image/jpeg' }) : null);
          },
        };
        canvases.push(canvas);
        return canvas;
      },
      activeElement: null,
      body: null,
      contains: (): boolean => true,
      addEventListener: (type: string, fn: KeydownFn): void => {
        if (type === 'keydown') keydown.add(fn);
      },
      removeEventListener: (type: string, fn: KeydownFn): void => {
        if (type === 'keydown') keydown.delete(fn);
      },
    };
    return {
      modal, video, shutter, cancel, canvases, draws, rings,
      escape(): void { for (const fn of keydown) fn({ key: 'Escape', preventDefault: () => {} }); },
      keydownCount: (): number => keydown.size,
    };
  }

  // Node has no DataTransfer; the implementation only needs items.add + files.
  class FakeDataTransfer {
    readonly added: File[] = [];
    readonly items = { add: (file: File): void => { this.added.push(file); } };
    get files(): File[] { return this.added; }
  }

  function stubCamera(
    getUserMedia: (constraints: MediaStreamConstraints) => Promise<FakeStream>,
    windowExtra: Record<string, unknown> = {},
  ): { calls: MediaStreamConstraints[] } {
    const calls: MediaStreamConstraints[] = [];
    g.window = { isSecureContext: true, ...windowExtra };
    g.navigator = {
      language: 'en-US',
      mediaDevices: {
        getUserMedia: (constraints: MediaStreamConstraints): Promise<FakeStream> => {
          calls.push(constraints);
          return getUserMedia(constraints);
        },
      },
    };
    g.DataTransfer = FakeDataTransfer;
    return { calls };
  }

  const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

  let originalNavigator: unknown;
  beforeEach(() => { originalNavigator = g.navigator; });
  afterEach(() => {
    g.navigator = originalNavigator;
    delete g.DataTransfer;
    closeCameraModal();
  });

  it('streams the live camera into the modal instead of opening the picker', async () => {
    const { calls } = stubCamera(() => Promise.resolve(fakeStream().stream));
    const dom = stubDom();
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    await flush();
    expect(input.clicks).toBe(0);
    // Asking for a size is what gets a sharp photo instead of the 640x480
    // default stream.
    expect(calls).toEqual([{
      video: {
        facingMode: 'environment',
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
    }]);
    expect(dom.modal.classList.contains('open')).toBe(true);
    expect(dom.video.srcObject).toBeTruthy();
    expect(dom.video.tone.has('photo-video-off')).toBe(false);
  });

  it('the shutter puts a jpeg File into input.files and fires a bubbling change', async () => {
    stubCamera(() => Promise.resolve(fakeStream().stream));
    const dom = stubDom();
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    await flush();
    dom.shutter.fire('click');
    await flush();
    expect(input.files?.[0]).toBeInstanceOf(File);
    expect(input.files?.[0]?.name).toBe('camera.jpg');
    expect(input.files?.[0]?.type).toBe('image/jpeg');
    expect(input.events.map(e => e.type)).toEqual(['change']);
    expect(input.events[0]?.bubbles).toBe(true);
    // The frame is drawn at the video's own resolution.
    expect(dom.canvases[0]?.width).toBe(640);
    expect(dom.canvases[0]?.height).toBe(480);
    expect(dom.modal.classList.contains('open')).toBe(false);
  });

  it('the shutter stops the tracks it captured from', async () => {
    const { stream, tracks } = fakeStream();
    stubCamera(() => Promise.resolve(stream));
    const dom = stubDom();
    openPhotoInput(asInput(fakeInput()), { camera: true });
    await flush();
    dom.shutter.fire('click');
    await flush();
    expect(tracks.every(t => t.stopped)).toBe(true);
  });

  it('cancel closes the modal and stops the tracks', async () => {
    const { stream, tracks } = fakeStream();
    stubCamera(() => Promise.resolve(stream));
    const dom = stubDom();
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    await flush();
    dom.cancel.fire('click');
    expect(tracks.every(t => t.stopped)).toBe(true);
    expect(dom.modal.classList.contains('open')).toBe(false);
    expect(dom.video.srcObject).toBe(null);
    expect(input.clicks).toBe(0);
  });

  it('Escape closes the modal like the cancel button', async () => {
    const { stream, tracks } = fakeStream();
    stubCamera(() => Promise.resolve(stream));
    const dom = stubDom();
    openPhotoInput(asInput(fakeInput()), { camera: true });
    await flush();
    dom.escape();
    expect(tracks.every(t => t.stopped)).toBe(true);
    expect(dom.modal.classList.contains('open')).toBe(false);
    expect(dom.keydownCount()).toBe(0);
  });

  it('a rejected getUserMedia falls back to the capture input', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    stubCamera(() => Promise.reject(denied));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubDom();
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    await flush();
    expect(input.attrs.get('capture')).toBe('environment');
    expect(input.clicks).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('falls back to capture without a secure context or mediaDevices', () => {
    stubDom();
    // getUserMedia only exists in a secure context (see #1536).
    g.window = { isSecureContext: false };
    g.navigator = { language: 'en-US', mediaDevices: { getUserMedia: () => {} } };
    const insecure = fakeInput();
    openPhotoInput(asInput(insecure), { camera: true });
    expect(insecure.attrs.get('capture')).toBe('environment');
    expect(insecure.clicks).toBe(1);

    g.window = { isSecureContext: true };
    g.navigator = { language: 'en-US' };
    const noMedia = fakeInput();
    openPhotoInput(asInput(noMedia), { camera: true });
    expect(noMedia.attrs.get('capture')).toBe('environment');
    expect(noMedia.clicks).toBe(1);
  });

  it('falls back to capture when the video has no frame yet', async () => {
    stubCamera(() => Promise.resolve(fakeStream().stream));
    const dom = stubDom();
    dom.video.videoWidth = 0;
    dom.video.videoHeight = 0;
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    await flush();
    dom.shutter.fire('click');
    await flush();
    expect(input.attrs.get('capture')).toBe('environment');
    expect(input.clicks).toBe(1);
  });

  it('falls back to capture when the frame cannot be encoded', async () => {
    stubCamera(() => Promise.resolve(fakeStream().stream));
    const dom = stubDom(true, false);
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    await flush();
    dom.shutter.fire('click');
    await flush();
    expect(input.files).toBe(null);
    expect(input.attrs.get('capture')).toBe('environment');
    expect(input.clicks).toBe(1);
  });

  it('releases a stream that arrives after the modal was closed', async () => {
    const { stream, tracks } = fakeStream();
    let grantAccess: ((s: FakeStream) => void) | undefined;
    stubCamera(() => new Promise<FakeStream>(resolve => { grantAccess = resolve; }));
    const dom = stubDom();
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    dom.cancel.fire('click');
    grantAccess?.(stream);
    await flush();
    expect(tracks.every(t => t.stopped)).toBe(true);
    expect(dom.video.srcObject).toBe(null);
    // Backing out never re-opens the phone's camera app behind the user.
    expect(input.clicks).toBe(0);
  });

  it('applies continuous autofocus when the camera supports it', async () => {
    const { stream, applied } = fakeStream({ focusMode: ['continuous', 'single-shot'] });
    stubCamera(() => Promise.resolve(stream));
    stubDom();
    openPhotoInput(asInput(fakeInput()), { camera: true });
    await flush();
    expect(applied).toEqual([{ advanced: [{ focusMode: 'continuous' }] }]);
  });

  it('skips continuous autofocus when the camera does not offer it', async () => {
    const { stream, applied } = fakeStream({ focusMode: ['none'] });
    stubCamera(() => Promise.resolve(stream));
    stubDom();
    openPhotoInput(asInput(fakeInput()), { camera: true });
    await flush();
    expect(applied).toEqual([]);
  });

  it('a tap focuses at the tapped point and draws a ring there', async () => {
    const { stream, applied } = fakeStream({
      focusMode: ['continuous', 'single-shot'],
      pointsOfInterest: {},
    });
    stubCamera(() => Promise.resolve(stream));
    const dom = stubDom();
    openPhotoInput(asInput(fakeInput()), { camera: true });
    await flush();
    dom.video.fire('pointerdown', { clientX: 160, clientY: 120 });
    await flush();
    // A 640x480 frame painted 1:1 into a 640x480 box: a quarter in from the
    // left and top edges.
    expect(applied[1]).toEqual({
      advanced: [{ pointsOfInterest: [{ x: 0.25, y: 0.25 }], focusMode: 'single-shot' }],
    });
    expect(dom.rings[0]?.className).toBe('photo-focus-ring');
    expect(dom.rings[0]?.style.left).toBe('160px');
    expect(dom.rings[0]?.style.top).toBe('120px');
  });

  it('a tap does nothing when the camera reports no focus modes', async () => {
    const { stream, applied } = fakeStream();
    stubCamera(() => Promise.resolve(stream));
    const dom = stubDom();
    openPhotoInput(asInput(fakeInput()), { camera: true });
    await flush();
    dom.video.fire('pointerdown', { clientX: 320, clientY: 240 });
    await flush();
    expect(applied).toEqual([]);
    expect(dom.rings).toEqual([]);
  });

  it('the shutter takes the photo through ImageCapture when it exists', async () => {
    class FakeImageCapture {
      readonly track: { id?: string };
      constructor(track: { id?: string }) { this.track = track; }
      takePhoto(): Promise<Blob> {
        return Promise.resolve(new Blob(['sensor', this.track.id ?? ''], { type: 'image/jpeg' }));
      }
    }
    const { stream } = fakeStream();
    stubCamera(() => Promise.resolve(stream), { ImageCapture: FakeImageCapture });
    const dom = stubDom();
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    await flush();
    dom.shutter.fire('click');
    await flush();
    // The sensor path is used instead of a canvas frame.
    expect(dom.canvases).toEqual([]);
    expect(input.files?.[0]?.name).toBe('camera.jpg');
    expect(input.files?.[0]?.type).toBe('image/jpeg');
    expect(input.events.map(e => e.type)).toEqual(['change']);
  });

  it('falls back to the canvas frame when ImageCapture rejects', async () => {
    class BrokenImageCapture {
      takePhoto(): Promise<Blob> { return Promise.reject(new Error('nope')); }
    }
    const { stream } = fakeStream();
    stubCamera(() => Promise.resolve(stream), { ImageCapture: BrokenImageCapture });
    const dom = stubDom();
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    await flush();
    dom.shutter.fire('click');
    await flush();
    expect(dom.canvases[0]?.width).toBe(640);
    expect(input.files?.[0]?.name).toBe('camera.jpg');
    expect(input.events.map(e => e.type)).toEqual(['change']);
  });

  it('crops the ImageCapture photo to the box the preview shows', async () => {
    class FakeImageCapture {
      takePhoto(): Promise<Blob> { return Promise.resolve(new Blob(['sensor'], { type: 'image/jpeg' })); }
    }
    const { stream } = fakeStream();
    let closed = false;
    stubCamera(() => Promise.resolve(stream), {
      ImageCapture: FakeImageCapture,
      // The sensor's own 4:3 frame, while the preview box is a 3:4 portrait:
      // the photo is wider than the box, so cover cuts its sides off.
      createImageBitmap: (): Promise<{ width: number; height: number; close: () => void }> =>
        Promise.resolve({ width: 4032, height: 3024, close: () => { closed = true; } }),
    });
    const dom = stubDom();
    const input = fakeInput();
    // The phone shows the portrait preview box; the photo must match that box,
    // not the frame the sensor happened to return.
    dom.video.getBoundingClientRect = (): { left: number; top: number; width: number; height: number } => ({
      left: 0, top: 0, width: 360, height: 480,
    });
    dom.video.videoWidth = 1920;
    dom.video.videoHeight = 1080;
    openPhotoInput(asInput(input), { camera: true });
    await flush();
    dom.shutter.fire('click');
    await flush();
    // 4:3 cropped to 3:4 => 2268x3024 from x = 882.
    expect(dom.canvases[0]?.width).toBe(2268);
    expect(dom.canvases[0]?.height).toBe(3024);
    expect(dom.draws[0]?.slice(1)).toEqual([882, 0, 2268, 3024, 0, 0, 2268, 3024]);
    expect(closed).toBe(true);
    expect(input.files?.[0]?.name).toBe('camera.jpg');
    expect(input.files?.[0]?.type).toBe('image/jpeg');
    expect(input.events.map(e => e.type)).toEqual(['change']);
  });

  it('crops the canvas fallback to the same region', async () => {
    const { stream } = fakeStream();
    stubCamera(() => Promise.resolve(stream));
    const dom = stubDom();
    const input = fakeInput();
    // A 3:4 box (what the portrait phone viewport is) around a 16:9 stream.
    dom.video.getBoundingClientRect = (): { left: number; top: number; width: number; height: number } => ({
      left: 0, top: 0, width: 360, height: 480,
    });
    dom.video.videoWidth = 1920;
    dom.video.videoHeight = 1080;
    openPhotoInput(asInput(input), { camera: true });
    await flush();
    dom.shutter.fire('click');
    await flush();
    // cover on 1920x1080 in a 360x480 box => 810x1080 from x = 555.
    expect(dom.canvases[0]?.width).toBe(810);
    expect(dom.canvases[0]?.height).toBe(1080);
    expect(dom.draws[0]?.slice(1)).toEqual([555, 0, 810, 1080, 0, 0, 810, 1080]);
    expect(input.files?.[0]?.type).toBe('image/jpeg');
  });

  it('keeps the untouched photo when it cannot be decoded', async () => {
    class FakeImageCapture {
      takePhoto(): Promise<Blob> { return Promise.resolve(new Blob(['sensor'], { type: 'image/jpeg' })); }
    }
    const { stream } = fakeStream();
    stubCamera(() => Promise.resolve(stream), {
      ImageCapture: FakeImageCapture,
      createImageBitmap: (): Promise<never> => Promise.reject(new Error('no decoder')),
    });
    const dom = stubDom();
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    await flush();
    dom.shutter.fire('click');
    await flush();
    expect(dom.canvases).toEqual([]);
    expect(input.files?.[0]?.name).toBe('camera.jpg');
  });

  it('the gallery path still just clears capture and clicks the input', () => {
    const input = fakeInput();
    input.attrs.set('capture', 'environment');
    openPhotoInput(asInput(input), { camera: false });
    expect(input.attrs.has('capture')).toBe(false);
    expect(input.clicks).toBe(1);
  });
});

describe('canTakePhoto()', () => {
  it('is true on touch devices', () => {
    stubMedia(true);
    expect(canTakePhoto()).toBe(true);
  });

  it('is false on a desktop pointer', () => {
    stubMedia(false);
    expect(canTakePhoto()).toBe(false);
  });

  it('is false without matchMedia or window', () => {
    expect(canTakePhoto()).toBe(false);
    g.window = {};
    expect(canTakePhoto()).toBe(false);
  });
});

describe('showCameraButtons()', () => {
  function stubDocument(): Map<string, { style: { display: string } }> {
    const els = new Map<string, { style: { display: string } }>();
    for (const id of ['aCameraBtn', 'bCameraBtn']) els.set(id, { style: { display: 'none' } });
    g.document = { getElementById: (id: string) => els.get(id) ?? null };
    return els;
  }

  it('reveals the camera buttons on touch devices', () => {
    stubMedia(true);
    const els = stubDocument();
    showCameraButtons(['aCameraBtn', 'bCameraBtn', 'missingBtn']);
    expect(els.get('aCameraBtn')?.style.display).toBe('');
    expect(els.get('bCameraBtn')?.style.display).toBe('');
  });

  it('leaves them hidden on desktop', () => {
    stubMedia(false);
    const els = stubDocument();
    showCameraButtons(['aCameraBtn']);
    expect(els.get('aCameraBtn')?.style.display).toBe('none');
  });
});
