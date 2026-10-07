import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

// import.ts's module graph (state, i18n, api) reads localStorage/navigator at
// load (the other library tests' pattern), so stub the browser globals before
// importing it below.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };

// The ponyfill is only reached when the browser has no native BarcodeDetector.
// In the node test runner it is always mocked, so the detector-selection logic
// is observable without loading the real zxing wasm. vi.hoisted is required so
// the factory below can close over these before the module graph is imported.
const ponyfill = vi.hoisted(() => ({
  prepareZXingModule: vi.fn<(options?: { fireImmediately?: boolean }) => Promise<void> | void>(),
  constructed: vi.fn<(options: unknown) => void>(),
  detect: vi.fn<(source: unknown) => Promise<{ rawValue: string }[]>>(),
}));
vi.mock('barcode-detector/ponyfill', () => ({
  BarcodeDetector: class {
    constructor(options: unknown) {
      ponyfill.constructed(options);
    }
    detect(source: unknown): Promise<{ rawValue: string }[]> {
      return ponyfill.detect(source);
    }
  },
  prepareZXingModule: ponyfill.prepareZXingModule,
}));

// library.js is huge and only openBeanForm() is reachable from the scanner
// paths exercised here, so stand it in.
vi.mock('../public-src/views/library.js', () => ({ openBeanForm: vi.fn() }));

interface ScanState {
  _scanActive: boolean;
  currentLang: string;
}
interface ScanModule {
  openScanModal: () => Promise<void>;
  closeScanModal: () => void;
}

const { S } = (await import('../public-src/state/index.js')) as unknown as { S: ScanState };
const { t } = (await import('../public-src/i18n.js')) as unknown as { t: (key: string) => string };
const { openScanModal, closeScanModal } =
  (await import('../public-src/views/library/import.js')) as unknown as ScanModule;

const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'data_matrix'];

class FakeClassList {
  private readonly set = new Set<string>();
  add(c: string): void { this.set.add(c); }
  remove(c: string): void { this.set.delete(c); }
  contains(c: string): boolean { return this.set.has(c); }
}

interface FakeEl {
  id: string;
  textContent: string;
  className: string;
  srcObject: unknown;
  classList: FakeClassList;
}

function makeEl(id: string): FakeEl {
  return { id, textContent: '', className: '', srcObject: null, classList: new FakeClassList() };
}

type Stream = { getTracks: () => { stop: () => void }[] };
type GetUserMedia = (constraints?: unknown) => Promise<Stream>;

let elements: Record<string, FakeEl>;
let getUserMedia: Mock<GetUserMedia>;

const nav = globalThis.navigator as unknown as Record<string, unknown>;

function fakeStream(): { stream: Stream; track: { stop: Mock<() => void> } } {
  const stop = vi.fn<() => void>();
  return { stream: { getTracks: () => [{ stop }] }, track: { stop } };
}

function scanStatus(): FakeEl {
  const el = elements.scanStatus;
  if (!el) throw new Error('scanStatus element missing');
  return el;
}

beforeEach(() => {
  elements = {
    scanModal: makeEl('scanModal'),
    scanVideo: makeEl('scanVideo'),
    scanStatus: makeEl('scanStatus'),
  };
  g.document = { getElementById: (id: string) => elements[id] ?? null };

  getUserMedia = vi.fn<GetUserMedia>();
  nav.mediaDevices = { getUserMedia };

  ponyfill.constructed.mockReset();
  ponyfill.detect.mockReset();
  ponyfill.detect.mockResolvedValue([]);
  ponyfill.prepareZXingModule.mockReset();
  ponyfill.prepareZXingModule.mockImplementation(() => Promise.resolve());

  S._scanActive = false;
  S.currentLang = 'en';
});

afterEach(() => {
  delete g.window;
  delete g.BarcodeDetector;
});

describe('barcode scanner detector selection (#1500)', () => {
  it('uses the native BarcodeDetector when the browser has one, without importing the ponyfill', async () => {
    const nativeOptions: unknown[] = [];
    function NativeDetector(options: { formats: string[] }): { detect: () => Promise<{ rawValue: string }[]> } {
      nativeOptions.push(options);
      return { detect: () => Promise.resolve([]) };
    }
    g.BarcodeDetector = NativeDetector;
    g.window = g;
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);

    await openScanModal();

    expect(nativeOptions).toEqual([{ formats: SCAN_FORMATS }]);
    expect(ponyfill.constructed).not.toHaveBeenCalled();
    expect(ponyfill.prepareZXingModule).not.toHaveBeenCalled();
    expect(S._scanActive).toBe(true);
    closeScanModal();
  });

  it('falls back to the dynamically imported ponyfill when there is no native detector', async () => {
    g.window = {};
    const { stream } = fakeStream();
    getUserMedia.mockResolvedValue(stream);

    await openScanModal();

    expect(ponyfill.constructed).toHaveBeenCalledWith({ formats: SCAN_FORMATS });
    // The reader wasm is loaded eagerly (not left to the first detect()).
    expect(ponyfill.prepareZXingModule).toHaveBeenCalledWith({ fireImmediately: true });
    expect(S._scanActive).toBe(true);
    closeScanModal();
  });

  it('shows scan_not_supported and releases the camera when the wasm fails to load', async () => {
    g.window = {};
    const { stream, track } = fakeStream();
    getUserMedia.mockResolvedValue(stream);
    ponyfill.prepareZXingModule.mockImplementation((options) =>
      options?.fireImmediately ? Promise.reject(new Error('wasm failed')) : undefined);

    await openScanModal();

    expect(scanStatus().textContent).toBe(t('scan_not_supported'));
    expect(scanStatus().className).toBe('error');
    expect(track.stop).toHaveBeenCalledOnce();
    expect(ponyfill.constructed).not.toHaveBeenCalled();
    expect(S._scanActive).toBe(false);
  });

  it('does not start the scan loop when the modal is closed while the camera is starting', async () => {
    g.window = {};
    const { stream, track } = fakeStream();
    let resolveStream: (s: Stream) => void = () => {};
    getUserMedia.mockImplementation(() => new Promise<Stream>((res) => { resolveStream = res; }));

    const pending = openScanModal();
    expect(getUserMedia).toHaveBeenCalledOnce();
    closeScanModal();
    resolveStream(stream);
    await pending;

    expect(S._scanActive).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(ponyfill.constructed).not.toHaveBeenCalled();
  });
});
