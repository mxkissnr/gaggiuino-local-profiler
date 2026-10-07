import { describe, it, expect, beforeEach, vi } from 'vitest';

// import.ts's module graph (state, i18n, api) reads localStorage/navigator at
// load (the other library tests' pattern), so stub the browser globals before
// importing it below.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };

// Manual entry ends in the same backend proxy lookup a camera hit uses
// (libraryApi.scanBarcode); mocking the API keeps the test off the network and
// lets it assert the code that reaches the Open Food Facts path.
const api = vi.hoisted(() => ({ scanBarcode: vi.fn<(barcode: string) => Promise<Response>>() }));
vi.mock('../public-src/api/library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/library.js')>();
  return { ...actual, scanBarcode: api.scanBarcode };
});

// library.js is huge and only openBeanForm() is reachable from the scan paths,
// so stand it in (same as library-scan-detector.test.ts).
vi.mock('../public-src/views/library.js', () => ({ openBeanForm: vi.fn() }));

interface ScanState {
  _scanActive: boolean;
  currentLang: string;
}
interface ScanModule {
  _submitManualScan: () => void;
}

const { S } = (await import('../public-src/state/index.js')) as unknown as { S: ScanState };
const { t } = (await import('../public-src/i18n.js')) as unknown as { t: (key: string) => string };
const { _submitManualScan } =
  (await import('../public-src/views/library/import.js')) as unknown as ScanModule;

interface FakeEl {
  id: string;
  textContent: string;
  className: string;
  value: string;
}

function makeEl(id: string): FakeEl {
  return { id, textContent: '', className: '', value: '' };
}

let elements: Record<string, FakeEl>;

function field(id: string): FakeEl {
  const el = elements[id];
  if (!el) throw new Error(`element ${id} missing`);
  return el;
}

beforeEach(() => {
  elements = { scanManualInput: makeEl('scanManualInput'), scanStatus: makeEl('scanStatus') };
  g.document = { getElementById: (id: string) => elements[id] ?? null };

  api.scanBarcode.mockReset();
  // Hold the lookup open: _handleScanResult() stops at the scanBarcode() call,
  // so the test asserts that call without the post-lookup close/open timers.
  api.scanBarcode.mockImplementation(() => new Promise<Response>(() => {}));

  S._scanActive = true;
  S.currentLang = 'en';
});

describe('barcode scan manual entry (#1500)', () => {
  it('runs the Open Food Facts lookup for a valid EAN-13 and stops the loop', () => {
    field('scanManualInput').value = '4006381333931';

    _submitManualScan();

    expect(api.scanBarcode).toHaveBeenCalledWith('4006381333931');
    expect(S._scanActive).toBe(false);
  });

  it('trims surrounding whitespace before the lookup', () => {
    field('scanManualInput').value = '  4006381333931  ';

    _submitManualScan();

    expect(api.scanBarcode).toHaveBeenCalledWith('4006381333931');
  });

  it('shows scan_invalid_code and skips the lookup for non-numeric input', () => {
    field('scanManualInput').value = '12ab';

    _submitManualScan();

    expect(field('scanStatus').textContent).toBe(t('scan_invalid_code'));
    expect(field('scanStatus').className).toBe('error');
    expect(api.scanBarcode).not.toHaveBeenCalled();
    expect(S._scanActive).toBe(true);
  });

  it('shows scan_invalid_code and skips the lookup for a too-short code', () => {
    field('scanManualInput').value = '123';

    _submitManualScan();

    expect(field('scanStatus').textContent).toBe(t('scan_invalid_code'));
    expect(api.scanBarcode).not.toHaveBeenCalled();
  });
});
