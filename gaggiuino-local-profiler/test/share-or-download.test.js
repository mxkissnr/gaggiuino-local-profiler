import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shareOrDownloadBlob } from '../public-src/utils.js';

// Minimal browser-global stubs — this module runs in a plain Node test
// environment (no jsdom), so File/navigator/document/URL are faked just
// enough to exercise the share-vs-download branching logic.
let clickSpy;

function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

beforeEach(() => {
  clickSpy = vi.fn();
  global.File = class { constructor(parts, name, opts) { this.name = name; this.type = opts?.type; } };
  global.document = { createElement: () => ({ click: clickSpy }) };
  global.URL = { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() };
  setNavigator({});
});

describe('shareOrDownloadBlob', () => {
  it('uses navigator.share when canShare is true and never falls back', async () => {
    const share = vi.fn().mockResolvedValue();
    setNavigator({ canShare: () => true, share });
    await shareOrDownloadBlob({ type: 'text/csv' }, 'shots.csv', { title: 'Shots' });
    expect(share).toHaveBeenCalledWith({ files: [expect.anything()], title: 'Shots' });
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('respects a user-cancelled share (AbortError) without falling back', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    setNavigator({ canShare: () => true, share: vi.fn().mockRejectedValue(abort) });
    await shareOrDownloadBlob({ type: 'text/csv' }, 'shots.csv', {});
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('falls back to anchor download when share fails for another reason (default fallbackOnError)', async () => {
    setNavigator({ canShare: () => true, share: vi.fn().mockRejectedValue(new Error('nope')) });
    await shareOrDownloadBlob({ type: 'text/csv' }, 'shots.csv', {});
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-abort share error when fallbackOnError is false', async () => {
    setNavigator({ canShare: () => true, share: vi.fn().mockRejectedValue(new Error('nope')) });
    await expect(shareOrDownloadBlob({ type: 'image/png' }, 'card.png', { fallbackOnError: false }))
      .rejects.toThrow('nope');
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('goes straight to anchor download when the platform cannot share files', async () => {
    setNavigator({ canShare: undefined });
    await shareOrDownloadBlob({ type: 'application/json' }, 'backup.json', {});
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
