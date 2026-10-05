import { describe, it, expect, beforeEach, vi } from 'vitest';

// library.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as the other library tests).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

// saveNewBag/saveFreezePortions call into the library API; mocking keeps the
// test off the network and lets each return a canned bean (sticker-cutout
// test pattern).
const mocks = vi.hoisted(() => ({ addBeanBag: vi.fn(), freezeBeanPortions: vi.fn() }));
vi.mock('../public-src/api/library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/library.js')>();
  return { ...actual, addBeanBag: mocks.addBeanBag, freezeBeanPortions: mocks.freezeBeanPortions };
});

interface FakeEl {
  id: string;
  className: string;
  innerHTML: string;
  value: string;
  style: Record<string, string>;
  querySelector: () => null;
  querySelectorAll: (sel: string) => FakeEl[];
  classList: { add: () => void; remove: () => void };
  focus: () => void;
}

// The sheet appends one persistent host to <body>; the fake document gives it
// just enough DOM (createElement / appendChild / getElementById) to land
// there and be inspected (same shape as library-bean-sheet.test.ts, plus the
// value/style/querySelectorAll fields the open-form snapshot reads).
function fakeDocument() {
  const makeNode = (): FakeEl => ({
    id: '', className: '', innerHTML: '', value: '', style: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {} },
    focus: () => {},
  });
  const elements: Record<string, FakeEl> = { beanListUI: makeNode() };
  const body = {
    classList: { add: () => {}, remove: () => {} },
    appendChild: (el: FakeEl) => { elements[el.id] = el; },
  };
  const document = {
    getElementById: (id: string): FakeEl | null => elements[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    body,
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => true,
  };
  return { elements, document };
}

interface LibraryModule {
  openBeanSheet: (id: number) => void;
  closeBeanSheet: () => void;
  renderBeanList: () => void;
  saveNewBag: (id: number) => Promise<void>;
  saveFreezePortions: (id: number) => Promise<void>;
}
interface OpenSheetForms { open: string[]; values: Array<[string, string]> }
interface SheetModule {
  captureOpenSheetForms: (root: unknown) => OpenSheetForms;
  restoreOpenSheetForms: (snap: OpenSheetForms, byId: (id: string) => HTMLElement | null) => void;
}
interface StateLike {
  coffeeLibrary: { beans: Array<Record<string, unknown>>; grinders: unknown[] };
  shots: unknown[];
  currentLang: string;
}

const { S } = (await import('../public-src/state/index.js')) as unknown as { S: StateLike };
const library = (await import('../public-src/views/library.js')) as unknown as LibraryModule;
const { captureOpenSheetForms, restoreOpenSheetForms } =
  (await import('../public-src/views/library/bean-sheet.js')) as unknown as SheetModule;

function el(over: Partial<FakeEl>): FakeEl {
  return {
    id: '', className: '', innerHTML: '', value: '', style: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {} },
    focus: () => {},
    ...over,
  };
}

let elements: Record<string, FakeEl>;

beforeEach(() => {
  const made = fakeDocument();
  elements = made.elements;
  g.document = made.document;
  mocks.addBeanBag.mockReset();
  mocks.freezeBeanPortions.mockReset();
  S.shots = [];
  S.currentLang = 'en';
  S.coffeeLibrary = {
    beans: [{
      id: 1,
      name: 'Bean',
      bags: [{ id: 1, stock_g: 250, consumedG: 100, remainingG: 150, current: true, roastDate: '2026-01-01' }],
    }],
    grinders: [],
  };
});

// Opens the detail sheet, then exposes the given forms from the host's
// querySelectorAll — the snapshot reads them off the sheet root.
function openSheetWith(forms: () => FakeEl[]): void {
  library.openBeanSheet(1);
  elements.beanSheet!.querySelectorAll = (sel: string) => (sel === '.lib-new-bag-form' ? forms() : []);
}

describe('bean sheet open-form snapshot (#1412)', () => {
  it('captures the open forms and their typed values, skipping closed ones', () => {
    const root = {
      querySelectorAll: (sel: string): FakeEl[] => {
        if (sel === '.lib-new-bag-form') {
          return [
            el({
              id: 'newBagForm1',
              style: { display: '' },
              querySelectorAll: () => [
                el({ id: 'newBagRoastDate1', value: '2026-10-01' }),
                el({ id: 'newBagStock1', value: '250' }),
                el({ id: 'newBagBatchNumber1', value: 'L-42' }),
              ],
            }),
            el({
              id: 'freezeForm1',
              style: { display: 'none' },
              querySelectorAll: () => [el({ id: 'freezePortionCount1', value: '3' })],
            }),
          ];
        }
        if (sel === '.lib-stock-edit-row') {
          return [el({ id: '', style: {}, querySelectorAll: () => [el({ id: 'bagStockEditInput5', value: '120' })] })];
        }
        return [];
      },
    };

    expect(captureOpenSheetForms(root)).toEqual({
      open: ['newBagForm1'],
      values: [
        ['newBagRoastDate1', '2026-10-01'],
        ['newBagStock1', '250'],
        ['newBagBatchNumber1', 'L-42'],
        ['bagStockEditInput5', '120'],
      ],
    });
  });

  it('restores display and values, leaving other forms alone and missing ids harmless', () => {
    const els: Record<string, FakeEl> = {
      newBagForm1: el({ id: 'newBagForm1', style: { display: 'none' } }),
      newBagStock1: el({ id: 'newBagStock1', value: '' }),
      freezeForm1: el({ id: 'freezeForm1', style: { display: 'none' } }),
      bagStockEditInput5: el({ id: 'bagStockEditInput5', value: '80' }),
    };

    restoreOpenSheetForms(
      {
        open: ['newBagForm1'],
        values: [['newBagStock1', '250'], ['bagStockEditInput5', '120'], ['editFrozenRemaining9', '2']],
      },
      id => (els[id] ?? null) as unknown as HTMLElement | null,
    );

    expect(els.newBagForm1!.style.display).toBe('');
    expect(els.newBagStock1!.value).toBe('250');
    expect(els.bagStockEditInput5!.value).toBe('120');
    expect(els.freezeForm1!.style.display).toBe('none');
  });

  it('keeps a bag form open with its typed text through a passive re-render', () => {
    const stock = el({ id: 'newBagStock1', value: '250' });
    const batch = el({ id: 'newBagBatchNumber1', value: 'L-42' });
    const typed = el({ id: 'newBagForm1', style: { display: '' }, querySelectorAll: () => [stock, batch] });
    openSheetWith(() => [typed]);

    // The re-render rebuilds the host's innerHTML, so the fresh markup starts
    // closed and empty.
    elements.newBagForm1 = el({ id: 'newBagForm1', style: { display: 'none' } });
    elements.newBagStock1 = el({ id: 'newBagStock1', value: '' });
    elements.newBagBatchNumber1 = el({ id: 'newBagBatchNumber1', value: '' });

    library.renderBeanList();

    expect(elements.newBagForm1!.style.display).toBe('');
    expect(elements.newBagStock1!.value).toBe('250');
    expect(elements.newBagBatchNumber1!.value).toBe('L-42');
  });

  it('starts a fresh open closed', () => {
    const typed = el({ id: 'newBagForm1', style: { display: '' }, querySelectorAll: () => [el({ id: 'newBagStock1', value: '250' })] });
    openSheetWith(() => [typed]);

    library.closeBeanSheet();

    elements.newBagForm1 = el({ id: 'newBagForm1', style: { display: 'none' } });
    elements.newBagStock1 = el({ id: 'newBagStock1', value: '' });

    library.openBeanSheet(1);

    expect(elements.newBagForm1!.style.display).toBe('none');
    expect(elements.newBagStock1!.value).toBe('');
  });

  it('saving a new bag closes its form', async () => {
    const roast = el({ id: 'newBagRoastDate1', value: '2026-10-01' });
    const stock = el({ id: 'newBagStock1', value: '250' });
    const batch = el({ id: 'newBagBatchNumber1', value: 'L-42' });
    elements.newBagRoastDate1 = roast;
    elements.newBagStock1 = stock;
    elements.newBagBatchNumber1 = batch;
    elements.newBagForm1 = el({ id: 'newBagForm1', style: { display: '' }, querySelectorAll: () => [roast, stock, batch] });

    openSheetWith(() => [elements.newBagForm1!]);

    mocks.addBeanBag.mockResolvedValue({
      id: 1,
      name: 'Bean',
      bags: [{ id: 2, stock_g: 250, consumedG: 0, remainingG: 250, current: true, roastDate: '2026-10-01' }],
    });

    await library.saveNewBag(1);

    expect(mocks.addBeanBag).toHaveBeenCalledWith(1, { roastDate: '2026-10-01', stock_g: 250, batchNumber: 'L-42' });
    expect(elements.newBagForm1!.style.display).toBe('none');
  });

  it('saving frozen portions closes the freeze form', async () => {
    const count = el({ id: 'freezePortionCount1', value: '3' });
    const weight = el({ id: 'freezePortionWeight1', value: '18' });
    const date = el({ id: 'freezeDate1', value: '2026-10-01' });
    elements.freezePortionCount1 = count;
    elements.freezePortionWeight1 = weight;
    elements.freezeDate1 = date;
    elements.freezeForm1 = el({ id: 'freezeForm1', style: { display: '' }, querySelectorAll: () => [count, weight, date] });

    openSheetWith(() => [elements.freezeForm1!]);

    mocks.freezeBeanPortions.mockResolvedValue({
      id: 1,
      name: 'Bean',
      bags: [{ id: 1, stock_g: 250, consumedG: 100, remainingG: 150, current: true, roastDate: '2026-01-01', frozenPortions: [] }],
    });

    await library.saveFreezePortions(1);

    expect(mocks.freezeBeanPortions).toHaveBeenCalledWith(1, expect.objectContaining({ portionCount: 3, portionWeight_g: 18 }));
    expect(elements.freezeForm1!.style.display).toBe('none');
  });
});
