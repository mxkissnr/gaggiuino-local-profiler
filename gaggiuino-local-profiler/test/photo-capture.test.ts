// #1836: openPhotoInput()/canTakePhoto() drive the "Take photo" buttons that
// reuse each field's existing hidden file input. vitest runs in the node
// environment with no browser globals, so the sliver each function touches is
// faked here (same approach as test/theme.test.ts).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openPhotoInput, canTakePhoto, showCameraButtons } from '../public-src/photo-capture.js';

const g = globalThis as unknown as Record<string, unknown>;

interface FakeInput {
  attrs: Map<string, string>;
  clicks: number;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  click: () => void;
}

function fakeInput(): FakeInput {
  const input: FakeInput = {
    attrs: new Map<string, string>(),
    clicks: 0,
    setAttribute: (name, value) => { input.attrs.set(name, value); },
    removeAttribute: (name) => { input.attrs.delete(name); },
    click: () => { input.clicks += 1; },
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

describe('openPhotoInput()', () => {
  it('sets capture="environment" and opens the picker for a camera tap', () => {
    const input = fakeInput();
    openPhotoInput(asInput(input), { camera: true });
    expect(input.attrs.get('capture')).toBe('environment');
    expect(input.clicks).toBe(1);
  });

  it('removes capture before opening the gallery picker', () => {
    const input = fakeInput();
    input.attrs.set('capture', 'environment');
    openPhotoInput(asInput(input), { camera: true });
    openPhotoInput(asInput(input), { camera: false });
    expect(input.attrs.has('capture')).toBe(false);
    expect(input.clicks).toBe(2);
  });

  it('works on an input without a previous capture attribute', () => {
    const input = fakeInput();
    expect(() => openPhotoInput(asInput(input), { camera: false })).not.toThrow();
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
