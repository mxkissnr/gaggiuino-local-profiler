import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_FRESHNESS_WINDOWS,
  DEFAULT_LEVEL_FRESHNESS_WINDOWS,
  LEVEL_FRESHNESS_PREF,
  ROAST_LEVELS,
  freshnessSourceLabelKey,
  freshnessState,
  freshnessWindows,
  freshnessOverrideFrom,
  normalizeRoastLevel,
  parseBestForUseDays,
  resolveFreshness,
  resolveFreshnessWindows,
} from '../public-src/utils.js';

// #1977: roast-level-aware freshness. The resolution order the badge, tracker
// and bean cards share is: per-bean override → roast level → global set. These
// tests pin every layer, including that an override only replaces the peak band
// and that every level's suggestion rests longer than the global default.
const store = new Map<string, string>();
(globalThis as unknown as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

function setPrefs(value: Record<string, unknown>): void {
  store.set('glp_ui_prefs', JSON.stringify(value));
}

beforeEach(() => {
  store.clear();
});

describe('roast-level defaults', () => {
  it('offers exactly the five supported levels', () => {
    expect(ROAST_LEVELS).toEqual(['light', 'medium-light', 'medium', 'medium-dark', 'dark']);
  });

  it('gives every level more rest than the global default', () => {
    // The level suggestions are deliberately slower than the 4 / 7 / 21 / 35
    // global default: even a dark roast opens its peak window after a week.
    for (const level of ROAST_LEVELS) {
      expect(DEFAULT_LEVEL_FRESHNESS_WINDOWS[level].peakFrom, level)
        .toBeGreaterThanOrEqual(DEFAULT_FRESHNESS_WINDOWS.peakFrom + 1);
    }
    expect(DEFAULT_LEVEL_FRESHNESS_WINDOWS.dark.peakFrom).toBeGreaterThan(4);
    expect(DEFAULT_LEVEL_FRESHNESS_WINDOWS.medium).not.toEqual(DEFAULT_FRESHNESS_WINDOWS);
  });

  it('gives each level its own ordered window', () => {
    for (const level of ROAST_LEVELS) {
      const w = DEFAULT_LEVEL_FRESHNESS_WINDOWS[level];
      expect(w.degasUntil, level).toBeLessThan(w.peakFrom);
      expect(w.peakFrom, level).toBeLessThan(w.peakUntil);
      expect(w.peakUntil, level).toBeLessThan(w.fadingUntil);
    }
  });

  it('maps every level to a distinct flat ui-prefs key', () => {
    const keys = ROAST_LEVELS.map(level => LEVEL_FRESHNESS_PREF[level]);
    expect(new Set(keys).size).toBe(ROAST_LEVELS.length);
    expect(keys).toContain('bean_freshness_medium_light');
    expect(keys).toContain('bean_freshness_medium_dark');
  });
});

describe('freshnessWindows(level)', () => {
  it('returns the built-in suggestion for a level with no saved set', () => {
    expect(freshnessWindows('light')).toEqual(DEFAULT_LEVEL_FRESHNESS_WINDOWS.light);
    expect(freshnessWindows('dark')).toEqual(DEFAULT_LEVEL_FRESHNESS_WINDOWS.dark);
  });

  it('returns the global set when no level (or an unknown one) is given, so existing beans do not change', () => {
    setPrefs({ bean_freshness: { degasUntil: 2, peakFrom: 5, peakUntil: 14, fadingUntil: 28 } });
    expect(freshnessWindows()).toEqual({ degasUntil: 2, peakFrom: 5, peakUntil: 14, fadingUntil: 28 });
    expect(freshnessWindows('')).toEqual({ degasUntil: 2, peakFrom: 5, peakUntil: 14, fadingUntil: 28 });
    expect(freshnessWindows('burnt')).toEqual({ degasUntil: 2, peakFrom: 5, peakUntil: 14, fadingUntil: 28 });
  });

  it('uses a saved per-level set without touching the other levels', () => {
    setPrefs({
      bean_freshness_light: { degasUntil: 6, peakFrom: 12, peakUntil: 30, fadingUntil: 50 },
      bean_freshness_dark: { degasUntil: 3, peakFrom: 6, peakUntil: 12, fadingUntil: 20 },
    });
    expect(freshnessWindows('light')).toEqual({ degasUntil: 6, peakFrom: 12, peakUntil: 30, fadingUntil: 50 });
    expect(freshnessWindows('dark')).toEqual({ degasUntil: 3, peakFrom: 6, peakUntil: 12, fadingUntil: 20 });
    expect(freshnessWindows('medium')).toEqual(DEFAULT_LEVEL_FRESHNESS_WINDOWS.medium);
  });

  it('ignores a malformed saved per-level set and keeps the suggestion', () => {
    setPrefs({ bean_freshness_light: { degasUntil: 10, peakFrom: 5, peakUntil: 30, fadingUntil: 50 } });
    expect(freshnessWindows('light')).toEqual(DEFAULT_LEVEL_FRESHNESS_WINDOWS.light);
  });
});

describe('resolveFreshnessWindows', () => {
  it('reports the global source for a bean without a level or override', () => {
    const resolved = resolveFreshnessWindows();
    expect(resolved).toEqual({ windows: DEFAULT_FRESHNESS_WINDOWS, source: 'global', level: null });
    expect(freshnessSourceLabelKey(resolved)).toBeNull();
  });

  it('reports the level source and names the level', () => {
    const resolved = resolveFreshnessWindows('medium-light');
    expect(resolved.source).toBe('level');
    expect(resolved.level).toBe('medium-light');
    expect(resolved.windows).toEqual(DEFAULT_LEVEL_FRESHNESS_WINDOWS['medium-light']);
    expect(freshnessSourceLabelKey(resolved)).toBe('roast_level_medium_light');
  });

  it('lets a valid per-bean override win and reports the custom source', () => {
    const resolved = resolveFreshnessWindows('dark', { from: 8, until: 12 });
    expect(resolved.source).toBe('custom');
    expect(resolved.level).toBe('dark');
    expect(resolved.windows.peakFrom).toBe(8);
    expect(resolved.windows.peakUntil).toBe(12);
    expect(freshnessSourceLabelKey(resolved)).toBe('freshness_source_custom');
  });

  it('keeps the level\'s degassing/fading bounds around an override, clamped to stay ordered', () => {
    // dark degasses until 5 and fades until 30; the override peak is 8–12.
    const resolved = resolveFreshnessWindows('dark', { from: 8, until: 12 });
    expect(resolved.windows.degasUntil).toBe(5);
    expect(resolved.windows.fadingUntil).toBe(30);

    // A peak starting at day 1 collapses degassing to 0; one ending past the
    // level's fading bound pushes fading out so the set stays ascending.
    const early = resolveFreshnessWindows('dark', { from: 1, until: 30 });
    expect(early.windows.degasUntil).toBe(0);
    expect(early.windows.fadingUntil).toBe(31);
  });

  it('ignores an invalid override instead of half-applying it', () => {
    for (const bad of [{ from: 10, until: 5 }, { from: 0, until: 5 }, { from: 5, until: 400 }]) {
      const resolved = resolveFreshnessWindows('light', bad);
      expect(resolved.source).toBe('level');
      expect(resolved.windows).toEqual(DEFAULT_LEVEL_FRESHNESS_WINDOWS.light);
    }
  });

  it('uses the global set as the base for an override when the bean has no level', () => {
    const resolved = resolveFreshnessWindows('', { from: 3, until: 10 });
    expect(resolved.source).toBe('custom');
    expect(resolved.level).toBeNull();
    expect(resolved.windows.degasUntil).toBe(2); // min(global 4, 3-1)
    expect(resolved.windows.fadingUntil).toBe(35);
  });
});

describe('freshnessState with a level and override', () => {
  it('changes the band when the level changes, at the same age', () => {
    // Day 25: still peak for a light roast (21–45), already fading for a dark
    // one (18–30).
    expect(freshnessState(25, 'light')).toBe('peak');
    expect(freshnessState(25, 'dark')).toBe('fading');
    expect(freshnessState(25)).toBe('fading');
  });

  it('lets a per-bean override move the peak band', () => {
    expect(freshnessState(9, 'light')).toBe('degassing');
    expect(freshnessState(9, 'light', { from: 8, until: 12 })).toBe('peak');
  });
});

describe('resolveFreshness', () => {
  it('returns the windows, source and band from one resolution', () => {
    const fresh = resolveFreshness(30, 'light');
    expect(fresh.source).toBe('level');
    expect(fresh.windows).toEqual(DEFAULT_LEVEL_FRESHNESS_WINDOWS.light);
    expect(fresh.state).toBe('peak');
    expect(freshnessSourceLabelKey(fresh)).toBe('roast_level_light');
  });

  it('agrees with freshnessState and resolveFreshnessWindows', () => {
    for (const level of [...ROAST_LEVELS, null, 'bogus']) {
      for (const override of [null, { from: 8, until: 12 }]) {
        for (const days of [null, 0, 5, 12, 30, 60]) {
          const fresh = resolveFreshness(days, level, override);
          expect(fresh.windows).toEqual(resolveFreshnessWindows(level, override).windows);
          expect(fresh.state).toBe(freshnessState(days, level, override));
        }
      }
    }
  });
});

describe('freshnessOverrideFrom', () => {
  it('reads a complete pair only', () => {
    expect(freshnessOverrideFrom({ bestFromDays: 4, bestUntilDays: 10 })).toEqual({ from: 4, until: 10 });
    expect(freshnessOverrideFrom({ bestFromDays: 4 })).toBeNull();
    expect(freshnessOverrideFrom({ bestFromDays: null, bestUntilDays: 10 })).toBeNull();
    expect(freshnessOverrideFrom(null)).toBeNull();
  });
});

describe('normalizeRoastLevel', () => {
  it('accepts only known levels', () => {
    expect(normalizeRoastLevel('medium-dark')).toBe('medium-dark');
    expect(normalizeRoastLevel('Medium')).toBeNull();
    expect(normalizeRoastLevel('')).toBeNull();
    expect(normalizeRoastLevel(null)).toBeNull();
  });
});

describe('parseBestForUseDays', () => {
  it('treats two empty fields as "no override"', () => {
    expect(parseBestForUseDays('', '')).toEqual({ ok: true, from: null, until: null });
    expect(parseBestForUseDays('  ', ' ')).toEqual({ ok: true, from: null, until: null });
  });

  it('accepts a whole-day ascending pair', () => {
    expect(parseBestForUseDays('5', '10')).toEqual({ ok: true, from: 5, until: 10 });
  });

  it('rejects partial, fractional, zero, out-of-range and inverted pairs', () => {
    for (const [from, until] of [['5', ''], ['', '10'], ['5.5', '10'], ['0', '10'], ['5', '366'], ['10', '5'], ['5', '5'], ['x', '10']]) {
      expect(parseBestForUseDays(from as string, until as string).ok, `${from}-${until}`).toBe(false);
    }
  });
});
