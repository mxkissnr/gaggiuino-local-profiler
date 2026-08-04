import { describe, it, expect, beforeEach } from 'vitest';

// library.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-load-render-race.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { renderBeanList } = await import('../public-src/views/library.js');

// #648: bg.roastDate was rendered into the bag-history block's innerHTML
// without esc(), unlike every sibling field there (batchNumber etc.). Not
// reachable via the UI (the input is type="date", browser-constrained), but
// reachable via a crafted direct API call or a compromised import/backup-
// restore path — defense-in-depth fix, same esc() wrap batchNumber already gets.
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

describe('renderBeanList (#648 bag-history roastDate escaping)', () => {
  beforeEach(() => {
    S.shots = [];
  });

  it('escapes a malicious bag roastDate instead of injecting it raw into innerHTML', () => {
    const { elements, document } = fakeDocument();
    globalThis.document = document;

    S.coffeeLibrary = {
      beans: [{
        id: 1,
        name: 'Test Bean',
        bags: [
          { id: 1, roastDate: '2026-01-01', stock_g: 250 },
          { id: 2, roastDate: '<img src=x onerror=alert(1)>', stock_g: 250 },
        ],
      }],
      grinders: [],
    };

    renderBeanList();

    expect(elements.beanListUI.innerHTML).not.toContain('<img src=x onerror=alert(1)>');
    expect(elements.beanListUI.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
