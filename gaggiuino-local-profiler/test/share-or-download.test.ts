import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shareOrDownloadBlob } from '../public-src/utils.js';

// Minimal browser-global stubs — this module runs in a plain Node test
// environment (no jsdom), so File/navigator/document/URL are faked just
// enough to exercise the share-vs-download branching logic.
let clickSpy: ReturnType<typeof vi.fn>;

// globalThis carries the full DOM type; stub only the sliver utils.js reads.
const g = globalThis as unknown as Record<string, unknown>;

function setNavigator(value: unknown) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

beforeEach(() => {
  clickSpy = vi.fn();
  g.File = class {
    name: string;
    type: string | undefined;
    constructor(_parts: unknown[], name: string, opts?: { type?: string }) {
      this.name = name;
      this.type = opts?.type;
    }
  };
  g.document = { createElement: () => ({ click: clickSpy }) };
  g.URL = { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() };
  setNavigator({});
});

describe('shareOrDownloadBlob', () => {
  it('uses navigator.share when canShare is true and never falls back', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigator({ canShare: () => true, share });
    await shareOrDownloadBlob({ type: 'text/csv' } as Blob, 'shots.csv', { title: 'Shots' });
    expect(share).toHaveBeenCalledWith({ files: [expect.anything()], title: 'Shots' });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('respects a user-cancelled share (AbortError) without falling back', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    setNavigator({ canShare: () => true, share: vi.fn().mockRejectedValue(abort) });
    await shareOrDownloadBlob({ type: 'text/csv' } as Blob, 'shots.csv', {});
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('falls back to anchor download when share fails for another reason (default fallbackOnError)', async () => {
    setNavigator({ canShare: () => true, share: vi.fn().mockRejectedValue(new Error('nope')) });
    await shareOrDownloadBlob({ type: 'text/csv' } as Blob, 'shots.csv', {});
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-abort share error when fallbackOnError is false', async () => {
    setNavigator({ canShare: () => true, share: vi.fn().mockRejectedValue(new Error('nope')) });
    await expect(shareOrDownloadBlob({ type: 'image/png' } as Blob, 'card.png', { fallbackOnError: false }))
      .rejects.toThrow('nope');
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('goes straight to anchor download when the platform cannot share files', async () => {
    setNavigator({ canShare: undefined });
    await shareOrDownloadBlob({ type: 'application/json' } as Blob, 'backup.json', {});
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
