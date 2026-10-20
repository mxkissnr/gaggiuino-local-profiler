import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import de from '../public-src/i18n/de.js';
import en from '../public-src/i18n/en.js';
import es from '../public-src/i18n/es.js';
import fr from '../public-src/i18n/fr.js';
import itLang from '../public-src/i18n/it.js';
import nl from '../public-src/i18n/nl.js';

// views/shots/utils.ts and views/library/bags.ts pull in state/index.ts, which
// needs localStorage/navigator at module load (same stubbing approach as
// shots-bean-age-iso-date.test.ts).
type RenderBagCard = (typeof import('../public-src/views/library/bags.js'))['renderBagCard'];
type BagEntry = Parameters<RenderBagCard>[1];
type BeanRow = Parameters<RenderBagCard>[0];
type ShotBeanAge = (typeof import('../public-src/views/shots/utils.js'))['shotBeanAge'];
type LibraryState = { coffeeLibrary: { beans: Bean[]; recipes: unknown[]; grinders: unknown[] } | null; _bagFullEditId: number | null };

let renderBagCard: RenderBagCard;
let shotBeanAge: ShotBeanAge;
let S: LibraryState;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ renderBagCard } = await import('../public-src/views/library/bags.js'));
  ({ shotBeanAge } = await import('../public-src/views/shots/utils.js'));
  ({ S } = (await import('../public-src/state/index.js')) as unknown as { S: LibraryState });
});

interface Bag { id?: number; openedAt?: number; roastDate?: string }
interface Bean { id: number; name: string; roastDate?: string; bags?: Bag[] }

function library(): LibraryState {
  return S;
}

// Both the shot and the bag roast dates are local midnights, so the day count
// does not depend on the test runner's timezone.
const SHOT_SEC = new Date(2024, 4, 31).getTime() / 1000;

function setBean(roastDate: string, bags: Bag[] = []): void {
  library().coffeeLibrary = { beans: [{ id: 1, name: 'Test Bean', roastDate, bags }], recipes: [], grinders: [] };
}

function bagCard(consumed: number): string {
  const bean = {
    id: 1,
    name: 'Test Bean',
    bags: [{ id: 7, roastDate: '2024-05-01', stock_g: 250, consumedG: consumed, remainingG: 250 - consumed, current: true }],
  } as unknown as BeanRow;
  const entry = { bg: bean.bags![0], consumed, stockG: 250, remaining: 250 - consumed } as unknown as BagEntry;
  return renderBagCard(bean, entry, 'current', [bean], false);
}

function inputTag(htmlText: string, id: string): string {
  const match = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(htmlText);
  expect(match, `input ${id} not rendered`).not.toBeNull();
  return match![0];
}

describe('bag edit lock after the first dose (#1788)', () => {
  beforeEach(() => {
    library()._bagFullEditId = null;
  });

  it('keeps the edit pencil on a current bag that already has doses', () => {
    expect(bagCard(40)).toContain('data-action="open-edit-bag"');
  });

  it('locks only the original-weight input once consumed, not the roast date', () => {
    library()._bagFullEditId = 7;
    const out = bagCard(40);
    expect(inputTag(out, 'editBagStock7')).toContain('disabled');
    expect(inputTag(out, 'editBagRoastDate7')).not.toContain('disabled');
    expect(inputTag(out, 'editBagPrice7')).not.toContain('disabled');
    expect(inputTag(out, 'editBagBatchNumber7')).not.toContain('disabled');
  });

  it('leaves the original-weight input editable before any dose', () => {
    library()._bagFullEditId = 7;
    expect(inputTag(bagCard(0), 'editBagStock7')).not.toContain('disabled');
  });
});

describe('freshness badge follows the library (#1788)', () => {
  beforeEach(() => {
    library().coffeeLibrary = { beans: [], recipes: [], grinders: [] };
  });

  it('recomputes the age after the bag roast date is corrected', () => {
    const ann = { beanId: 1, coffee: 'Test Bean', beanAgeDays: 77 };
    setBean('2020-01-01', [{ id: 1, openedAt: 1, roastDate: '2024-05-01' }]);
    expect(shotBeanAge(ann, SHOT_SEC)).toEqual({ days: 30, atShot: true });

    setBean('2020-01-01', [{ id: 1, openedAt: 1, roastDate: '2024-05-10' }]);
    expect(shotBeanAge(ann, SHOT_SEC)).toEqual({ days: 21, atShot: true });
  });

  it('falls back to the stored age when the bean has left the library', () => {
    expect(shotBeanAge({ beanId: 1, coffee: 'Gone Bean', beanAgeDays: 77 }, SHOT_SEC)).toEqual({ days: 77, atShot: true });
  });

  it('uses the relative-to-now read only when neither source is available', () => {
    const ann = { coffee: 'Unknown', roastDate: '2024-05-01' };
    const nowMs = SHOT_SEC * 1000 + 10 * 86400000;
    expect(shotBeanAge(ann, SHOT_SEC, { nowMs })).toEqual({ days: 40, atShot: false });
    expect(shotBeanAge(ann, SHOT_SEC, { nowMs, relativeToNow: false })).toBeNull();
  });
});

describe('bean age translations (#1788)', () => {
  const langs = { de, en, es, fr, it: itLang, nl };

  it('renders the German at-shot badge without the English abbreviation', () => {
    const badge = de.bean_age_badge as (d: number) => string;
    expect(badge(33)).toBe('33 Tage beim Shot');
  });

  it('has a freshness_badge formatter in every language', () => {
    for (const [lang, dict] of Object.entries(langs)) {
      const badge = dict.freshness_badge as ((d: number) => string) | undefined;
      expect(typeof badge, `${lang} freshness_badge`).toBe('function');
      expect(badge!(3)).toBeTypeOf('string');
    }
  });
});
