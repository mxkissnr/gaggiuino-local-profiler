import { describe, it, expect, vi, beforeEach } from 'vitest';

// #2220: the shot donation dialog fetches the file for the chosen range,
// shows its shot count and saves exactly that file only on confirm.

const mocks = vi.hoisted(() => ({
  getShotDonation: vi.fn<(since: string | null) => Promise<unknown>>(),
  openDetailSheet: vi.fn(),
  requestCloseDetailSheet: vi.fn(),
  shareOrDownloadBlob: vi.fn(() => Promise.resolve()),
}));

vi.mock('../public-src/api/system.js', () => ({ getShotDonation: mocks.getShotDonation }));
vi.mock('../public-src/components/detail-sheet.js', () => ({
  openDetailSheet: mocks.openDetailSheet,
  requestCloseDetailSheet: mocks.requestCloseDetailSheet,
}));
vi.mock('../public-src/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/utils.js')>()),
  shareOrDownloadBlob: mocks.shareOrDownloadBlob,
}));

class FakeEl {
  hidden = false;
  disabled = false;
  textContent = '';
  value = '';
  max = '';
  attrs: Record<string, string> = {};
  handlers: Record<string, () => void> = {};
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  addEventListener(type: string, fn: () => void): void { this.handlers[type] = fn; }
}

const IDS = ['donationPanel', 'donationCount', 'donationEmpty', 'donationRangeAll', 'donationRangeSince',
  'donationSinceWrap', 'donationSinceDate', 'donationError', 'donationCancelBtn', 'donationDownloadBtn'];
const els: Record<string, FakeEl> = Object.fromEntries(IDS.map(id => [id, new FakeEl()]));
(globalThis as unknown as Record<string, unknown>).document = { getElementById: (id: string) => els[id] ?? null };

const { donationShotCount, donationFilename, openShotDonation } = await import('../public-src/components/shot-donation.js');
const { todayIsoDate } = await import('../public-src/utils.js');

function fileResponse(n: number): Promise<unknown> {
  const body = JSON.stringify({ format: 'glp-shot-donation', version: 1, shots: Array.from({ length: n }, () => ({})) });
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
}

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  mocks.getShotDonation.mockReset();
  mocks.openDetailSheet.mockReset();
  mocks.requestCloseDetailSheet.mockReset();
  mocks.shareOrDownloadBlob.mockClear();
});

describe('shot donation dialog (#2220)', () => {
  it("counts the shots of a donation file", () => {
    expect(donationShotCount({ format: 'glp-shot-donation', version: 1, shots: [{}, {}] })).toBe(2);
    expect(donationShotCount({ format: 'other', shots: [] })).toBeNull();
    expect(donationShotCount(null)).toBeNull();
  });

  it("names the download after today", () => {
    expect(donationFilename('2026-11-26')).toBe('glp-shot-donation-2026-11-26.json');
  });

  it("opens the panel in a dialog and shows the count", async () => {
    mocks.getShotDonation.mockReturnValue(fileResponse(3));
    openShotDonation();
    await flush();
    expect(mocks.openDetailSheet).toHaveBeenCalledTimes(1);
    const opts = mocks.openDetailSheet.mock.calls[0]![0] as { dialog?: boolean; content?: unknown };
    expect(opts.dialog).toBe(true);
    expect(opts.content).toBe(els.donationPanel);
    expect(mocks.getShotDonation).toHaveBeenCalledWith(null);
    expect(els.donationCount!.textContent).toBe('3');
    expect(els.donationDownloadBtn!.disabled).toBe(false);
  });

  it("keeps download disabled for an empty range", async () => {
    mocks.getShotDonation.mockReturnValue(fileResponse(0));
    openShotDonation();
    await flush();
    expect(els.donationCount!.textContent).toBe('0');
    expect(els.donationDownloadBtn!.disabled).toBe(true);
    expect(els.donationEmpty!.hidden).toBe(false);
  });

  it("since range requests the picked date", async () => {
    mocks.getShotDonation.mockReturnValue(fileResponse(2));
    openShotDonation();
    await flush();
    mocks.getShotDonation.mockClear();
    els.donationRangeSince!.handlers.click!();
    await flush();
    expect(mocks.getShotDonation).not.toHaveBeenCalled();
    expect(els.donationSinceWrap!.hidden).toBe(false);
    expect(els.donationRangeSince!.getAttribute('aria-pressed')).toBe('true');
    els.donationSinceDate!.value = '2026-11-01';
    els.donationSinceDate!.handlers.change!();
    await flush();
    expect(mocks.getShotDonation).toHaveBeenLastCalledWith('2026-11-01');
    expect(els.donationCount!.textContent).toBe('2');
  });

  it("shows an error and no download on a failed request", async () => {
    mocks.getShotDonation.mockReturnValue(Promise.resolve({ ok: false, status: 429, text: () => Promise.resolve('') }));
    openShotDonation();
    await flush();
    expect(els.donationError!.hidden).toBe(false);
    expect(els.donationError!.textContent).not.toBe('');
    expect(els.donationDownloadBtn!.disabled).toBe(true);
  });

  it("downloads only after confirming", async () => {
    mocks.getShotDonation.mockReturnValue(fileResponse(1));
    openShotDonation();
    await flush();
    expect(mocks.shareOrDownloadBlob).not.toHaveBeenCalled();
    els.donationDownloadBtn!.handlers.click!();
    await flush();
    expect(mocks.shareOrDownloadBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = mocks.shareOrDownloadBlob.mock.calls[0] as unknown as [Blob, string];
    expect(blob).toBeInstanceOf(Blob);
    expect(name).toBe(`glp-shot-donation-${todayIsoDate()}.json`);
    expect(mocks.requestCloseDetailSheet).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale response", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    mocks.getShotDonation
      .mockReturnValueOnce(new Promise(r => { resolveFirst = r; }))
      .mockReturnValueOnce(fileResponse(5));
    openShotDonation();
    els.donationRangeAll!.handlers.click!();
    await flush();
    resolveFirst({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ format: 'glp-shot-donation', shots: [{}] })) });
    await flush();
    expect(els.donationCount!.textContent).toBe('5');
  });
});
