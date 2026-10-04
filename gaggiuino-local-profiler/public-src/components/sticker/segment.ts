/**
 * Lazy on-device sticker cut-out — main-thread client.
 *
 * The model work itself runs in segment.worker.ts, so the page stays responsive
 * while IS-Net and the SAM encoder run. This module only owns the worker's
 * lifetime and the request/response plumbing; the exported API is unchanged, so
 * editor.ts and views/library.ts need no change. Terminating the worker (on
 * editor close) is what returns the WebAssembly heap to the browser.
 */

const ISNET_MODEL = 'isnet-general-use-int8.onnx';

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

interface Pending {
  resolve: (mask: Uint8Array) => void;
  reject: (err: unknown) => void;
}

let worker: Worker | null = null;
let nextId = 1;
// True once the current worker has finished an autoCutout(); taps are only
// valid against embeddings the worker still holds.
let hasEmbeddings = false;
const pending = new Map<number, Pending>();

function rejectPending(err: unknown): void {
  for (const entry of pending.values()) entry.reject(err);
  pending.clear();
}

function dropWorker(): void {
  if (!worker) return;
  worker.terminate();
  worker = null;
}

function createWorker(): Worker {
  const created = new Worker(new URL('./segment.worker.ts', import.meta.url), { type: 'module' });
  created.onmessage = (event: MessageEvent): void => {
    const msg = event.data as { id?: number; mask?: Uint8Array; error?: string };
    if (typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) entry.reject(new Error(msg.error));
    else entry.resolve(msg.mask ?? new Uint8Array());
  };
  const fail = (): void => {
    rejectPending(new Error('segment: worker failed'));
    if (worker === created) {
      created.terminate();
      worker = null;
    }
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

function request(message: WorkerMessage, transfer: Transferable[] = []): Promise<Uint8Array> {
  const target = workerFor();
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(message.id, { resolve, reject });
    target.postMessage(message, transfer);
  });
}

export async function autoCutout(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): Promise<Uint8Array> {
  // The worker takes ownership of the pixel copy; transfer instead of cloning.
  const copy = rgba.slice();
  const mask = await request(
    { id: nextId++, type: 'auto', rgba: copy, w, h, modelsBase: modelsBase() },
    [copy.buffer as ArrayBuffer],
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
  return request({ id: nextId++, type: 'tap', x, y, label, w, h });
}

/**
 * Drop the worker: reject anything still in flight, terminate it (which frees
 * the wasm heap) and forget it, so the next cut-out starts a fresh one.
 */
export function resetCutout(): void {
  hasEmbeddings = false;
  rejectPending(new Error('segment: cancelled'));
  dropWorker();
}
