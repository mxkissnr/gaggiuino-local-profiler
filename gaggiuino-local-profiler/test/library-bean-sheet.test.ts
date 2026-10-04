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
  beanSheetRestoredScroll: (
    prevBeanId: number | null,
    nextBeanId: number,
    prevScrollTop: number,
    enter: boolean,
  ) => number;
}
const { renderBeanCard, renderBeanList, openBeanSheet, closeBeanSheet, beanSheetRestoredScroll } =
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

  it('decides the scroll to restore after a sheet rebuild', () => {
    // Same bean -> keep the previous offset (an in-sheet tap must not jump up).
    expect(beanSheetRestoredScroll(1, 1, 240, false)).toBe(240);
    // Fresh open, a different bean, or nothing rendered yet -> start at the top.
    expect(beanSheetRestoredScroll(1, 1, 240, true)).toBe(0);
    expect(beanSheetRestoredScroll(1, 2, 240, false)).toBe(0);
    expect(beanSheetRestoredScroll(null, 1, 240, false)).toBe(0);
    // A missing/invalid offset is treated as the top, never NaN.
    expect(beanSheetRestoredScroll(1, 1, 0, false)).toBe(0);
    expect(beanSheetRestoredScroll(1, 1, Number.NaN, false)).toBe(0);
  });

  it('plays the slide-in only on open, not on a re-render', () => {
    const { elements } = setup();
    openBeanSheet(1);
    expect(sheetHtml(elements)).toContain('lib-sheet-enter');

    renderBeanList();
    expect(sheetHtml(elements)).not.toContain('lib-sheet-enter');
  });

  it('shows the Aromas block with the inline wheel and highlight chips', () => {
    const { elements } = setup();
    openBeanSheet(1);

    const html = sheetHtml(elements);
    expect(html).toContain('lib-sheet-aromas');
    expect(html).toContain(t('lib_sheet_aromas'));
    expect(html).toContain('lib-aroma-wheel');
    expect(html).toContain('lib-aroma-svg');
    expect(html).toContain('data-action="highlight-flavor"');
    // The plain chip row is the shelf card's now, not the sheet's.
    expect(html).not.toContain('lib-flavor-row');
  });

  it('omits the Aromas block when the bean has no flavours', () => {
    const { elements } = setup({ flavors: [] });
    openBeanSheet(1);

    const html = sheetHtml(elements);
    expect(html).not.toContain('lib-sheet-aromas');
    expect(html).not.toContain('data-action="open-flavor-wheel"');
  });

  it('no longer lists the flavour wheel in the sheet overflow menu', () => {
    const { elements } = setup();
    openBeanSheet(1);

    const html = sheetHtml(elements);
    // One inline wheel button in the aroma block, none in the ⋯ menu.
    expect(html.match(/data-action="open-flavor-wheel"/g)?.length).toBe(1);
  });

  it('shows the phone grab handle and keeps the labelled close button (#1374)', () => {
    const { elements } = setup();
    openBeanSheet(1);

    const html = sheetHtml(elements);
    expect(html).toContain('class="lib-sheet-grab"');
    expect(html).toContain('data-action="close-bean-sheet"');
    expect(html).toContain(`aria-label="${t('lib_sheet_close')}"`);
  });
});

describe('bean inventory reorder badge and unit (#1373)', () => {
  beforeEach(() => {
    S.shots = [];
    S.currentLang = 'en';
  });

  // remainingG < 100 flips the row into its low-stock shape, where the
  // reorder badge lives.
  function lowCard(over: Record<string, unknown>): string {
    setup({ remainingG: 40, ...over });
    const beans = S.coffeeLibrary.beans;
    return renderBeanCard(beans[0], beans);
  }

  it('links the reorder badge to an http(s) source URL', () => {
    const card = lowCard({ sourceUrl: 'https://shop.example/bean' });
    expect(card).toContain('<a class="lib-inv-reorder" href="https://shop.example/bean" target="_blank" rel="noopener noreferrer">');
    expect(card).not.toContain('<span class="lib-inv-reorder"');
  });

  it('keeps the plain badge when the bean has no source URL', () => {
    const card = lowCard({});
    expect(card).toContain('<span class="lib-inv-reorder">');
    expect(card).not.toContain('<a class="lib-inv-reorder"');
  });

  it('refuses a non-http(s) source URL', () => {
    const card = lowCard({ sourceUrl: 'javascript:alert(1)' });
    expect(card).toContain('<span class="lib-inv-reorder">');
    expect(card).not.toContain('<a class="lib-inv-reorder"');
  });

  it('shows the gram unit exactly once in the remaining and consumed figures', () => {
    const card = lowCard({});
    const remaining = card.match(/class="lib-inv-remaining[^"]*">([^<]*)</)?.[1] ?? '';
    const consumed = card.match(/class="lib-inv-consumed">([^<]*)</)?.[1] ?? '';
    expect(remaining).toBe(t('lib_inv_remaining', 40));
    expect(consumed).toBe(t('lib_inv_consumed', 0));
    expect((remaining.match(/ g/g) ?? []).length).toBe(1);
    expect((consumed.match(/ g/g) ?? []).length).toBe(1);
  });
});
