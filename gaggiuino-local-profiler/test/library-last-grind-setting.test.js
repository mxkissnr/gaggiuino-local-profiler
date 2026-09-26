import { describe, it, expect, beforeEach } from 'vitest';

// library.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-load-render-race.test.js and
// test/library-roastdate-esc.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { renderBeanList } = await import('../public-src/views/library.js');

// #829: surface the last-used grind setting in the Library bean-list row.
// Deliberately sourced from S.shots' own annotations, not
// bean.knownGrindSettings — that array is only written by the Guided
// Dial-In wizard's explicit "Save known grind" button (dialin-wizard.js),
// so it stays empty for a bean that's only ever been through normal shot
// annotation, which is the common case. Per the repo's own precedent
// (#638/#641/#643/#648), a test that only proves the value got *saved*
// isn't enough — it must prove the row re-renders the *new* value after a
// setting change, not just that the initial value shows up once.
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

describe('renderBeanList last-used grind setting (#829)', () => {
  beforeEach(() => {
    S.coffeeLibrary = { beans: [{ id: 1, name: 'Yirgacheffe Chelelektu' }], grinders: [] };
  });

  it('shows the most recent shot\'s grind setting, then the new one after a grind-setting change', () => {
    const { elements, document } = fakeDocument();
    globalThis.document = document;

    S.shots = [
      { id: 1, timestamp: 1000, annotation: { beanId: 1, coffee: 'Yirgacheffe Chelelektu', grinder: 'Niche Zero', grindSetting: '4.2' } },
    ];

    renderBeanList();
    expect(elements.beanListUI.innerHTML).toContain('lib-last-grind-row');
    expect(elements.beanListUI.innerHTML).toContain('Niche Zero @ 4.2');
    expect(elements.beanListUI.innerHTML).not.toContain('Niche Zero @ 4.6');

    // A new, later shot changes the grind setting for the same bean.
    S.shots.push({ id: 2, timestamp: 2000, annotation: { beanId: 1, coffee: 'Yirgacheffe Chelelektu', grinder: 'Niche Zero', grindSetting: '4.6' } });

    renderBeanList();
    expect(elements.beanListUI.innerHTML).toContain('Niche Zero @ 4.6');
    expect(elements.beanListUI.innerHTML).not.toContain('Niche Zero @ 4.2');
  });

  it('picks the most recent shot by timestamp, not array order', () => {
    const { elements, document } = fakeDocument();
    globalThis.document = document;

    // Later shot appears earlier in the array — must still win on timestamp.
    S.shots = [
      { id: 2, timestamp: 5000, annotation: { beanId: 1, coffee: 'Yirgacheffe Chelelektu', grinder: 'DF64', grindSetting: '2.8' } },
      { id: 1, timestamp: 1000, annotation: { beanId: 1, coffee: 'Yirgacheffe Chelelektu', grinder: 'Niche Zero', grindSetting: '4.2' } },
    ];

    renderBeanList();
    expect(elements.beanListUI.innerHTML).toContain('DF64 @ 2.8');
    expect(elements.beanListUI.innerHTML).not.toContain('Niche Zero @ 4.2');
  });

  it('matches by beanId first, not falling back to a stale name match once beanId is present (#456 convention)', () => {
    const { elements, document } = fakeDocument();
    globalThis.document = document;

    S.shots = [
      // Same bean name, but a different beanId — must NOT count as a match.
      { id: 1, timestamp: 9000, annotation: { beanId: 99, coffee: 'Yirgacheffe Chelelektu', grinder: 'Wrong Grinder', grindSetting: '9.9' } },
      { id: 2, timestamp: 1000, annotation: { beanId: 1, coffee: 'Yirgacheffe Chelelektu', grinder: 'Niche Zero', grindSetting: '4.2' } },
    ];

    renderBeanList();
    expect(elements.beanListUI.innerHTML).toContain('Niche Zero @ 4.2');
    expect(elements.beanListUI.innerHTML).not.toContain('Wrong Grinder');
  });

  it('renders no last-grind row when the bean has no annotated shots with a grind setting yet', () => {
    const { elements, document } = fakeDocument();
    globalThis.document = document;

    S.shots = [];

    renderBeanList();
    expect(elements.beanListUI.innerHTML).not.toContain('lib-last-grind-row');
  });
});
