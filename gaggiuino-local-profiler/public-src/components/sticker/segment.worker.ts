/**
 * Module Web Worker for the sticker cut-out (#1347).
 *
 * The onnxruntime-web models run here, off the main thread, so IS-Net and the
 * SAM encoder can no longer freeze the page while they run. The worker owns the
 * wasm heap, so terminating it when the editor closes is what gives the memory
 * back to the browser.
 */

import { autoCutout, tapMask, resetCutout } from './segment-core.js';

interface AutoRequest {
  id: number;
  type: 'auto';
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  modelsBase: string;
}

interface TapRequest {
  id: number;
  type: 'tap';
  x: number;
  y: number;
  label: 0 | 1;
  w: number;
  h: number;
}

interface ResetRequest {
  type: 'reset';
}

type Request = AutoRequest | TapRequest | ResetRequest;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function reply(id: number, mask: Uint8Array): void {
  ctx.postMessage({ id, mask }, [mask.buffer as ArrayBuffer]);
}

async function handle(msg: AutoRequest | TapRequest): Promise<void> {
  try {
    if (msg.type === 'auto') {
      reply(msg.id, await autoCutout(msg.rgba, msg.w, msg.h, msg.modelsBase));
    } else {
      reply(msg.id, await tapMask(msg.x, msg.y, msg.label, msg.w, msg.h));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'segment: worker request failed';
    ctx.postMessage({ id: msg.id, error: message });
  }
}

ctx.onmessage = (event: MessageEvent<Request>): void => {
  const msg = event.data;
  if (msg.type === 'reset') {
    resetCutout();
    return;
  }
  void handle(msg);
};
