import { describe, it, expect, vi } from 'vitest';

// #2119: the bean comparison view and its picker, in the fake-DOM style of
// the other library tests (there is no jsdom in this repo). The detail sheet
// is replaced by a spy so the picker's markup can be read.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
// The comparison scores shots through window.calcShotScore like the analytics
// shelf; reduced motion keeps the bean sheet's animation out of the way.
g.window = {
  calcShotScore: (shot: { score?: number | null }) => shot.score ?? null,
  matchMedia: () => ({ matches: true }),
};

interface SheetOptions { title: string; body: string }
const sheet = vi.hoisted(() => ({
  open: vi.fn<(opts: SheetOptions) => void>(),
  close: vi.fn<() => void>(),
}));
vi.mock('../public-src/components/detail-sheet.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/components/detail-sheet.js')>()),
  openDetailSheet: sheet.open,
  closeDetailSheet: sheet.close,
}));

const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');
await import('../public-src/views/library.js');
const compare = await import('../public-src/views/library/bean-compare.js');

class FakeEl {
  id = '';
  className = '';
  innerHTML = '';
  hidden = false;
  scrollTop = 0;
  readonly attrs = new Map<string, string>();
  readonly classList = {
    add: (_c: string): void => {},
    remove: (_c: string): void => {},
    contains: (_c: string): boolean => false,
    toggle: (_c: string, _on?: boolean): boolean => false,
  };
  querySelector(_s: string): null { return null; }
  querySelectorAll(_s: string): FakeEl[] { return []; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  addEventListener(): void { /* no-op */ }
  removeEventListener(): void { /* no-op */ }
  focus(): void { /* no-op */ }
}

const ALPHA = { id: 1, name: 'Alpha Ethiopia', roaster: 'Roaster One', flavors: ['Blueberry', 'Jasmine'], bags: [] };
const BETA = { id: 2, name: 'Beta Kenya', roaster: 'Roaster Two', flavors: ['Blaubeere', 'Chocolate'], bags: [] };
const GAMMA = { id: 3, name: 'Gamma Brazil', bags: [] };

function scored(bean: number, score: number, id: number): Record<string, unknown> {
  return { id, timestamp: id, score, duration: 280, weight: 360, annotation: { beanId: bean, grinder: 'Niche', grindSetting: 12, dose: 18 } };
}

let view = new FakeEl();
let host = new FakeEl();
let elements: Record<string, FakeEl> = {};

function setup(beans: Record<string, unknown>[], shots: Record<string, unknown>[] = []): void {
  view = new FakeEl();
  host = new FakeEl();
  elements = { 'library-view': view, libCompare: host, beanListUI: new FakeEl() };
  g.document = {
    getElementById: (id: string) => elements[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => new FakeEl(),
    body: {
      classList: { add: () => {}, remove: () => {} },
      appendChild: (el: FakeEl) => { elements[el.id] = el; },
    },
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => true,
  };
  S.currentLang = 'en';
  S.coffeeLibrary = { beans, grinders: [] };
  S.shots = shots as typeof S.shots;
  compare.closeBeanCompare();
  host.hidden = true;
  sheet.open.mockClear();
}

function lastSheet(): SheetOptions {
  const call = sheet.open.mock.calls.at(-1);
  if (!call) throw new Error('openDetailSheet was not called');
  return call[0];
}

function openPair(): void {
  compare.startBeanCompare(1);
  compare.chooseBeanCompare(2);
}

describe('bean comparison view (#2119)', () => {
  it('offers Compare in the sheet menu only when there is a second bean', () => {
    setup([ALPHA, BETA]);
    const item = compare.beanCompareMenuItem(1);
    expect(item).toContain('data-action="compare-bean"');
    expect(item).toContain(t('bean_cmp_menu'));
    setup([ALPHA]);
    expect(compare.beanCompareMenuItem(1)).toBe('');
  });

  it('opens the picker with every other bean', () => {
    setup([ALPHA, BETA, GAMMA]);
    compare.startBeanCompare(1);
    const opts = lastSheet();
    expect(opts.title).toBe(t('bean_cmp_pick_title'));
    expect(opts.body).toContain('data-action="compare-pick-bean" data-id="2"');
    expect(opts.body).toContain('data-action="compare-pick-bean" data-id="3"');
    expect(opts.body).not.toContain('data-action="compare-pick-bean" data-id="1"');
  });

  it('shows both beans, the verdict and the four sections', () => {
    setup([ALPHA, BETA], [scored(1, 90, 1), scored(1, 90, 2), scored(1, 90, 3)]);
    openPair();
    expect(host.hidden).toBe(false);
    expect(view.hasAttribute('data-compare')).toBe(true);
    const html = host.innerHTML;
    expect(html).toContain('>Alpha Ethiopia<');
    expect(html).toContain('>Beta Kenya<');
    for (const action of ['compare-back', 'compare-swap', 'compare-pick-other']) {
      expect(html).toContain(`data-action="${action}"`);
    }
    for (const key of ['bean_cmp_section_results', 'bean_cmp_section_dialin', 'lib_sheet_aromas', 'bean_cmp_section_bean']) {
      expect(html).toContain(t(key));
    }
    // Beta has no shots: no winner, and it says so once per section.
    expect(html).toContain(t('bean_cmp_verdict_few', 'Beta Kenya', 3));
    expect(html).toContain(t('bean_cmp_no_shots'));
    // Blueberry and Blaubeere are the same aroma.
    expect(html).toContain(t('bean_cmp_shared_aromas', 1));
    expect(html).toContain('class="chip--input is-shared"');
  });

  it('names the winner with its reason and marks the better values', () => {
    setup([ALPHA, BETA], [
      scored(1, 90, 1), scored(1, 90, 2), scored(1, 90, 3),
      scored(2, 70, 4), scored(2, 70, 5), scored(2, 70, 6),
    ]);
    openPair();
    const html = host.innerHTML;
    expect(html).toContain(t('bean_cmp_verdict_winner', 'Alpha Ethiopia', t('bean_cmp_reason_dialin_same_grinder')));
    expect(html).toContain('>20<');
    expect(html).toContain('class="lib-compare-dot"');
  });

  it('swaps sides without leaving the page', () => {
    setup([ALPHA, BETA]);
    openPair();
    expect(host.innerHTML.indexOf('>Alpha Ethiopia<')).toBeLessThan(host.innerHTML.indexOf('>Beta Kenya<'));
    compare.swapBeanCompare();
    expect(host.hidden).toBe(false);
    expect(host.innerHTML.indexOf('>Beta Kenya<')).toBeLessThan(host.innerHTML.indexOf('>Alpha Ethiopia<'));
  });

  it('picks another bean for the right side and keeps the left one', () => {
    setup([ALPHA, BETA, GAMMA]);
    openPair();
    sheet.open.mockClear();
    compare.pickOtherBeanCompare();
    const body = lastSheet().body;
    expect(body).toContain('data-action="compare-pick-bean" data-id="3"');
    expect(body).not.toContain('data-action="compare-pick-bean" data-id="1"');
    expect(body).not.toContain('data-action="compare-pick-bean" data-id="2"');
    compare.chooseBeanCompare(3);
    expect(host.hidden).toBe(false);
    expect(host.innerHTML).toContain('>Alpha Ethiopia<');
    expect(host.innerHTML).toContain('>Gamma Brazil<');
    expect(host.innerHTML).not.toContain('Beta Kenya');
  });

  it('Back closes the page and reopens the starting bean\'s sheet', () => {
    setup([ALPHA, BETA]);
    openPair();
    compare.swapBeanCompare();
    compare.backFromBeanCompare();
    expect(compare.beanCompareOpen()).toBe(false);
    expect(host.hidden).toBe(true);
    expect(view.hasAttribute('data-compare')).toBe(false);
    expect(elements.beanSheet?.innerHTML).toContain('Alpha Ethiopia');
  });

  it('closes itself when one of its beans leaves the library', () => {
    setup([ALPHA, BETA]);
    openPair();
    S.coffeeLibrary = { beans: [ALPHA], grinders: [] };
    compare.refreshBeanCompare();
    expect(compare.beanCompareOpen()).toBe(false);
    expect(host.hidden).toBe(true);
  });
});
