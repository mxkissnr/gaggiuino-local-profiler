import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * State shared with the onnxruntime-web mock. vi.hoisted runs before the
 * hoisted vi.mock factory (and before segment-core.ts is imported), so the
 * factory can close over it safely.
 */
const shared = vi.hoisted(() => {
  const env = {
    wasm: {
      wasmPaths: undefined as unknown,
      numThreads: undefined as unknown,
      proxy: undefined as unknown,
    },
  };
  return {
    env,
    // Session URIs in creation order, plus a single event log so a test can
    // assert that sessions were released before later ones were created.
    created: [] as string[],
    createdOptions: [] as unknown[],
    released: [] as string[],
    log: [] as string[],
    disposed: 0,
  };
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

  const makeSession = (
    uri: string,
  ): {
    run: (feeds: Record<string, unknown>) => Promise<Record<string, FakeTensor>>;
    release: () => Promise<void>;
  } => ({
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
    release: (): Promise<void> => {
      shared.released.push(uri);
      shared.log.push(`release:${uri}`);
      return Promise.resolve();
    },
  });

  return {
    env: shared.env,
    Tensor: FakeTensor,
    InferenceSession: {
      create: (uri: string, options?: unknown): Promise<ReturnType<typeof makeSession>> => {
        shared.created.push(uri);
        shared.createdOptions.push(options);
        shared.log.push(`create:${uri}`);
        return Promise.resolve(makeSession(uri));
      },
    },
  };
});

const MODELS_BASE = 'https://example.test/glp/models/';
const ISNET = `${MODELS_BASE}isnet-general-use-int8.onnx`;
const ENCODER = `${MODELS_BASE}slimsam-vision-encoder-q8.onnx`;
const DECODER = `${MODELS_BASE}slimsam-decoder-q8.onnx`;

type Core = typeof import('../public-src/components/sticker/segment-core.js');

/**
 * A fresh copy of segment-core.ts, with the canvas resize seam stubbed (the
 * Node test environment has neither OffscreenCanvas nor a DOM). The models base
 * is passed in explicitly, so segment-core never touches document.
 */
async function freshCore(): Promise<Core> {
  vi.resetModules();
  const core = await import('../public-src/components/sticker/segment-core.js');
  core.resizeHook.rgba = (_rgba, _w, _h, dw, dh) => new Uint8ClampedArray(dw * dh * 4);
  return core;
}

/** Let releaseSession()'s fire-and-forget microtask run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  shared.created.length = 0;
  shared.createdOptions.length = 0;
  shared.released.length = 0;
  shared.log.length = 0;
  shared.disposed = 0;
  shared.env.wasm.wasmPaths = undefined;
  shared.env.wasm.numThreads = undefined;
  shared.env.wasm.proxy = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('autoCutout', () => {
  const w = 8;
  const h = 6;

  it('returns a mask of length w*h and configures the wasm runtime', async () => {
    const core = await freshCore();
    const mask = await core.autoCutout(new Uint8ClampedArray(w * h * 4), w, h, MODELS_BASE);

    expect(mask.length).toBe(w * h);
    expect(String(shared.env.wasm.wasmPaths).endsWith('models/')).toBe(true);
    expect(shared.env.wasm.numThreads).toBe(1);
    expect(shared.env.wasm.proxy).toBe(false);
  });

  it('disposes the model output tensors', async () => {
    const core = await freshCore();
    await core.autoCutout(new Uint8ClampedArray(w * h * 4), w, h, MODELS_BASE);
    // IS-Net output plus the two decoder outputs; the encoder embeddings are
    // cached for tapMask and deliberately kept alive.
    expect(shared.disposed).toBe(3);
  });

  it('releases IS-Net before the encoder is created, releases the encoder, and keeps the decoder', async () => {
    const core = await freshCore();
    await core.autoCutout(new Uint8ClampedArray(w * h * 4), w, h, MODELS_BASE);
    await flush();

    expect(shared.log).toEqual([
      `create:${ISNET}`,
      `release:${ISNET}`,
      `create:${ENCODER}`,
      `release:${ENCODER}`,
      `create:${DECODER}`,
    ]);
    expect(shared.released).not.toContain(DECODER);
  });

  it('creates every session with the memory-saving wasm options', async () => {
    const core = await freshCore();
    await core.autoCutout(new Uint8ClampedArray(w * h * 4), w, h, MODELS_BASE);
    await flush();

    expect(shared.createdOptions.length).toBeGreaterThan(0);
    for (const options of shared.createdOptions) {
      expect(options).toMatchObject({
        executionProviders: ['wasm'],
        enableCpuMemArena: false,
        enableMemPattern: false,
      });
    }
  });
});

describe('tapMask', () => {
  const w = 8;
  const h = 6;

  it('throws before autoCutout has run for this image', async () => {
    const core = await freshCore();
    await expect(core.tapMask(1, 1, 1, w, h)).rejects.toThrow(/autoCutout/);
  });

  it('reuses the cached embeddings and returns a mask', async () => {
    const core = await freshCore();
    await core.autoCutout(new Uint8ClampedArray(w * h * 4), w, h, MODELS_BASE);
    const sessionsBefore = shared.created.length;

    const mask = await core.tapMask(2, 3, 1, w, h);

    expect(mask.length).toBe(w * h);
    expect(shared.created.length).toBe(sessionsBefore);
  });
});

describe('resetCutout', () => {
  it('releases the cached decoder session', async () => {
    const core = await freshCore();
    await core.autoCutout(new Uint8ClampedArray(8 * 6 * 4), 8, 6, MODELS_BASE);
    expect(shared.released).not.toContain(DECODER);

    core.resetCutout();
    await flush();

    expect(shared.released).toContain(DECODER);
  });
});
