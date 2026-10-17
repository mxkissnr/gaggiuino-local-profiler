import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1626: the shot CSV export must not hand a spreadsheet app a cell it reads as
// a formula. The download itself is not under test, so shareOrDownloadBlob is
// captured instead of writing a file (same approach as
// frontend-small-fixes-1625.test.ts).

const mock = vi.hoisted(() => ({ blob: null as Blob | null }));

vi.mock('../public-src/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/utils.js')>()),
  shareOrDownloadBlob: vi.fn((blob: Blob) => { mock.blob = blob; return Promise.resolve(); }),
}));

vi.mock('../public-src/shot-curves.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/shot-curves.js')>()),
  getShotCurve: vi.fn(() => Promise.resolve(null)),
  getCachedShotData: vi.fn(() => null),
}));

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };

const { S } = await import('../public-src/state/index.js');
const { exportCSV } = await import('../public-src/views/shots/index.js');
const { neutraliseCsvText } = await import('../public-src/views/shots/export.js');

describe('CSV formula neutralisation (#1626)', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx'])('prefixes %j with an apostrophe', (v) => {
    expect(neutraliseCsvText(v)).toBe(`'${v}`);
  });

  it.each(['Ethiopia', '', '-2', '+1.5', '3,5', 'a=b'])('leaves %j unchanged', (v) => {
    expect(neutraliseCsvText(v)).toBe(v);
  });

  describe('exportCSV', () => {
    beforeEach(() => { mock.blob = null; });

    it('neutralises every text column of an exported row', async () => {
      S.primaryShotId = 1;
      S.shots = [{
        id: 1, timestamp: 1700000000, profileName: '=HYPERLINK("x")',
        annotation: { coffee: '+bean', grinder: '@grinder', grindSetting: -2, notes: '-1+1' },
      }];

      await exportCSV();

      const text = await mock.blob!.text();
      const row = text.split('\r\n')[1]!;
      expect(row).toContain(`"'=HYPERLINK(""x"")"`);
      expect(row).toContain(`"'+bean"`);
      expect(row).toContain(`"'@grinder"`);
      expect(row).toContain(`"-2"`);
      expect(row).toContain(`"'-1+1"`);
    });
  });
});
