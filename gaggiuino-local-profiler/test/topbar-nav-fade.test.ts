import { describe, it, expect } from 'vitest';

// mode.js's import chain touches state.js/i18n.js (localStorage/navigator at
// module load time) — stub the minimum browser globals so the module graph can
// be imported under vitest's node environment, same pattern as
// test/bottom-nav-config.test.ts.
const g = globalThis as unknown as Record<string, unknown>;
const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => _store.get(k) ?? null,
  setItem: (k: string, v: string) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };

const { topbarNavFadeState } = await import('../public-src/components/mode.js');

// #1516: the fade state is derived purely from the row's scroll metrics, so it
// is unit-testable without a DOM — the DOM side (mode.js) just feeds these
// three numbers in and toggles the returned flags onto .fade-left/.fade-right.
describe('topbarNavFadeState — desktop topbar edge fades (#1516)', () => {
  it('no fade on either edge when everything fits', () => {
    expect(topbarNavFadeState(0, 320, 320)).toEqual({ fadeLeft: false, fadeRight: false });
  });

  it('no fade when the overflow is within the 1px tolerance', () => {
    expect(topbarNavFadeState(0, 321, 320)).toEqual({ fadeLeft: false, fadeRight: false });
    expect(topbarNavFadeState(1, 321, 320)).toEqual({ fadeLeft: false, fadeRight: false });
  });

  it('only the right edge fades at the start of an overflowing row', () => {
    expect(topbarNavFadeState(0, 600, 300)).toEqual({ fadeLeft: false, fadeRight: true });
  });

  it('both edges fade in the middle', () => {
    expect(topbarNavFadeState(150, 600, 300)).toEqual({ fadeLeft: true, fadeRight: true });
  });

  it('only the left edge fades at the end', () => {
    expect(topbarNavFadeState(300, 600, 300)).toEqual({ fadeLeft: true, fadeRight: false });
  });

  it('drops the fade on an edge once it is within the 1px tolerance', () => {
    expect(topbarNavFadeState(1, 600, 300)).toEqual({ fadeLeft: false, fadeRight: true });
    expect(topbarNavFadeState(299, 600, 300)).toEqual({ fadeLeft: true, fadeRight: false });
  });

  it('treats a row whose content is shorter than the viewport as unscrollable', () => {
    expect(topbarNavFadeState(0, 200, 300)).toEqual({ fadeLeft: false, fadeRight: false });
  });
});
