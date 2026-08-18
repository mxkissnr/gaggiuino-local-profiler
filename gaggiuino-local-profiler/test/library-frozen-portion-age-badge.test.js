import { describe, it, expect, beforeEach } from 'vitest';

// library.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-roastdate-esc.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { renderBeanList } = await import('../public-src/views/library.js');

function fakeDocument() {
  const elements = { beanListUI: { innerHTML: '' } };
  return {
    elements,
    document: {
      getElementById: id => elements[id],
      querySelectorAll: () => [],
    },
  };
}

const DAY = 86400000;

// #856: a frozen portion's own paused age (frozenPortionAgeDays) was only
// ever surfaced as a tooltip — nothing on screen distinguished it from a
// portion that kept aging at the bag's normal rate. Now it also renders as
// a visible badge, reusing the bag-level fresh-badge classes/color tiers.
describe('renderBeanList (#856 frozen-portion age badge)', () => {
  beforeEach(() => {
    S.shots = [];
  });

  it('renders a fresh-badge with the paused age for a still-frozen portion', () => {
    const { elements, document } = fakeDocument();
    globalThis.document = document;

    const now = Date.now();
    S.coffeeLibrary = {
      beans: [{
        id: 1,
        name: 'Test Bean',
        bags: [{
          id: 1,
          roastDate: new Date(now - 10 * DAY).toISOString().slice(0, 10),
          stock_g: 250,
          frozenPortions: [
            { id: 1, frozenAt: now - 5 * DAY, portionCount: 4, remainingCount: 4, portionWeight_g: 18 },
          ],
        }],
      }],
      grinders: [],
    };

    renderBeanList();

    const html = elements.beanListUI.innerHTML;
    expect(html).toContain('lib-frozen-badge');
    // the portion's own paused age (5d, held flat since freezing) rendered
    // as its own lib-fresh-badge, distinct from the bag-level badge
    expect(html).toMatch(/lib-fresh-badge fresh-\w+"[^>]*>5d<\/span>/);
  });

  it('renders the age badge for an already-thawed portion too', () => {
    const { elements, document } = fakeDocument();
    globalThis.document = document;

    const now = Date.now();
    S.coffeeLibrary = {
      beans: [{
        id: 1,
        name: 'Test Bean',
        bags: [{
          id: 1,
          roastDate: new Date(now - 20 * DAY).toISOString().slice(0, 10),
          stock_g: 250,
          frozenPortions: [
            { id: 2, frozenAt: now - 15 * DAY, thawedAt: now - 2 * DAY, portionCount: 2, remainingCount: 0, portionWeight_g: 18 },
          ],
        }],
      }],
      grinders: [],
    };

    renderBeanList();

    const html = elements.beanListUI.innerHTML;
    expect(html).toContain('lib-frozen-badge thawed');
    // age at freeze (5d) + 2 days since thaw = 7d
    expect(html).toMatch(/lib-fresh-badge fresh-\w+"[^>]*>7d<\/span>/);
  });
});
