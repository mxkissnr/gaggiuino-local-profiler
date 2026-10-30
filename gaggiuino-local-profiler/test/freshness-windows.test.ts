import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_FRESHNESS_WINDOWS, freshnessState, freshnessWindows } from '../public-src/utils.js';

// #1835: the freshness bands used to be three copies of the same literals. They
// now come from the ui-prefs store's `bean_freshness` entry, with the old
// numbers as the default. utils.ts reads the store's localStorage cache (it
// cannot import ui-prefs.ts without a module cycle), so seeding that cache is
// how a configured set reaches it — same as test/ui-prefs.test.ts does.
const store = new Map<string, string>();
(globalThis as unknown as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

function setPrefs(value: unknown): void {
  store.set('glp_ui_prefs', JSON.stringify({ bean_freshness: value }));
}

beforeEach(() => {
  store.clear();
});

describe('freshnessWindows', () => {
  it('defaults to the windows the literals used to hard-code', () => {
    expect(freshnessWindows()).toEqual({ degasUntil: 4, peakFrom: 7, peakUntil: 21, fadingUntil: 35 });
    expect(DEFAULT_FRESHNESS_WINDOWS).toEqual(freshnessWindows());
  });

  it('reads a valid custom set', () => {
    setPrefs({ degasUntil: 2, peakFrom: 5, peakUntil: 14, fadingUntil: 28 });
    expect(freshnessWindows()).toEqual({ degasUntil: 2, peakFrom: 5, peakUntil: 14, fadingUntil: 28 });
  });

  it('falls back to the whole default set when a bound is not an ascending integer day count', () => {
    // Non-ascending.
    setPrefs({ degasUntil: 7, peakFrom: 4, peakUntil: 21, fadingUntil: 35 });
    expect(freshnessWindows()).toEqual(DEFAULT_FRESHNESS_WINDOWS);
    // Equal bounds leave no room for a band.
    setPrefs({ degasUntil: 4, peakFrom: 4, peakUntil: 21, fadingUntil: 35 });
    expect(freshnessWindows()).toEqual(DEFAULT_FRESHNESS_WINDOWS);
    // Negative.
    setPrefs({ degasUntil: -1, peakFrom: 7, peakUntil: 21, fadingUntil: 35 });
    expect(freshnessWindows()).toEqual(DEFAULT_FRESHNESS_WINDOWS);
    // Fractions are not whole days.
    setPrefs({ degasUntil: 4.5, peakFrom: 7, peakUntil: 21, fadingUntil: 35 });
    expect(freshnessWindows()).toEqual(DEFAULT_FRESHNESS_WINDOWS);
  });

  it('falls back to the whole default set for strings, partial and non-object values', () => {
    setPrefs({ degasUntil: '4', peakFrom: '7', peakUntil: '21', fadingUntil: '35' });
    expect(freshnessWindows()).toEqual(DEFAULT_FRESHNESS_WINDOWS);
    // A partial set must not shift only the bounds it happens to carry.
    setPrefs({ degasUntil: 2 });
    expect(freshnessWindows()).toEqual(DEFAULT_FRESHNESS_WINDOWS);
    setPrefs([4, 7, 21, 35]);
    expect(freshnessWindows()).toEqual(DEFAULT_FRESHNESS_WINDOWS);
    setPrefs(null);
    expect(freshnessWindows()).toEqual(DEFAULT_FRESHNESS_WINDOWS);
  });

  it('reads as defaults when the cached prefs are corrupt', () => {
    store.set('glp_ui_prefs', '{not json');
    expect(freshnessWindows()).toEqual(DEFAULT_FRESHNESS_WINDOWS);
  });
});

describe('freshnessState with configured windows', () => {
  it('bands a roast age by the configured set, not the built-in one', () => {
    setPrefs({ degasUntil: 2, peakFrom: 5, peakUntil: 14, fadingUntil: 28 });
    expect(freshnessState(1)).toBe('degassing');
    expect(freshnessState(2)).toBe('almost');
    expect(freshnessState(5)).toBe('peak');
    expect(freshnessState(14)).toBe('peak');
    expect(freshnessState(15)).toBe('fading');
    expect(freshnessState(28)).toBe('fading');
    expect(freshnessState(29)).toBe('old');
  });

  it('keeps the old bands when the stored set is unusable', () => {
    setPrefs({ degasUntil: 21, peakFrom: 7, peakUntil: 4, fadingUntil: 35 });
    expect(freshnessState(3)).toBe('degassing');
    expect(freshnessState(4)).toBe('almost');
    expect(freshnessState(7)).toBe('peak');
    expect(freshnessState(21)).toBe('peak');
    expect(freshnessState(22)).toBe('fading');
    expect(freshnessState(35)).toBe('fading');
    expect(freshnessState(36)).toBe('old');
  });
});
