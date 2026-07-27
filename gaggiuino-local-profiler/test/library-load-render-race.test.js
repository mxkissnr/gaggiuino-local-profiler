import { describe, it, expect, beforeEach } from 'vitest';

// library.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/sidebar-month-toggle.test.js and
// test/library-profile-editor.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { loadLibrary } = await import('../public-src/views/library.js');

// #526: loadLibrary()'s fetch is fired unawaited from main.js's init
// sequence and races switchMode('library') (mode.js), which renders the
// bean list straight off S.coffeeLibrary the moment the view opens. If that
// happens before this fetch resolves, the render sees the still-empty
// default and — before this fix — nothing re-rendered it afterwards, so a
// bean's flavor-wheel button (data-action="open-flavor-wheel") stayed
// invisible for the rest of the session even once the data had arrived.
// Stub only the DOM the load path touches, same "fake minimal document"
// approach the other frontend tests use instead of pulling in jsdom.
function fakeDocument() {
  const elements = {
    beanListUI:    { innerHTML: '' },
    grinderListUI: { innerHTML: '' },
  };
  return {
    elements,
    document: {
      getElementById: id => elements[id],
      querySelectorAll: () => [],
    },
  };
}

const bean = {
  id: 1, name: 'Yirgacheffe Chelelektu', roaster: 'Kaffee Braun',
  origin: 'ET', variety: 'Heirloom', process: 'Washed', roastType: 'filter',
  flavors: ['Jasmin', 'Zitrone', 'Bergamotte', 'Schwarzer Tee'],
};

describe('loadLibrary (#526 render race)', () => {
  beforeEach(() => {
    S.coffeeLibrary = { beans: [], grinders: [] };
    S.shots = [];
  });

  it('renders the flavor-wheel button once the fetch resolves, even though the bean list was already on screen (empty) beforehand', async () => {
    const { elements, document } = fakeDocument();
    globalThis.document = document;
    // Simulates switchMode('library') having already rendered the
    // still-empty default list before this fetch resolves.
    elements.beanListUI.innerHTML = '<div class="lib-empty">no beans yet</div>';

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ beans: [bean], grinders: [] }) });
    await loadLibrary();

    expect(elements.beanListUI.innerHTML).toContain('data-action="open-flavor-wheel"');
  });

  it('is a harmless no-op re-render when the Library view is not the current DOM (elements absent)', async () => {
    globalThis.document = { getElementById: () => undefined, querySelectorAll: () => [] };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ beans: [bean], grinders: [] }) });
    await expect(loadLibrary()).resolves.toBeUndefined();
    expect(S.coffeeLibrary.beans).toEqual([bean]);
  });
});
