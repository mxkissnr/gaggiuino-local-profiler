import { describe, it, expect, beforeEach } from 'vitest';

// library.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-roastdate-esc.test.js).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
interface LibraryModule {
  renderBeanList: () => void;
  togglePastBags: (beanId: number) => void;
}
const { renderBeanList, togglePastBags } = (await import('../public-src/views/library.js')) as unknown as LibraryModule;

// #1122: the bean card renders a "Past bags" chip (data-action=
// "toggle-past-bags") but the click dispatcher in main.ts had no case for
// it, so the section could never open. togglePastBags itself flips the
// per-bean expansion state and re-renders; this pins that state transition
// (the open/closed state lives in library.js, which is what main.ts's new
// case calls into).
interface FakeDocument {
  elements: Record<string, { innerHTML: string }>;
  document: {
    getElementById: (id: string) => { innerHTML: string } | undefined;
    querySelectorAll: () => never[];
  };
}

function fakeDocument(): FakeDocument {
  const elements: Record<string, { innerHTML: string }> = { beanListUI: { innerHTML: '' } };
  return {
    elements,
    document: {
      getElementById: (id: string) => elements[id],
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
          { id: 1, roastDate: '2026-01-01', stock_g: 250, consumedG: 0, remainingG: 250, current: true },
          { id: 2, roastDate: '2019-01-01', stock_g: 250, consumedG: 250, remainingG: 0 },
        ],
      }],
      grinders: [],
    };

    renderBeanList();
    expect(elements.beanListUI.innerHTML).toContain('data-action="toggle-past-bags"');
    expect(elements.beanListUI.innerHTML).not.toContain('2019-01-01');

    togglePastBags(1);
    expect(elements.beanListUI.innerHTML).toContain('2019-01-01');

    togglePastBags(1);
    expect(elements.beanListUI.innerHTML).not.toContain('2019-01-01');
  });
});
