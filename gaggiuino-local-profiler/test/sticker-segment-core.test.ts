import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { plainBackgroundBox } from '../public-src/components/sticker/background.js';

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
    // Number of SAM-decoder runs (the branch with neither IS-Net nor encoder input).
    decoderRuns: 0,
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
      shared.decoderRuns += 1;
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
      create: (
        source: string | Uint8Array,
        options?: unknown,
      ): Promise<ReturnType<typeof makeSession>> => {
        // Production hands over the raw model bytes; the fetch stub below makes
        // those bytes spell the model URL, so a session stays identifiable.
        const uri = typeof source === 'string' ? source : new TextDecoder().decode(source);
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

/**
 * A streamed fetch Response whose bytes spell `url`; the ort mock decodes them
 * back to the URL. `chunks` splits the body for byte-progress tests, and
 * `contentLength: false` drops the header so the whole-file fallback is used.
 */
function streamedResponse(
  url: string,
  chunks?: Uint8Array[],
  contentLength = true,
): Response {
  const parts = chunks ?? [new TextEncoder().encode(url)];
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        contentLength && name.toLowerCase() === 'content-length' ? String(total) : null,
    },
    body: {
      getReader: () => {
        let index = 0;
        return {
          read: () =>
            Promise.resolve(
              index < parts.length ? { done: false, value: parts[index++] } : { done: true },
            ),
        };
      },
    },
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(url).buffer),
  } as unknown as Response;
}

/** A streamed response with no Content-Length header. */
function noLengthResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)),
  } as unknown as Response;
}

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
  shared.decoderRuns = 0;
  shared.env.wasm.wasmPaths = undefined;
  shared.env.wasm.numThreads = undefined;
  shared.env.wasm.proxy = undefined;
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(streamedResponse(url))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('autoCutout', () => {
  const w = 8;
  const h = 6;

  it('points onnxruntime at the build-injected hashed wasm/mjs', async () => {
    vi.stubGlobal('__GLP_ORT_WASM__', './ort-wasm-simd-threaded-abc12345.wasm');
    vi.stubGlobal('__GLP_ORT_MJS__', './ort-wasm-simd-threaded-def67890.mjs');
    const core = await freshCore();
    const mask = await core.autoCutout(new Uint8ClampedArray(w * h * 4), w, h, MODELS_BASE);

    expect(mask.length).toBe(w * h);
    const paths = shared.env.wasm.wasmPaths as { wasm: string; mjs: string };
    expect(paths.wasm.endsWith('ort-wasm-simd-threaded-abc12345.wasm')).toBe(true);
    expect(paths.mjs.endsWith('ort-wasm-simd-threaded-def67890.mjs')).toBe(true);
    expect(shared.env.wasm.numThreads).toBe(1);
    expect(shared.env.wasm.proxy).toBe(false);
  });

  it('leaves wasmPaths unset when the build did not inject the runtime files', async () => {
    const core = await freshCore();
    const mask = await core.autoCutout(new Uint8ClampedArray(w * h * 4), w, h, MODELS_BASE);

    expect(mask.length).toBe(w * h);
    expect(shared.env.wasm.wasmPaths).toBeUndefined();
    expect(shared.env.wasm.numThreads).toBe(1);
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

describe('autoCutout progress', () => {
  const w = 8;
  const h = 6;

  it('reports the download fraction, then background and subject in order', async () => {
    const core = await freshCore();
    const updates: { stage: string; fraction: number | null }[] = [];
    await core.autoCutout(new Uint8ClampedArray(w * h * 4), w, h, MODELS_BASE, (p) => {
      updates.push({ stage: p.stage, fraction: p.fraction });
    });

    // The stub streams each file in one chunk, so its download fraction is 1.
    expect(updates[0]).toEqual({ stage: 'download', fraction: 1 });
    const background = updates.findIndex((update) => update.stage === 'background');
    const subject = updates.findIndex((update) => update.stage === 'subject');
    expect(background).toBeGreaterThan(0);
    expect(subject).toBeGreaterThan(background);
    expect(updates[background]!.fraction).toBeNull();
    expect(updates[subject]!.fraction).toBeNull();
  });

  it('still cuts out when the progress callback throws', async () => {
    const core = await freshCore();
    const mask = await core.autoCutout(new Uint8ClampedArray(w * h * 4), w, h, MODELS_BASE, () => {
      throw new Error('listener boom');
    });
    expect(mask.length).toBe(w * h);
  });
});

describe('fetchModelBytes', () => {
  it('reports increasing fractions as the body streams', async () => {
    const core = await freshCore();
    const url = `${MODELS_BASE}chunked.onnx`;
    const bytes = new Uint8Array(10).fill(3);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(streamedResponse(url, [bytes.slice(0, 4), bytes.slice(4)]))),
    );

    const fractions: number[] = [];
    const out = await core.fetchModelBytes(url, (loaded, total) => fractions.push(loaded / total));

    expect(Array.from(out)).toEqual(Array.from(bytes));
    expect(fractions).toEqual([0.4, 1]);
  });

  it('reads the whole file when the total size is unknown', async () => {
    const core = await freshCore();
    const bytes = new Uint8Array([5, 6, 7]);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(noLengthResponse(bytes))));

    const out = await core.fetchModelBytes(`${MODELS_BASE}unknown.onnx`);

    expect(Array.from(out)).toEqual([5, 6, 7]);
  });

  it('throws when the response is not ok', async () => {
    const core = await freshCore();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404 } as Response)));

    await expect(core.fetchModelBytes(`${MODELS_BASE}missing.onnx`)).rejects.toThrow(/404/);
  });

  it('reports progress from a known size when Content-Length is stripped', async () => {
    const core = await freshCore();
    const url = `${MODELS_BASE}chunked.onnx`;
    const bytes = new Uint8Array(10).fill(3);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(streamedResponse(url, [bytes.slice(0, 4), bytes.slice(4)], false))),
    );

    const fractions: number[] = [];
    const out = await core.fetchModelBytes(
      url,
      (loaded, total) => fractions.push(loaded / total),
      bytes.byteLength,
    );

    expect(Array.from(out)).toEqual(Array.from(bytes));
    expect(fractions).toEqual([0.4, 1]);
  });

  it('rejects a short body against the known size', async () => {
    const core = await freshCore();
    const url = `${MODELS_BASE}short.onnx`;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(streamedResponse(url, [new Uint8Array(4)], false))),
    );

    await expect(core.fetchModelBytes(url, undefined, 10)).rejects.toThrow(
      `${core.MODEL_DOWNLOAD_FAILED} (incomplete)`,
    );
  });

  it('rejects a rejected fetch with the failure prefix', async () => {
    const core = await freshCore();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('boom'))));

    await expect(core.fetchModelBytes(`${MODELS_BASE}net.onnx`)).rejects.toThrow(
      `${core.MODEL_DOWNLOAD_FAILED} (network)`,
    );
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

/** A white 100x100 frame with a black 40x40 product in the middle. */
function plainProduct(): { rgba: Uint8ClampedArray; w: number; h: number } {
  const w = 100;
  const h = 100;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 255;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = 255;
  }
  for (let y = 30; y < 70; y++) {
    for (let x = 30; x < 70; x++) {
      const p = (y * w + x) * 4;
      rgba[p] = 0;
      rgba[p + 1] = 0;
      rgba[p + 2] = 0;
    }
  }
  return { rgba, w, h };
}

function recordResizes(core: Core, calls: number[][]): void {
  core.resizeHook.rgba = (_rgba, sw, sh, dw, dh) => {
    calls.push([sw, sh, dw, dh]);
    return new Uint8ClampedArray(dw * dh * 4);
  };
}

describe('autoCutout on a plain studio background', () => {
  it('runs the models on the product box and zeroes the mask outside it', async () => {
    const core = await freshCore();
    const resizes: number[][] = [];
    recordResizes(core, resizes);
    const { rgba, w, h } = plainProduct();

    const mask = await core.autoCutout(rgba, w, h, MODELS_BASE);

    const box = plainBackgroundBox(rgba, w, h);
    expect(box).not.toBeNull();
    expect(mask.length).toBe(w * h);
    // IS-Net's resize ran on the cropped box, not the full frame.
    expect(resizes[0]![0]).toBe(box!.width);
    expect(resizes[0]![1]).toBe(box!.height);
    expect(box!.width).toBeLessThan(w);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < box!.x || y < box!.y || x >= box!.x + box!.width || y >= box!.y + box!.height) {
          expect(mask[y * w + x]).toBe(0);
        }
      }
    }
  });

  it('returns an all-zero mask for a tap outside the box without running the decoder', async () => {
    const core = await freshCore();
    const { rgba, w, h } = plainProduct();
    await core.autoCutout(rgba, w, h, MODELS_BASE);
    const before = shared.decoderRuns;

    const mask = await core.tapMask(0, 0, 1, w, h);

    expect(shared.decoderRuns).toBe(before);
    expect(mask.length).toBe(w * h);
    expect(mask.some((v) => v !== 0)).toBe(false);
  });
});

describe('autoCutout on an opaque busy photo', () => {
  it('keeps the full-image path', async () => {
    const core = await freshCore();
    const resizes: number[][] = [];
    recordResizes(core, resizes);
    const w = 64;
    const h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    let state = 11;
    for (let i = 0; i < w * h; i++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      rgba[i * 4] = state & 255;
      rgba[i * 4 + 1] = (state >> 8) & 255;
      rgba[i * 4 + 2] = (state >> 16) & 255;
      rgba[i * 4 + 3] = 255;
    }

    const mask = await core.autoCutout(rgba, w, h, MODELS_BASE);

    expect(mask.length).toBe(w * h);
    expect(resizes[0]![0]).toBe(w);
    expect(resizes[0]![1]).toBe(h);
  });
});
