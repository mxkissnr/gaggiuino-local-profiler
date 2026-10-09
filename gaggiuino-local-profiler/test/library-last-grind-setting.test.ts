import { describe, it, expect, beforeEach } from 'vitest';

// library.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-load-render-race.test.js and
// test/library-roastdate-esc.test.js).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
interface LibraryModule {
  renderBeanCard: (b: unknown, beans: unknown[]) => string;
}
const { renderBeanCard } = (await import('../public-src/views/library.js')) as unknown as LibraryModule;

// #829: surface the last-used grind setting in the Library bean-list row.
// Deliberately sourced from S.shots' own annotations, not
// bean.knownGrindSettings — that array is only written by the Guided
// Dial-In wizard's explicit "Save known grind" button (dialin-wizard.js),
// so it stays empty for a bean that's only ever been through normal shot
// annotation, which is the common case. Per the repo's own precedent
// (#638/#641/#643/#648), a test that only proves the value got *saved*
// isn't enough — it must prove the row re-renders the *new* value after a
// setting change, not just that the initial value shows up once.
interface FakeDocument {
  elements: Record<string, { innerHTML: string }>;
  document: {
    getElementById: (id: string) => { innerHTML: string } | undefined;
    querySelectorAll: () => never[];
  };
}

// `elements` is a plain Record, so elements.beanListUI is
// `{ innerHTML } | undefined` under noUncheckedIndexedAccess; this narrows it
// back by throwing on a missing element rather than asserting it exists.
function uiHtml(elements: Record<string, { innerHTML: string }>): string {
  const node = elements.beanListUI;
  if (node === undefined) throw new Error('beanListUI element missing');
  return node.innerHTML;
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

// The full bean card now lives in the detail sheet; render it directly so
// these #829 assertions keep inspecting its markup.
function renderCard(elements: Record<string, { innerHTML: string }>): void {
  const node = elements.beanListUI;
  if (node === undefined) throw new Error('beanListUI element missing');
  node.innerHTML = renderBeanCard(S.coffeeLibrary.beans[0], S.coffeeLibrary.beans);
}

describe('renderBeanList last-used grind setting (#829)', () => {
  let beanId = 0;
  beforeEach(() => {
    beanId += 1;
    S.coffeeLibrary = { beans: [{ id: beanId, name: 'Yirgacheffe Chelelektu', bags: [{ id: beanId, stock_g: 250, consumedG: 100, remainingG: 150, current: true }] }], grinders: [] };
  });

  it('shows the most recent shot\'s grind setting, then the new one after a grind-setting change', () => {
    const { elements, document } = fakeDocument();
    g.document = document;

    S.shots = [
      { id: 1, timestamp: 1000, annotation: { beanId: beanId, coffee: 'Yirgacheffe Chelelektu', grinder: 'Niche Zero', grindSetting: '4.2' } },
    ];

    renderCard(elements);
    expect(uiHtml(elements)).toContain('lib-last-grind-row');
    expect(uiHtml(elements)).toContain('Niche Zero @ 4.2');
    expect(uiHtml(elements)).not.toContain('Niche Zero @ 4.6');

    // A new, later shot changes the grind setting for the same bean.
    S.shots.push({ id: 2, timestamp: 2000, annotation: { beanId: beanId, coffee: 'Yirgacheffe Chelelektu', grinder: 'Niche Zero', grindSetting: '4.6' } });

    renderCard(elements);
    expect(uiHtml(elements)).toContain('Niche Zero @ 4.6');
    expect(uiHtml(elements)).not.toContain('Niche Zero @ 4.2');
  });

  it('picks the most recent shot by timestamp, not array order', () => {
    const { elements, document } = fakeDocument();
    g.document = document;

    // Later shot appears earlier in the array — must still win on timestamp.
    S.shots = [
      { id: 2, timestamp: 5000, annotation: { beanId: beanId, coffee: 'Yirgacheffe Chelelektu', grinder: 'DF64', grindSetting: '2.8' } },
      { id: 1, timestamp: 1000, annotation: { beanId: beanId, coffee: 'Yirgacheffe Chelelektu', grinder: 'Niche Zero', grindSetting: '4.2' } },
    ];

    renderCard(elements);
    expect(uiHtml(elements)).toContain('DF64 @ 2.8');
    expect(uiHtml(elements)).not.toContain('Niche Zero @ 4.2');
  });

  it('matches by beanId first, not falling back to a stale name match once beanId is present (#456 convention)', () => {
    const { elements, document } = fakeDocument();
    g.document = document;

    S.shots = [
      // Same bean name, but a different beanId — must NOT count as a match.
      { id: 1, timestamp: 9000, annotation: { beanId: beanId + 100, coffee: 'Yirgacheffe Chelelektu', grinder: 'Wrong Grinder', grindSetting: '9.9' } },
      { id: 2, timestamp: 1000, annotation: { beanId: beanId, coffee: 'Yirgacheffe Chelelektu', grinder: 'Niche Zero', grindSetting: '4.2' } },
    ];

    renderCard(elements);
    expect(uiHtml(elements)).toContain('Niche Zero @ 4.2');
    expect(uiHtml(elements)).not.toContain('Wrong Grinder');
  });

  it('renders no last-grind row when the bean has no annotated shots with a grind setting yet', () => {
    const { elements, document } = fakeDocument();
    g.document = document;

    S.shots = [];

    renderCard(elements);
    expect(uiHtml(elements)).not.toContain('lib-last-grind-row');
  });
});
