import { describe, it, expect, beforeEach } from 'vitest';

// library.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as the other library tests).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');
interface LibraryModule {
  renderBeanCard: (b: unknown, beans: unknown[], opts?: { inSheet?: boolean }) => string;
  renderBeanList: () => void;
  openBeanSheet: (id: number) => void;
  closeBeanSheet: () => void;
}
const { renderBeanCard, renderBeanList, openBeanSheet, closeBeanSheet } =
  (await import('../public-src/views/library.js')) as unknown as LibraryModule;

interface FakeNode {
  id: string;
  className: string;
  innerHTML: string;
  querySelector: () => null;
  querySelectorAll: () => never[];
  classList: { add: () => void; remove: () => void };
  focus: () => void;
}

// The sheet appends one persistent host to <body>; the fake document gives it
// just enough DOM (createElement / appendChild / getElementById) to land
// there and be inspected through its innerHTML.
function fakeDocument() {
  const makeNode = (): FakeNode => ({
    id: '', className: '', innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {} },
    focus: () => {},
  });
  const elements: Record<string, FakeNode> = { beanListUI: makeNode() };
  const body = {
    classList: { add: () => {}, remove: () => {} },
    appendChild: (el: FakeNode) => { elements[el.id] = el; },
  };
  const document = {
    getElementById: (id: string) => elements[id],
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

function setup(over: Record<string, unknown> = {}) {
  const { elements, document } = fakeDocument();
  g.document = document;
  S.coffeeLibrary = {
    beans: [{
      id: 1,
      name: 'Yirgacheffe Chelelektu',
      roaster: 'Kaffee Braun',
      origin: 'ET',
      flavors: ['Jasmin'],
      bags: [
        { id: 1, stock_g: 250, consumedG: 100, remainingG: 150, current: true, roastDate: '2026-01-01' },
        { id: 2, stock_g: 250, consumedG: 250, remainingG: 0, roastDate: '2019-01-01' },
      ],
      ...over,
    }],
    grinders: [],
  };
  return { elements, document };
}

function sheetHtml(elements: Record<string, FakeNode>): string {
  const sheet = elements.beanSheet;
  if (sheet === undefined) throw new Error('bean sheet host missing');
  return sheet.innerHTML;
}

describe('bean detail sheet (#1330 part 2)', () => {
  beforeEach(() => {
    S.shots = [];
    S.currentLang = 'en';
  });

  it('opens a sheet with the bean name, the three primary actions and the archive label', () => {
    const { elements } = setup();
    openBeanSheet(1);

    const html = sheetHtml(elements);
    expect(html).toContain('id="beanSheetTitle"');
    expect(html).toContain('Yirgacheffe Chelelektu');
    expect(html).toContain('data-action="filter-by-bean"');   // Shot log
    expect(html).toContain('data-action="open-new-bag"');     // Bag +
    expect(html).toContain('data-action="open-freeze-form"'); // Freeze
    expect(html).toContain('data-action="toggle-bean-active"');
    expect(html).toContain('>' + t('lib_btn_archive') + '<');
    expect(html).toContain(t('lib_sheet_shot_log'));
    expect(html).toContain('data-action="close-bean-sheet"');
  });

  it('shows Restore for an archived bean', () => {
    const { elements } = setup({ enabled: false });
    openBeanSheet(1);

    const html = sheetHtml(elements);
    expect(html).toContain('>' + t('lib_btn_restore') + '<');
    expect(html).not.toContain('>' + t('lib_btn_archive') + '<');
  });

  it('renders the embedded card without the toolbar but with the bag history', () => {
    setup();
    const beans = S.coffeeLibrary.beans;
    const card = renderBeanCard(beans[0], beans, { inSheet: true });

    expect(card).not.toContain('lib-item-toolbar');
    expect(card).not.toContain('lib-bean-thumb');
    expect(card).toContain('lib-bag-history');
    expect(card).toContain('data-action="toggle-past-bags"');
  });

  it('closes and clears the sheet', () => {
    const { elements } = setup();
    openBeanSheet(1);
    expect(sheetHtml(elements)).not.toBe('');

    closeBeanSheet();
    expect(sheetHtml(elements)).toBe('');
  });

  it('closes the sheet when the open bean is gone on re-render', () => {
    const { elements } = setup();
    openBeanSheet(1);

    S.coffeeLibrary.beans = [];
    renderBeanList();

    expect(sheetHtml(elements)).toBe('');
  });
});
