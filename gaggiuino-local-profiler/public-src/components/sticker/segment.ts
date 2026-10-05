/**
 * Lazy on-device sticker cut-out — main-thread client.
 *
 * The model work itself runs in segment.worker.ts, so the page stays responsive
 * while IS-Net and the SAM encoder run. This module only owns the worker's
 * lifetime and the request/response plumbing; the exported API only gained an
 * optional progress callback, so views/library.ts needs no change. Terminating
 * the worker is what returns the WebAssembly heap to the browser; on editor
 * close it is deferred by a short idle window so a quick reopen reuses the
 * worker instead of racing a new one against the OS reclaiming the old heap.
 */

import type { CutoutProgress } from './segment-core.js';

// Re-exported so editor.ts can type its onProgress callback without importing
// the worker-only segment-core module (and its onnxruntime-web dependency).
export type { CutoutProgress };

// Injected by go/cmd/frontend-build (the image path) as the hashed worker
// file; undefined under the Vite dev server, where the .ts source is served.
declare const __GLP_SEGMENT_WORKER__: string | undefined;

// Injected by go/cmd/frontend-build as {"version":..., "sizes":{file: bytes}};
// undefined under the Vite dev server, where the cut-out is treated as
// unavailable rather than pointed at a guessed path.
declare const __GLP_CUTOUT_MODELS__: { version: string; sizes: Record<string, number> } | undefined;

const ISNET_MODEL = 'isnet-general-use-int8.onnx';

// The pinned model release, or "" when the build injected no manifest (the
// Vite dev server and any build without the models route).
const MODELS_VERSION =
  typeof __GLP_CUTOUT_MODELS__ === 'undefined' ? '' : __GLP_CUTOUT_MODELS__.version;

/**
 * How long the worker is kept after resetCutout() before being terminated. A
 * worker started right after the previous one was terminated can fail with
 * "RangeError: Out of memory" on mobile Safari, where the OS has not reclaimed
 * the old wasm heap yet; the idle window lets a reopen reuse the live worker.
 */
const WORKER_IDLE_MS = 20_000;

/**
 * How long a single request may stay unanswered before the client gives up. The
 * first cut-out downloads the model files server-side, so this is generous; a
 * worker silent for this long is presumed stuck, and the next request starts a
 * fresh one instead of hanging the cut-out forever.
 */
const REQUEST_TIMEOUT_MS = 120_000;

/** Absolute directory the models are served from, ending in "models/". */
function modelsBase(): string {
  const version = MODELS_VERSION === '' ? '' : `${MODELS_VERSION}/`;
  return new URL(`models/${version}`, document.baseURI).href;
}

let availability: Promise<boolean> | null = null;

/**
 * Whether this deployment serves the cut-out models. Probes the smallest model
 * with a HEAD request against the versioned manifest path. Only a definite
 * answer is cached: a confirmed present (true) or a definite 404 (false). A
 * network failure is not cached, so a probe that failed while the server was
 * still starting is retried on the next call (#1399).
 */
export function isStickerCutoutAvailable(): Promise<boolean> {
  if (MODELS_VERSION === '') return Promise.resolve(false);
  if (!availability) {
    availability = fetch(`models/${MODELS_VERSION}/${ISNET_MODEL}`, { method: 'HEAD' })
      .then((res) => {
        if (res.ok) return true;
        if (res.status === 404) return false;
        // Neither a confirmed present nor a confirmed absent: leave the probe
        // uncached below so a transient failure is retried.
        throw new Error(`models probe: ${res.status}`);
      })
      .catch(() => {
        availability = null;
        return false;
      });
  }
  return availability;
}

interface Pending {
  resolve: (mask: Uint8Array) => void;
  reject: (err: unknown) => void;
  onProgress?: (progress: CutoutProgress) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let nextId = 1;
// True once the current worker has finished an autoCutout(); taps are only
// valid against embeddings the worker still holds.
let hasEmbeddings = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, Pending>();

function rejectPending(err: unknown): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(err);
  }
  pending.clear();
}

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function dropWorker(): void {
  clearIdleTimer();
  if (!worker) return;
  worker.terminate();
  worker = null;
}

/** Terminate the worker once the idle window passes, unless a call reuses it. */
function scheduleIdleTermination(): void {
  clearIdleTimer();
  idleTimer = setTimeout(dropWorker, WORKER_IDLE_MS);
}

function createWorker(): Worker {
  // The image build (go/cmd/frontend-build) injects the hashed worker file;
  // the fallback is the Vite dev server, which serves the .ts source directly.
  const workerUrl =
    typeof __GLP_SEGMENT_WORKER__ === 'string' ? __GLP_SEGMENT_WORKER__ : './segment.worker.ts';
  const created = new Worker(new URL(workerUrl, import.meta.url), { type: 'module' });
  created.onmessage = (event: MessageEvent): void => {
    const msg = event.data as {
      id?: number;
      mask?: Uint8Array;
      error?: string;
      progress?: CutoutProgress;
    };
    if (typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.progress !== undefined) {
      try {
        entry.onProgress?.(msg.progress);
      } catch {
        // A broken progress listener must not break the request plumbing.
      }
      return;
    }
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error !== undefined) entry.reject(new Error(msg.error));
    else entry.resolve(msg.mask ?? new Uint8Array());
  };
  const fail = (): void => {
    rejectPending(new Error('segment: worker failed'));
    if (worker === created) dropWorker();
  };
  created.onerror = (): void => fail();
  created.onmessageerror = (): void => fail();
  return created;
}

function workerFor(): Worker {
  if (!worker) worker = createWorker();
  return worker;
}

interface AutoMessage {
  id: number;
  type: 'auto';
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  modelsBase: string;
}

interface TapMessage {
  id: number;
  type: 'tap';
  x: number;
  y: number;
  label: 0 | 1;
  w: number;
  h: number;
}

type WorkerMessage = AutoMessage | TapMessage;

function request(
  message: WorkerMessage,
  transfer: Transferable[] = [],
  onProgress?: (progress: CutoutProgress) => void,
): Promise<Uint8Array> {
  const target = workerFor();
  return new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      // The worker keeps one shared session for every request, so a request that
      // stays unanswered this long makes the whole worker unusable: fail every
      // pending request and terminate it. The next request starts a new worker.
      rejectPending(new Error('segment: worker did not answer within 120s'));
      if (worker === target) dropWorker();
    }, REQUEST_TIMEOUT_MS);
    pending.set(
      message.id,
      onProgress ? { resolve, reject, onProgress, timer } : { resolve, reject, timer },
    );
    target.postMessage(message, transfer);
  });
}

export async function autoCutout(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  onProgress?: (progress: CutoutProgress) => void,
): Promise<Uint8Array> {
  clearIdleTimer();
  // The worker takes ownership of the pixel copy; transfer instead of cloning.
  const copy = rgba.slice();
  const mask = await request(
    { id: nextId++, type: 'auto', rgba: copy, w, h, modelsBase: modelsBase() },
    [copy.buffer],
    onProgress,
  );
  hasEmbeddings = true;
  return mask;
}

export async function tapMask(
  x: number,
  y: number,
  label: 0 | 1,
  w: number,
  h: number,
): Promise<Uint8Array> {
  if (!hasEmbeddings) throw new Error('segment: autoCutout() must run before tapMask()');
  clearIdleTimer();
  return request({ id: nextId++, type: 'tap', x, y, label, w, h });
}

/**
 * Close the current image: reject anything still in flight. A worker that was
 * mid-request is terminated at once, because its session and embedding state is
 * shared and cannot be handed to a second run; an idle worker is told to drop
 * its embeddings and kept for a short idle window so an immediate reopen reuses
 * it, then the idle timer terminates it to return the wasm heap.
 */
export function resetCutout(): void {
  const busy = pending.size > 0;
  hasEmbeddings = false;
  rejectPending(new Error('segment: cancelled'));
  if (busy || !worker) {
    dropWorker();
    return;
  }
  worker.postMessage({ type: 'reset' });
  scheduleIdleTermination();
}
