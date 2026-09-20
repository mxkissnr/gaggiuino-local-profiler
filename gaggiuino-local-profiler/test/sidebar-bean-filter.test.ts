import { describe, it, expect, beforeEach } from 'vitest';

// sidebar.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/sidebar-month-toggle.test.js). vitest's
// node environment has no browser globals, so the fakes go through a loose
// view of globalThis rather than satisfying the full Storage/Navigator/
// Document shapes (the same bridge test/dev-banner.test.ts uses).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { filterShots, setBeanFilter, clearBeanFilter } = await import('../public-src/components/sidebar.js');

// filterShots() reads/writes DOM nodes by selector — stub only what it
// touches (shot-wrapper list, plus empty day-sep/month-body lists so those
// forEach()s are no-ops), same "fake minimal document" approach as
// test/sidebar-month-toggle.test.js/test/library-profile-editor.test.js.
//
// The fake nodes only need the fields filterShots() writes.
interface FakeWrapper {
  id: string;
  style: Record<string, string>;
}

interface FakeIndicator {
  style: Record<string, string>;
  innerHTML: string;
}

function fakeShotsDom(shotIds: number[]) {
  const wrappers: FakeWrapper[] = shotIds.map(id => ({ id: `wrapper-${id}`, style: { display: '' } }));
  const indicator: FakeIndicator = { style: { display: 'none' }, innerHTML: '' };
  g.document = {
    getElementById: (id: string) => (id === 'beanFilterIndicator' ? indicator : undefined),
    querySelectorAll: (sel: string) => {
      if (sel === '#shots .shot-wrapper') return wrappers;
      return [];
    },
  };
  return { wrappers, indicator };
}

describe('bean filter (shot history, #beanfilter)', () => {
  beforeEach(() => {
    S.beanFilter = null;
    S.currentFilter = '';
    S.coffeeLibrary = { beans: [{ id: 1, name: 'Ethiopia Yirgacheffe' }, { id: 2, name: 'Brazil Santos' }], grinders: [] };
  });

  it('shows only shots resolving to the filtered bean by beanId', () => {
    S.shots = [
      { id: 100, timestamp: 0, annotation: { beanId: 1, coffee: 'Ethiopia Yirgacheffe' } },
      { id: 101, timestamp: 0, annotation: { beanId: 2, coffee: 'Brazil Santos' } },
    ];
    const { wrappers } = fakeShotsDom([100, 101]);
    setBeanFilter(1, 'Ethiopia Yirgacheffe');
    expect(wrappers.find(w => w.id === 'wrapper-100')!.style.display).toBe('');
    expect(wrappers.find(w => w.id === 'wrapper-101')!.style.display).toBe('none');
  });

  it('falls back to raw name matching when the filtered bean no longer resolves in the library (deleted since the filter was set)', () => {
    S.shots = [
      { id: 200, timestamp: 0, annotation: { coffee: 'Discontinued Bean' } }, // no beanId, and no current library bean by this name
      { id: 201, timestamp: 0, annotation: { coffee: 'Brazil Santos' } },
    ];
    const { wrappers } = fakeShotsDom([200, 201]);
    setBeanFilter(99, 'Discontinued Bean');
    expect(wrappers.find(w => w.id === 'wrapper-200')!.style.display).toBe('');
    expect(wrappers.find(w => w.id === 'wrapper-201')!.style.display).toBe('none');
  });

  it('ANDs with the free-text search instead of replacing it', () => {
    S.shots = [
      { id: 300, timestamp: 0, profile: { name: 'V60 Filter' }, annotation: { beanId: 1, coffee: 'Ethiopia Yirgacheffe' } },
      { id: 301, timestamp: 0, profile: { name: 'Espresso Ristretto' }, annotation: { beanId: 1, coffee: 'Ethiopia Yirgacheffe' } },
    ];
    const { wrappers } = fakeShotsDom([300, 301]);
    setBeanFilter(1, 'Ethiopia Yirgacheffe');
    filterShots('ristretto');
    expect(wrappers.find(w => w.id === 'wrapper-300')!.style.display).toBe('none');
    expect(wrappers.find(w => w.id === 'wrapper-301')!.style.display).toBe('');
  });

  it('clearBeanFilter() restores every shot (subject only to any active text search)', () => {
    S.shots = [
      { id: 400, timestamp: 0, annotation: { beanId: 1, coffee: 'Ethiopia Yirgacheffe' } },
      { id: 401, timestamp: 0, annotation: { beanId: 2, coffee: 'Brazil Santos' } },
    ];
    const { wrappers, indicator } = fakeShotsDom([400, 401]);
    setBeanFilter(1, 'Ethiopia Yirgacheffe');
    expect(wrappers.find(w => w.id === 'wrapper-401')!.style.display).toBe('none');

    clearBeanFilter();
    expect(wrappers.find(w => w.id === 'wrapper-400')!.style.display).toBe('');
    expect(wrappers.find(w => w.id === 'wrapper-401')!.style.display).toBe('');
    expect(indicator.style.display).toBe('none');
  });

  it('shows the active-filter indicator with the bean name while set', () => {
    S.shots = [];
    const { indicator } = fakeShotsDom([]);
    setBeanFilter(2, 'Brazil Santos');
    expect(indicator.style.display).toBe('');
    expect(indicator.innerHTML).toContain('Brazil Santos');
  });
});
