/**
 * Lazy on-device sticker cut-out runtime.
 *
 * Loads onnxruntime-web and the two bundled ONNX models only when a cut-out is
 * actually requested, so the WebAssembly runtime stays in its own lazy bundle
 * off the first-load path. Every URL is relative (the app runs behind HA
 * Ingress's dynamic path prefix) and resolves against document.baseURI.
 *
 * The pure tensor/mask maths lives in tensors.ts and mask.ts (slice 1); this
 * module is only the model-loading and canvas glue around it.
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
// mask.ts (combineMasks, resizeBilinear, ...) and tensors.ts (isnetInput,
// samMaskToFull, ...) are slice 1's pure helpers, already shipped on `dev`.
// This slice consumes them unchanged on purpose — it adds only the model
// runtimes and canvas glue — so neither file is edited here.

const ISNET_MODEL = 'isnet-general-use-int8.onnx';
const SAM_ENCODER_MODEL = 'slimsam-vision-encoder-q8.onnx';
const SAM_DECODER_MODEL = 'slimsam-decoder-q8.onnx';
const ISNET_SIZE = 1024;
const SAM_SIZE = 1024;

type Ort = typeof import('onnxruntime-web/wasm');

/** Absolute directory the models are served from, ending in "models/". */
function modelsBase(): string {
  return new URL('models/', document.baseURI).href;
}

let availability: Promise<boolean> | null = null;

/**
 * Whether this deployment ships the cut-out models, probed once with a HEAD
 * request against the smallest model. Any failure means "not available"; the
 * result is cached for the session.
 */
export function isStickerCutoutAvailable(): Promise<boolean> {
  if (!availability) {
    availability = fetch(`models/${ISNET_MODEL}`, { method: 'HEAD' })
      .then((res) => res.ok)
      .catch(() => false);
  }
  return availability;
}

let runtime: Promise<Ort> | null = null;

/** Dynamic-import onnxruntime-web and point it at the served wasm files once. */
function loadRuntime(): Promise<Ort> {
  if (!runtime) {
    runtime = import('onnxruntime-web/wasm').then((ort) => {
      ort.env.wasm.wasmPaths = modelsBase();
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      return ort;
    });
  }
  return runtime;
}

const sessions = new Map<string, Promise<InferenceSession>>();

/** Create (or reuse) a wasm-backed session for one model file. */
function sessionFor(ort: Ort, file: string): Promise<InferenceSession> {
  let session = sessions.get(file);
  if (!session) {
    session = ort.InferenceSession.create(modelsBase() + file, { executionProviders: ['wasm'] });
    sessions.set(file, session);
  }
  return session;
}

interface SamEmbeddings {
  image: Tensor;
  positional: Tensor;
}

let embeddings: SamEmbeddings | null = null;

/** Drop the cached SAM embeddings; the next autoCutout() recomputes them. */
export function resetCutout(): void {
  embeddings = null;
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
): Promise<Uint8Array> {
  const decoder = await sessionFor(ort, SAM_DECODER_MODEL);
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

/**
 * Cut a bean photo out automatically: IS-Net gives a coarse alpha, SlimSAM's
 * automatic centre prompts refine it, and combineMasks() merges the two. The
 * SAM embeddings are cached for later tapMask() edits.
 */
export async function autoCutout(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): Promise<Uint8Array> {
  const ort = await loadRuntime();

  const isnetSession = await sessionFor(ort, ISNET_MODEL);
  const isnetRgba = resizeHook.rgba(rgba, w, h, ISNET_SIZE, ISNET_SIZE);
  const isnetOut = await isnetSession.run({
    input_image: new ort.Tensor('float32', isnetInput(isnetRgba), [1, 3, ISNET_SIZE, ISNET_SIZE]),
  });
  const isnetAlpha = isnetOutputToAlpha(tensorData(isnetOut, 'output_image'), w, h);
  disposeAll(isnetOut);

  const { rw, rh } = samResizeDims(w, h);
  const encoder = await sessionFor(ort, SAM_ENCODER_MODEL);
  const samRgba = resizeHook.rgba(rgba, w, h, rw, rh);
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

  const points = autoPromptPoints(w, h);
  const sam = await decode(ort, samEmbeddings, points, points.map(() => 1), w, h);
  return combineMasks(isnetAlpha, sam, rgba, w, h);
}

/**
 * Refine the mask with a single user tap after autoCutout() has run for this
 * image. Reuses the cached embeddings, so it only runs the decoder.
 */
export async function tapMask(
  x: number,
  y: number,
  label: 0 | 1,
  w: number,
  h: number,
): Promise<Uint8Array> {
  const cached = embeddings;
  if (!cached) throw new Error('segment: autoCutout() must run before tapMask()');
  const ort = await loadRuntime();
  return decode(ort, cached, [{ x, y }], [label], w, h);
}
