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
  interface FakeTrack { stopped: boolean; stop: () => void }
  interface FakeStream { getTracks: () => FakeTrack[] }

  function fakeStream(): { stream: FakeStream; tracks: FakeTrack[] } {
    const tracks: FakeTrack[] = [
      { stopped: false, stop(): void { this.stopped = true; } },
      { stopped: false, stop(): void { this.stopped = true; } },
    ];
    return { stream: { getTracks: () => tracks }, tracks };
  }

  interface FakeEl {
    id: string;
    tone: Set<string>;
    classList: { add: (t: string) => void; remove: (t: string) => void; contains: (t: string) => boolean };
    srcObject: unknown;
    videoWidth: number;
    videoHeight: number;
    attrs: Map<string, string>;
    listeners: Map<string, () => void>;
    setAttribute: (name: string, value: string) => void;
    hasAttribute: (name: string) => boolean;
    focus: () => void;
    querySelectorAll: () => unknown[];
    addEventListener: (type: string, fn: () => void, opts?: { signal?: AbortSignal }) => void;
    removeEventListener: (type: string) => void;
    fire: (type: string) => void;
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
      listeners: new Map<string, () => void>(),
      setAttribute: (name, value): void => { el.attrs.set(name, value); },
      hasAttribute: (name): boolean => el.attrs.has(name),
      focus: (): void => {},
      querySelectorAll: (): unknown[] => [],
      addEventListener: (type, fn, opts): void => {
        el.listeners.set(type, fn);
        opts?.signal?.addEventListener('abort', () => el.listeners.delete(type));
      },
      removeEventListener: (type): void => { el.listeners.delete(type); },
      fire: (type): void => { el.listeners.get(type)?.(); },
    };
    return el;
  }

  interface FakeCanvas {
    width: number;
    height: number;
    getContext: () => { drawImage: () => void } | null;
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
    const els: Record<string, FakeEl> = {
      photoCameraModal: modal, photoCameraVideo: video,
      photoCameraShutter: shutter, photoCameraCancelBtn: cancel,
    };
    g.document = {
      getElementById: (id: string): FakeEl | null => els[id] ?? null,
      createElement: (): FakeCanvas => {
        const canvas: FakeCanvas = {
          width: 0,
          height: 0,
          getContext: () => (drawable ? { drawImage: () => {} } : null),
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
      modal, video, shutter, cancel, canvases,
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

  function stubCamera(getUserMedia: (constraints: MediaStreamConstraints) => Promise<FakeStream>): {
    calls: MediaStreamConstraints[];
  } {
    const calls: MediaStreamConstraints[] = [];
    g.window = { isSecureContext: true };
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
    expect(calls).toEqual([{ video: { facingMode: 'environment' } }]);
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
    let resolveStream: (s: FakeStream) => void = () => {};
    stubCamera(() => new Promise<FakeStream>(resolve => { resolveStream = resolve; }));
    const dom = stubDom();
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    dom.cancel.fire('click');
    resolveStream(stream);
    await flush();
    expect(tracks.every(t => t.stopped)).toBe(true);
    expect(dom.video.srcObject).toBe(null);
    // Backing out never re-opens the phone's camera app behind the user.
    expect(input.clicks).toBe(0);
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
