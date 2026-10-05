/**
 * Sticker cut-out model runtime, worker-safe.
 *
 * This is the onnxruntime-web half of the cut-out: it loads the bundled ONNX
 * models, runs them and returns plain mask buffers. It is imported by
 * segment.worker.ts and runs inside a Web Worker, so it must never touch
 * `document` — callers pass the models base URL in. The pure tensor/mask maths
 * lives in tensors.ts and mask.ts; this module is only model loading and canvas
 * glue around it.
 */

import type { InferenceSession, Tensor } from 'onnxruntime-web/wasm';
import {
  isnetInput,
  isnetOutputToAlpha,
  samResizeDims,
  samInput,
  samPoints,
  samLabels,
  autoPromptPoints,
  bestMaskIndex,
  samMaskToFull,
  type Point,
} from './tensors.js';
import { combineMasks } from './mask.js';
import {
  alphaMask,
  cropRgba,
  meanBorderColour,
  pasteMask,
  plainBackgroundBox,
  type CropBox,
} from './background.js';

const ISNET_MODEL = 'isnet-general-use-int8.onnx';
const SAM_ENCODER_MODEL = 'slimsam-vision-encoder-q8.onnx';
const SAM_DECODER_MODEL = 'slimsam-decoder-q8.onnx';
const ISNET_SIZE = 1024;
const SAM_SIZE = 1024;

// Injected by go/cmd/frontend-build (the image path) as the hashed same-origin
// wasm runtime files; undefined under the Vite dev server, where
// onnxruntime-web resolves them next to its own bundle instead.
declare const __GLP_ORT_WASM__: string | undefined;
declare const __GLP_ORT_MJS__: string | undefined;

// Injected by go/cmd/frontend-build as {"version":..., "sizes":{file: bytes}};
// undefined under the Vite dev server. Lets a download be sized before the
// response arrives, which matters under HA Ingress (it strips Content-Length).
declare const __GLP_CUTOUT_MODELS__: { version: string; sizes: Record<string, number> } | undefined;

type Ort = typeof import('onnxruntime-web/wasm');

export type CutoutStage = 'download' | 'background' | 'subject';

/** Progress reported by autoCutout() while the cut-out runs. */
export interface CutoutProgress {
  stage: CutoutStage;
  /** 0..1 while a model file downloads; null while a model computes. */
  fraction: number | null;
}

let runtime: Promise<Ort> | null = null;

/** Dynamic-import onnxruntime-web and point it at the served wasm files once. */
function loadRuntime(): Promise<Ort> {
  if (!runtime) {
    runtime = import('onnxruntime-web/wasm').then((ort) => {
      // The image build injects the hashed same-origin runtime files; the Vite
      // dev server leaves the globals undefined and onnxruntime resolves its
      // defaults instead.
      if (typeof __GLP_ORT_WASM__ === 'string' && typeof __GLP_ORT_MJS__ === 'string') {
        ort.env.wasm.wasmPaths = {
          wasm: new URL(__GLP_ORT_WASM__, import.meta.url).href,
          mjs: new URL(__GLP_ORT_MJS__, import.meta.url).href,
        };
      }
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      return ort;
    });
  }
  return runtime;
}

const sessions = new Map<string, Promise<InferenceSession>>();

/** Error message prefix every model download failure carries. */
export const MODEL_DOWNLOAD_FAILED = 'segment: model download failed';

/** Byte size the build pinned for one model file, or undefined outside the image build. */
function expectedModelBytes(file: string): number | undefined {
  if (typeof __GLP_CUTOUT_MODELS__ === 'undefined') return undefined;
  return __GLP_CUTOUT_MODELS__.sizes[file];
}

/**
 * Fetch one model file, reporting byte progress as the body streams. Returns
 * the whole file as bytes.
 *
 * The progress total is the response's Content-Length when it is present and
 * valid, otherwise expectedTotal. Home Assistant's ingress proxy strips
 * Content-Length for bodies above ~4 MB and a broken upstream stream can end
 * cleanly, so the pinned size is the only total available there. When
 * expectedTotal is given the received length must match it. Every failure —
 * a non-ok status, a rejected fetch, a stream read error or a length mismatch —
 * throws `segment: model download failed (<status|network|incomplete>)`.
 */
export async function fetchModelBytes(
  url: string,
  onBytes?: (loaded: number, total: number) => void,
  expectedTotal?: number,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error(`${MODEL_DOWNLOAD_FAILED} (network)`);
  }
  if (!res.ok) throw new Error(`${MODEL_DOWNLOAD_FAILED} (${res.status})`);
  const length = res.headers.get('Content-Length');
  const headerTotal = length === null ? Number.NaN : Number(length);
  const total = Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : expectedTotal;
  const body = res.body;

  let bytes: Uint8Array;
  if (!body || !(typeof total === 'number' && total > 0)) {
    // No usable total: read the whole file in one go and report no progress.
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new Error(`${MODEL_DOWNLOAD_FAILED} (network)`);
    }
  } else {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        loaded += value.byteLength;
        onBytes?.(loaded, total);
      }
    } catch {
      throw new Error(`${MODEL_DOWNLOAD_FAILED} (network)`);
    }
    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }

  if (typeof expectedTotal === 'number' && expectedTotal > 0 && bytes.byteLength !== expectedTotal) {
    throw new Error(`${MODEL_DOWNLOAD_FAILED} (incomplete)`);
  }
  return bytes;
}

/** Call onProgress, swallowing a throwing callback so the cut-out still runs. */
function emit(
  onProgress: ((progress: CutoutProgress) => void) | undefined,
  progress: CutoutProgress,
): void {
  if (!onProgress) return;
  try {
    onProgress(progress);
  } catch {
    // A broken progress listener must never break the cut-out itself.
  }
}

/**
 * Create (or reuse) a wasm-backed session for one model file. On a cold cache
 * the file is fetched with byte progress and handed to onnxruntime as bytes
 * instead of a URL; the bytes are dropped as soon as the session is created.
 */
function sessionFor(
  ort: Ort,
  file: string,
  modelsBase: string,
  onProgress?: (progress: CutoutProgress) => void,
): Promise<InferenceSession> {
  let session = sessions.get(file);
  if (!session) {
    session = (async () => {
      const bytes = await fetchModelBytes(
        modelsBase + file,
        (loaded, total) => {
          emit(onProgress, { stage: 'download', fraction: loaded / total });
        },
        expectedModelBytes(file),
      );
      return ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        // The CPU memory arena and memory-pattern planning hold large buffers for
        // reuse; disabling both lowers the peak (the wasm heap never shrinks).
        enableCpuMemArena: false,
        enableMemPattern: false,
      });
    })();
    sessions.set(file, session);
  }
  return session;
}

/**
 * Drop a cached session and release its wasm allocation. Awaiting the result
 * guarantees the memory is freed before the caller loads another model. A
 * session freed here is re-created on demand.
 */
async function releaseSession(file: string): Promise<void> {
  const pending = sessions.get(file);
  if (!pending) return;
  sessions.delete(file);
  try {
    const session = await pending;
    await session.release();
  } catch {
    // Session creation failed: there is nothing to release.
  }
}

interface SamEmbeddings {
  image: Tensor;
  positional: Tensor;
}

let embeddings: SamEmbeddings | null = null;

// The models base the current image was loaded from; tapMask() reuses it
// instead of taking it as a parameter, so the worker's tap message stays small.
let activeModelsBase: string | null = null;

// The product box the current image was cut out in (null for a busy photo) and
// the image's alpha (null when fully opaque). Both are kept for the tap phase.
let activeBox: CropBox | null = null;
let activeAlpha: Uint8Array | null = null;

/**
 * Drop the cached SAM embeddings and release every cached session. Called when
 * the editor closes; the client keeps this worker for a short idle window and
 * then terminates it, which is what returns the whole wasm heap to the browser.
 */
export function resetCutout(): void {
  embeddings = null;
  activeModelsBase = null;
  activeBox = null;
  activeAlpha = null;
  for (const file of [...sessions.keys()]) void releaseSession(file);
}

export interface RgbaResize {
  (rgba: Uint8ClampedArray, w: number, h: number, dw: number, dh: number): Uint8ClampedArray;
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

// Both canvas kinds expose the same 2d drawing API, so the HTMLCanvasElement
// cast only satisfies TypeScript's union-method resolution.
function context2d(canvas: OffscreenCanvas | HTMLCanvasElement): CanvasRenderingContext2D {
  return (canvas as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D;
}

function canvasResizeRgba(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  const source = makeCanvas(w, h);
  const sourceCtx = context2d(source);
  const image = sourceCtx.createImageData(w, h);
  image.data.set(rgba);
  sourceCtx.putImageData(image, 0, 0);
  const target = makeCanvas(dw, dh);
  context2d(target).drawImage(source, 0, 0, dw, dh);
  return context2d(target).getImageData(0, 0, dw, dh).data;
}

/**
 * The RGBA-resize seam: production draws through OffscreenCanvas (or a
 * detached `<canvas>`); the Vitest suite, which has neither, swaps the
 * implementation for a pure stub.
 */
export const resizeHook: { rgba: RgbaResize } = { rgba: canvasResizeRgba };

function tensorData(outputs: Readonly<Record<string, Tensor>>, name: string): Float32Array {
  const tensor = outputs[name];
  if (!tensor) throw new Error(`segment: model output ${name} missing`);
  return tensor.data as Float32Array;
}

function disposeAll(outputs: Readonly<Record<string, Tensor>>): void {
  for (const tensor of Object.values(outputs)) tensor.dispose?.();
}

/** Run the SAM decoder for one set of prompts against the cached embeddings. */
async function decode(
  ort: Ort,
  emb: SamEmbeddings,
  points: Point[],
  labels: number[],
  w: number,
  h: number,
  modelsBase: string,
): Promise<Uint8Array> {
  const decoder = await sessionFor(ort, SAM_DECODER_MODEL, modelsBase);
  const outputs = await decoder.run({
    image_embeddings: emb.image,
    image_positional_embeddings: emb.positional,
    input_points: new ort.Tensor('float32', samPoints(points, w, h), [1, 1, points.length, 2]),
    input_labels: new ort.Tensor('int64', samLabels(labels), [1, 1, labels.length]),
  });
  const iou = tensorData(outputs, 'iou_scores');
  const pred = tensorData(outputs, 'pred_masks');
  const mask = samMaskToFull(pred, bestMaskIndex(iou), w, h);
  disposeAll(outputs);
  return mask;
}

/** Element-wise AND of two full-size masks. */
function andMask(mask: Uint8Array, alpha: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i]! !== 0 && alpha[i]! !== 0 ? 1 : 0;
  return out;
}

/**
 * Cut a bean photo out automatically: IS-Net gives a coarse alpha, SlimSAM's
 * automatic centre prompts refine it, and combineMasks() merges the two. The
 * SAM embeddings are cached for later tapMask() edits.
 *
 * When the border is a plain studio background (or the image has transparency),
 * a tight box around the product is found first and the models run on that crop
 * only, so they never see the background; the mask is pasted back to full size.
 * A transparent pixel is never part of the sticker.
 *
 * Peak wasm memory stays at the size of the largest single model rather than
 * the sum of all three: IS-Net's session is released before the SAM encoder is
 * created, and the encoder is released right after it runs. Only the small
 * decoder and the cached embeddings survive into the tap phase.
 *
 * onProgress, when given, hears the model download fraction and the start of
 * each model run; a cold cache downloads each model right before its session is
 * created, so no model's bytes are held while another runs.
 */
export async function autoCutout(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  modelsBase: string,
  onProgress?: (progress: CutoutProgress) => void,
): Promise<Uint8Array> {
  activeModelsBase = modelsBase;
  const box = plainBackgroundBox(rgba, w, h);
  const alpha = alphaMask(rgba, w, h);
  activeBox = box;
  activeAlpha = alpha;

  let source = rgba;
  let sw = w;
  let sh = h;
  if (box) {
    // A transparent PNG has no usable border colour, so its transparent pixels
    // are filled white; otherwise use the mean of the border profiles.
    const fill: [number, number, number] = alpha ? [255, 255, 255] : meanBorderColour(rgba, w, h);
    source = cropRgba(rgba, w, h, box, fill);
    sw = box.width;
    sh = box.height;
  }

  const ort = await loadRuntime();

  const isnetSession = await sessionFor(ort, ISNET_MODEL, modelsBase, onProgress);
  emit(onProgress, { stage: 'background', fraction: null });
  const isnetRgba = resizeHook.rgba(source, sw, sh, ISNET_SIZE, ISNET_SIZE);
  const isnetOut = await isnetSession.run({
    input_image: new ort.Tensor('float32', isnetInput(isnetRgba), [1, 3, ISNET_SIZE, ISNET_SIZE]),
  });
  const isnetAlpha = isnetOutputToAlpha(tensorData(isnetOut, 'output_image'), sw, sh);
  disposeAll(isnetOut);

  // IS-Net's output is a plain alpha array now, so free the session before the
  // SAM encoder loads — awaiting keeps the two from ever sharing the heap.
  await releaseSession(ISNET_MODEL);

  const { rw, rh } = samResizeDims(sw, sh);
  const encoder = await sessionFor(ort, SAM_ENCODER_MODEL, modelsBase, onProgress);
  emit(onProgress, { stage: 'subject', fraction: null });
  const samRgba = resizeHook.rgba(source, sw, sh, rw, rh);
  const encOut = await encoder.run({
    pixel_values: new ort.Tensor('float32', samInput(samRgba, rw, rh), [1, 3, SAM_SIZE, SAM_SIZE]),
  });
  // Replace the previous image's embeddings (releasing their wasm memory)
  // with this one, kept for tapMask() and so deliberately not disposed below.
  embeddings?.image.dispose?.();
  embeddings?.positional.dispose?.();
  const samEmbeddings: SamEmbeddings = {
    image: encOut['image_embeddings']!,
    positional: encOut['image_positional_embeddings']!,
  };
  embeddings = samEmbeddings;

  // The encoder's activations are the biggest single allocation and taps only
  // need the decoder, so release the encoder before running the decoder.
  await releaseSession(SAM_ENCODER_MODEL);

  const points = autoPromptPoints(sw, sh);
  const sam = await decode(ort, samEmbeddings, points, points.map(() => 1), sw, sh, modelsBase);
  const combined = combineMasks(isnetAlpha, sam, source, sw, sh);
  const full = box ? pasteMask(combined, box, w, h) : combined;
  return alpha ? andMask(full, alpha) : full;
}

/**
 * Refine the mask with a single user tap after autoCutout() has run for this
 * image. Reuses the cached embeddings, so it only runs the decoder. When the
 * cut-out used a product box, the tap is translated into box space and the
 * decoded mask pasted back; a tap outside the box is a no-op that skips the
 * decoder entirely.
 */
export async function tapMask(
  x: number,
  y: number,
  label: 0 | 1,
  w: number,
  h: number,
): Promise<Uint8Array> {
  const cached = embeddings;
  const modelsBase = activeModelsBase;
  if (!cached || modelsBase === null) {
    throw new Error('segment: autoCutout() must run before tapMask()');
  }
  const box = activeBox;
  const alpha = activeAlpha;
  if (box && (x < box.x || y < box.y || x >= box.x + box.width || y >= box.y + box.height)) {
    return new Uint8Array(w * h);
  }
  const ort = await loadRuntime();
  let mask: Uint8Array;
  if (box) {
    const sub = await decode(
      ort,
      cached,
      [{ x: x - box.x, y: y - box.y }],
      [label],
      box.width,
      box.height,
      modelsBase,
    );
    mask = pasteMask(sub, box, w, h);
  } else {
    mask = await decode(ort, cached, [{ x, y }], [label], w, h, modelsBase);
  }
  return alpha ? andMask(mask, alpha) : mask;
}
