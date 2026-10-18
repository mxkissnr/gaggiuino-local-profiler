import { describe, it, expect, beforeEach } from 'vitest';

// library.ts's import chain touches state/index.ts/i18n.ts, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-roastdate-esc.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
interface LibraryModule {
  renderBeanCard: (b: unknown, beans: unknown[]) => string;
  togglePastBags: (beanId: number) => void;
}
const { renderBeanCard, togglePastBags } = (await import('../public-src/views/library.js')) as unknown as LibraryModule;

// #1122: the bean card renders a "Past bags" chip (data-action=
// "toggle-past-bags") but the click dispatcher in main.ts had no case for
// it, so the section could never open. togglePastBags itself flips the
// per-bean expansion state and re-renders; this pins that state transition
// (the open/closed state lives in library.ts, which is what main.ts's new
// case calls into).
interface FakeDocument {
  elements: { beanListUI: { innerHTML: string } };
  document: {
    getElementById: (id: string) => { innerHTML: string } | undefined;
    querySelectorAll: () => never[];
  };
}

function fakeDocument(): FakeDocument {
  const elements = { beanListUI: { innerHTML: '' } };
  const registry = new Map<string, { innerHTML: string }>([['beanListUI', elements.beanListUI]]);
  return {
    elements,
    document: {
      getElementById: (id: string) => registry.get(id),
      querySelectorAll: () => [],
    },
  };
}

describe('togglePastBags (#1122 bag queue)', () => {
  beforeEach(() => {
    S.shots = [];
  });

  it('renders past bags only after the toggle is flipped, and hides them again on the next flip', () => {
    const { elements, document } = fakeDocument();
    g.document = document;

    S.coffeeLibrary = {
      beans: [{
        id: 1,
        name: 'Test Bean',
        bags: [
          // consumedG/remainingG/current are backend-computed (SimulateBagQueue)
          // and attached to every tracked bag on load.
          { id: 1, roastDate: '2026-01-01', stock_g: 250, consumedG: 100, remainingG: 150, current: true },
          { id: 2, roastDate: '2019-01-01', stock_g: 250, consumedG: 250, remainingG: 0 },
        ],
      }],
      grinders: [],
    };

    // The card now renders inside the detail sheet; drive it directly so the
    // toggle's re-render can be observed.
    const beans = S.coffeeLibrary.beans;
    const renderCard = (): void => {
      elements.beanListUI.innerHTML = renderBeanCard(beans[0], beans);
    };

    renderCard();
    expect(elements.beanListUI.innerHTML).toContain('data-action="toggle-past-bags"');
    // #1619: the chip is a real button, so Enter/Space work natively.
    expect(elements.beanListUI.innerHTML).toContain('<button type="button" class="lib-bag-history-toggle');
    expect(elements.beanListUI.innerHTML).toContain('aria-expanded="false"');
    expect(elements.beanListUI.innerHTML).not.toContain('2019-01-01');

    togglePastBags(1);
    renderCard();
    expect(elements.beanListUI.innerHTML).toContain('2019-01-01');
    expect(elements.beanListUI.innerHTML).toContain('aria-expanded="true"');

    togglePastBags(1);
    renderCard();
    expect(elements.beanListUI.innerHTML).not.toContain('2019-01-01');
  });
});
