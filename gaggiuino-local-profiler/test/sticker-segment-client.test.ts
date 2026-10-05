import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A stand-in for the real Worker: it records what the client posts and lets a
 * test reply (or error) exactly like the worker would from another thread.
 * Fields are assigned in the constructor because tsconfig's erasableSyntaxOnly
 * forbids parameter properties.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  sent: Array<{ message: { id?: number; type: string }; transfer: Transferable[] | undefined }> = [];
  url: URL;
  options: WorkerOptions | undefined;

  constructor(url: URL, options?: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  postMessage(message: { id?: number; type: string }, transfer?: Transferable[]): void {
    this.sent.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(data: unknown): void {
    this.onmessage?.({ data } as unknown as MessageEvent);
  }

  fail(): void {
    this.onerror?.({ message: 'worker failed' } as unknown as ErrorEvent);
  }
}

type Client = typeof import('../public-src/components/sticker/segment.js');

async function freshClient(): Promise<Client> {
  vi.resetModules();
  return await import('../public-src/components/sticker/segment.js');
}

function latestWorker(): FakeWorker {
  const worker = FakeWorker.instances.at(-1);
  if (!worker) throw new Error('no worker was created');
  return worker;
}

const W = 8;
const H = 6;
const RGBA = new Uint8ClampedArray(W * H * 4);

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', { baseURI: 'https://example.test/glp/' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('isStickerCutoutAvailable', () => {
  const MODELS = { version: 'models-v1', sizes: {} };

  it('is true when the HEAD probe succeeds, and probes once', async () => {
    vi.stubGlobal('__GLP_CUTOUT_MODELS__', MODELS);
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const segment = await freshClient();

    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(true);
    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('models/models-v1/isnet-general-use-int8.onnx', {
      method: 'HEAD',
    });
  });

  it('is false and cached when the probe returns 404', async () => {
    vi.stubGlobal('__GLP_CUTOUT_MODELS__', MODELS);
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    const segment = await freshClient();

    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(false);
    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is false and retried when the probe throws', async () => {
    vi.stubGlobal('__GLP_CUTOUT_MODELS__', MODELS);
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('no network'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const segment = await freshClient();

    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(false);
    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('is false and retried when the probe fails transiently', async () => {
    vi.stubGlobal('__GLP_CUTOUT_MODELS__', MODELS);
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    const segment = await freshClient();

    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(false);
    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('is false without the models manifest, without probing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const segment = await freshClient();

    await expect(segment.isStickerCutoutAvailable()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('autoCutout', () => {
  it('posts the pixels and resolves with the mask the worker sends back', async () => {
    const segment = await freshClient();
    const promise = segment.autoCutout(RGBA, W, H);
    const worker = latestWorker();

    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker.sent).toHaveLength(1);
    const { message, transfer } = worker.sent[0]!;
    expect(message.type).toBe('auto');
    expect(transfer).toHaveLength(1);

    const mask = new Uint8Array([1, 2, 3]);
    worker.reply({ id: message.id, mask });
    await expect(promise).resolves.toBe(mask);
  });

  it('creates a module worker from the source URL when no name is injected', async () => {
    const segment = await freshClient();
    const promise = segment.autoCutout(RGBA, W, H);
    const worker = latestWorker();

    expect(worker.url.toString().endsWith('segment.worker.ts')).toBe(true);
    expect(worker.options).toEqual({ type: 'module' });

    worker.reply({ id: worker.sent[0]!.message.id, mask: new Uint8Array([0]) });
    await promise;
  });

  it('sends the versioned models base resolved against document.baseURI', async () => {
    vi.stubGlobal('__GLP_CUTOUT_MODELS__', { version: 'models-v1', sizes: {} });
    const segment = await freshClient();
    const promise = segment.autoCutout(RGBA, W, H);
    const worker = latestWorker();

    // The message is a union at runtime, so read the field through the union.
    const posted = worker.sent[0]!.message as { modelsBase?: string };
    expect(posted.modelsBase).toBe('https://example.test/glp/models/models-v1/');

    worker.reply({ id: worker.sent[0]!.message.id, mask: new Uint8Array([0]) });
    await promise;
  });

  it('rejects when the worker replies with an error', async () => {
    const segment = await freshClient();
    const promise = segment.autoCutout(RGBA, W, H);
    const worker = latestWorker();

    worker.reply({ id: worker.sent[0]!.message.id, error: 'model boom' });
    await expect(promise).rejects.toThrow('model boom');
  });

  it('forwards a progress message without settling the request', async () => {
    const segment = await freshClient();
    const updates: { stage: string; fraction: number | null }[] = [];
    const promise = segment.autoCutout(RGBA, W, H, (p) => {
      updates.push({ stage: p.stage, fraction: p.fraction });
    });
    const worker = latestWorker();
    const id = worker.sent[0]!.message.id;

    worker.reply({ id, progress: { stage: 'download', fraction: 0.5 } });

    expect(updates).toEqual([{ stage: 'download', fraction: 0.5 }]);
    // A progress message must leave the request pending for the final mask.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const mask = new Uint8Array([7, 8, 9]);
    worker.reply({ id, mask });
    await expect(promise).resolves.toBe(mask);
  });
});

describe('tapMask', () => {
  it('rejects before autoCutout has run for this image', async () => {
    const segment = await freshClient();
    await expect(segment.tapMask(1, 1, 1, W, H)).rejects.toThrow(/autoCutout/);
  });

  it('resolves a tap after a successful autoCutout', async () => {
    const segment = await freshClient();
    const auto = segment.autoCutout(RGBA, W, H);
    const worker = latestWorker();
    worker.reply({ id: worker.sent[0]!.message.id, mask: new Uint8Array([1]) });
    await auto;

    const tap = segment.tapMask(2, 3, 1, W, H);
    expect(worker.sent).toHaveLength(2);
    const mask = new Uint8Array([4, 5]);
    worker.reply({ id: worker.sent[1]!.message.id, mask });
    await expect(tap).resolves.toBe(mask);
  });
});

describe('resetCutout', () => {
  it('sends reset, keeps the worker, and terminates it after the idle window', async () => {
    vi.useFakeTimers();
    const segment = await freshClient();
    const auto = segment.autoCutout(RGBA, W, H);
    const worker = latestWorker();
    worker.reply({ id: worker.sent[0]!.message.id, mask: new Uint8Array([1]) });
    await auto;

    segment.resetCutout();

    expect(worker.terminated).toBe(false);
    expect(worker.sent.at(-1)!.message.type).toBe('reset');

    vi.advanceTimersByTime(20_000);
    expect(worker.terminated).toBe(true);
  });

  it('terminates the worker at once when a request is still in flight', async () => {
    vi.useFakeTimers();
    const segment = await freshClient();
    const promise = segment.autoCutout(RGBA, W, H);
    const worker = latestWorker();

    segment.resetCutout();

    await expect(promise).rejects.toThrow(/cancelled/);
    expect(worker.terminated).toBe(true);
    expect(worker.sent.map((entry) => entry.message.type)).toEqual(['auto']);

    const next = segment.autoCutout(RGBA, W, H);
    expect(FakeWorker.instances).toHaveLength(2);
    const second = latestWorker();
    second.reply({ id: second.sent[0]!.message.id, mask: new Uint8Array([2]) });
    await expect(next).resolves.toEqual(new Uint8Array([2]));
  });

  it('reuses the worker when autoCutout runs within the idle window', async () => {
    vi.useFakeTimers();
    const segment = await freshClient();
    const first = segment.autoCutout(RGBA, W, H);
    const worker = latestWorker();
    worker.reply({ id: worker.sent[0]!.message.id, mask: new Uint8Array([1]) });
    await first;

    segment.resetCutout();
    expect(worker.terminated).toBe(false);

    const second = segment.autoCutout(RGBA, W, H);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker.sent.at(-1)!.message.type).toBe('auto');

    // The reuse cleared the idle timer, so the worker survives the full window.
    vi.advanceTimersByTime(20_000);
    expect(worker.terminated).toBe(false);

    worker.reply({ id: worker.sent.at(-1)!.message.id, mask: new Uint8Array([2]) });
    await expect(second).resolves.toEqual(new Uint8Array([2]));
  });
});

describe('worker failure', () => {
  it('rejects pending requests and starts a new worker next time', async () => {
    const segment = await freshClient();
    const promise = segment.autoCutout(RGBA, W, H);
    const first = latestWorker();

    first.fail();

    await expect(promise).rejects.toThrow();
    expect(first.terminated).toBe(true);

    const count = FakeWorker.instances.length;
    const retry = segment.autoCutout(RGBA, W, H);
    expect(FakeWorker.instances.length).toBe(count + 1);

    const second = latestWorker();
    const mask = new Uint8Array([9]);
    second.reply({ id: second.sent[0]!.message.id, mask });
    await expect(retry).resolves.toBe(mask);
  });
});

describe('request watchdog', () => {
  it('rejects every pending request and terminates the worker when one goes unanswered', async () => {
    vi.useFakeTimers();
    const segment = await freshClient();
    const first = segment.autoCutout(RGBA, W, H);
    const second = segment.autoCutout(RGBA, W, H);
    const worker = latestWorker();
    // Both requests share the one worker and are still waiting for an answer.
    expect(FakeWorker.instances).toHaveLength(1);

    vi.advanceTimersByTime(120_000);

    await expect(first).rejects.toThrow(/did not answer/);
    await expect(second).rejects.toThrow(/did not answer/);
    expect(worker.terminated).toBe(true);

    // The next request starts a fresh worker instead of the terminated one.
    const next = segment.autoCutout(RGBA, W, H);
    expect(FakeWorker.instances).toHaveLength(2);
    const fresh = latestWorker();
    fresh.reply({ id: fresh.sent[0]!.message.id, mask: new Uint8Array([3]) });
    await expect(next).resolves.toEqual(new Uint8Array([3]));
  });

  it('clears the watchdog when the answer arrives before the deadline', async () => {
    vi.useFakeTimers();
    const segment = await freshClient();
    const promise = segment.autoCutout(RGBA, W, H);
    const worker = latestWorker();

    const mask = new Uint8Array([5]);
    worker.reply({ id: worker.sent[0]!.message.id, mask });
    await expect(promise).resolves.toBe(mask);

    vi.advanceTimersByTime(120_000);
    // The cleared watchdog must not terminate the worker after a normal answer.
    expect(worker.terminated).toBe(false);
  });
});
