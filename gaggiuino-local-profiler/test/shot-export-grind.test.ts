import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1625 slice 5: exporting a .shot whose annotation.grindSetting is a number
// used to throw a TypeError (a number has no .replace). The download itself is
// not under test, so shareOrDownloadBlob is captured instead of writing a file.

const mock = vi.hoisted(() => ({ blob: null as Blob | null }));

vi.mock('../public-src/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/utils.js')>()),
  shareOrDownloadBlob: vi.fn(async (blob: Blob) => { mock.blob = blob; }),
}));

vi.mock('../public-src/shot-curves.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/shot-curves.js')>()),
  getShotCurve: vi.fn(() => Promise.resolve({ timeInShot: [], pressure: [] })),
}));

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { exportShot } = await import('../public-src/views/shots/index.js');

describe('.shot export with a numeric grind setting (#1625)', () => {
  beforeEach(() => { mock.blob = null; });

  it('does not throw and writes the grind setting', async () => {
    S.primaryShotId = 1;
    S.shots = [
      { id: 1, timestamp: 1700000000, profileName: 'Turbo', annotation: { grindSetting: 12 } },
    ] as unknown as typeof S.shots;

    await expect(exportShot()).resolves.toBeUndefined();

    expect(mock.blob).not.toBeNull();
    expect(await mock.blob!.text()).toContain('grinder_setting {12}');
  });
});
