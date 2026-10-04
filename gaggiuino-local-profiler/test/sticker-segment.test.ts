import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * State shared with the onnxruntime-web mock. vi.hoisted runs before the
 * hoisted vi.mock factory (and before segment.ts is imported), so the factory
 * can close over it safely.
 */
const shared = vi.hoisted(() => {
  const env = {
    wasm: {
      wasmPaths: undefined as unknown,
      numThreads: undefined as unknown,
      proxy: undefined as unknown,
    },
  };
  return { env, created: [] as string[], disposed: 0 };
});

vi.mock('onnxruntime-web/wasm', () => {
  class FakeTensor {
    data: unknown;
    dims: readonly number[];
    type: string;

    constructor(type: string, data: unknown, dims: readonly number[] = []) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }

    dispose(): void {
      shared.disposed += 1;
    }
  }

  const makeSession = (): { run: (feeds: Record<string, unknown>) => Promise<Record<string, FakeTensor>> } => ({
    run: (feeds: Record<string, unknown>): Promise<Record<string, FakeTensor>> => {
      if ('input_image' in feeds) {
        return Promise.resolve({
          output_image: new FakeTensor('float32', new Float32Array(1024 * 1024).fill(0.75)),
        });
      }
      if ('pixel_values' in feeds) {
        return Promise.resolve({
          image_embeddings: new FakeTensor('float32', new Float32Array(1)),
          image_positional_embeddings: new FakeTensor('float32', new Float32Array(1)),
        });
      }
      const plane = 256 * 256;
      const pred = new Float32Array(3 * plane);
      pred.fill(1, plane, 2 * plane);
      return Promise.resolve({
        iou_scores: new FakeTensor('float32', Float32Array.from([0.1, 0.9, 0.2])),
        pred_masks: new FakeTensor('float32', pred),
      });
    },
  });

  return {
    env: shared.env,
    Tensor: FakeTensor,
    InferenceSession: {
      create: (uri: string): Promise<ReturnType<typeof makeSession>> => {
        shared.created.push(uri);
        return Promise.resolve(makeSession());
      },
    },
  };
});

import {
  autoCutout,
  tapMask,
  resetCutout,
  isStickerCutoutAvailable,
  resizeHook,
} from '../public-src/components/sticker/segment.js';

async function freshSegment(): Promise<typeof import('../public-src/components/sticker/segment.js')> {
  vi.resetModules();
  return await import('../public-src/components/sticker/segment.js');
}

beforeEach(() => {
  shared.created.length = 0;
  shared.disposed = 0;
  shared.env.wasm.wasmPaths = undefined;
  shared.env.wasm.numThreads = undefined;
  shared.env.wasm.proxy = undefined;
  resizeHook.rgba = (_rgba, _w, _h, dw, dh) => new Uint8ClampedArray(dw * dh * 4);
  vi.stubGlobal('document', { baseURI: 'https://example.test/glp/' });
  resetCutout();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isStickerCutoutAvailable', () => {
  it('is true when the HEAD probe succeeds, and probes once', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const segment = await freshSegment();

    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(true);
    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('models/isnet-general-use-int8.onnx', { method: 'HEAD' });
  });

  it('is false when the probe is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false })));
    const segment = await freshSegment();
    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(false);
  });

  it('is false when the probe throws', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network'))));
    const segment = await freshSegment();
    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(false);
  });
});

describe('autoCutout', () => {
  const w = 8;
  const h = 6;

  it('returns a mask of length w*h and configures the wasm runtime', async () => {
    const mask = await autoCutout(new Uint8ClampedArray(w * h * 4), w, h);

    expect(mask.length).toBe(w * h);
    expect(String(shared.env.wasm.wasmPaths).endsWith('models/')).toBe(true);
    expect(shared.env.wasm.numThreads).toBe(1);
    expect(shared.env.wasm.proxy).toBe(false);
  });

  it('disposes the model output tensors', async () => {
    await autoCutout(new Uint8ClampedArray(w * h * 4), w, h);
    // IS-Net output plus the two decoder outputs; the encoder embeddings are
    // cached for tapMask and deliberately kept alive.
    expect(shared.disposed).toBe(3);
  });
});

describe('tapMask', () => {
  const w = 8;
  const h = 6;

  it('throws before autoCutout has run for this image', async () => {
    await expect(tapMask(1, 1, 1, w, h)).rejects.toThrow(/autoCutout/);
  });

  it('reuses the cached embeddings and returns a mask', async () => {
    await autoCutout(new Uint8ClampedArray(w * h * 4), w, h);
    const sessionsBefore = shared.created.length;

    const mask = await tapMask(2, 3, 1, w, h);

    expect(mask.length).toBe(w * h);
    expect(shared.created.length).toBe(sessionsBefore);
  });
});
