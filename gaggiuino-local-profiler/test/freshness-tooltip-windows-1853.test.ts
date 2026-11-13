import { describe, it, expect, beforeEach } from 'vitest';

// #1853 part 2: the freshness badge tooltip hard-coded "7-21". It now reads the
// configured peak window, so the badge can no longer disagree with the
// Settings -> "Bean freshness" card.

type LibraryModule = typeof import('../public-src/views/library/bean-card.js');
type BeanRow = Parameters<LibraryModule['beanFreshBadge']>[0];

// bean-card pulls in state/index.ts and i18n.ts, which read localStorage and
// navigator at module load - stub those two only, same approach as
// bean-mix-learning.test.ts. `document` is deliberately left undefined so the
// module-level pointerdown listener in bags.ts guards itself out.
const store = new Map<string, string>();
function stub(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
stub('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
});
stub('navigator', { language: 'en' });
stub('window', { calcShotScore: () => null, getShotData: () => ({}) });

const { S } = await import('../public-src/state/index.js');
const { beanFreshBadge } = await import('../public-src/views/library/bean-card.js');

const CUSTOM_WINDOWS = { degasUntil: 2, peakFrom: 10, peakUntil: 25, fadingUntil: 40 };

function setWindows(value: unknown): void {
  store.set('glp_ui_prefs', JSON.stringify({ bean_freshness: value }));
}

// The roast date is derived from a fixed day offset rather than a literal so
// the badge's day count never drifts with the clock.
function beanAgedDays(days: number, extra: Partial<BeanRow> = {}): BeanRow {
  const roast = new Date(Date.now() - days * 86400000);
  const iso = `${roast.getFullYear()}-${String(roast.getMonth() + 1).padStart(2, '0')}-${String(roast.getDate()).padStart(2, '0')}`;
  return {
    id: 1,
    name: 'Test Bean',
    stock_g: 250,
    remainingG: 240,
    bags: [{ id: 7, roastDate: iso, stock_g: 250, consumedG: 10, remainingG: 240, current: true }],
    ...extra,
  };
}

function badgeTitle(bean: BeanRow = beanAgedDays(12)): string {
  const markup = beanFreshBadge(bean);
  const match = /title="([^"]*)"/.exec(markup);
  expect(match, 'no title attribute rendered').not.toBeNull();
  return match?.[1] ?? '';
}

function badgeClass(bean: BeanRow): string {
  const match = /class="lib-fresh-badge ([^"]*)"/.exec(beanFreshBadge(bean));
  return match?.[1] ?? '';
}

beforeEach(() => {
  store.clear();
  S.currentLang = 'en';
});

describe('freshness tooltip follows the configured windows (#1853)', () => {
  it('names the default peak window when nothing is configured', () => {
    expect(badgeTitle()).toContain('7–21');
  });

  it('names the stored peak window instead of the hard-coded one', () => {
    setWindows(CUSTOM_WINDOWS);
    const title = badgeTitle();
    expect(title).toContain('10–25');
    expect(title).not.toContain('7–21');
  });

  it("keeps every language's own wording around the two bounds", () => {
    setWindows(CUSTOM_WINDOWS);
    const expected: Record<string, string> = {
      de: 'Optimum: 10–25 Tage',
      en: 'optimal: 10–25 days',
      es: 'óptimo: 10–25 días',
      fr: 'optimal: 10–25 jours',
      it: 'ottimale: 10–25 giorni',
      nl: 'optimum: 10–25 dagen',
    };
    for (const [lang, phrase] of Object.entries(expected)) {
      S.currentLang = lang;
      expect(badgeTitle(), lang).toContain(phrase);
    }
  });

  it('never leaves an uninterpolated bound in the tooltip', () => {
    for (const lang of ['de', 'en', 'es', 'fr', 'it', 'nl']) {
      S.currentLang = lang;
      expect(badgeTitle(), lang).not.toContain('undefined');
    }
  });
});

// #1977: the bean card follows the same per-bean resolution as the shot badge
// and tracker — roast level first, then an optional "best for use" override.
describe('freshness tooltip follows the bean roast level (#1977)', () => {
  it('uses the bean\'s level window and names the level', () => {
    const bean = beanAgedDays(12, { roastLevel: 'light' });
    const title = badgeTitle(bean);
    // light defaults to 21–45, not the global 7–21
    expect(title).toContain('21–45');
    expect(title).toContain('Light');
  });

  it('changing the level changes the badge band at the same age', () => {
    // Day 12 is still degassing for a light roast (degas until 14, peak from
    // 21) but already peak under the global window (7–21).
    expect(badgeClass(beanAgedDays(12, { roastLevel: 'light' }))).toBe('fresh-degassing');
    expect(badgeClass(beanAgedDays(12))).toBe('fresh-peak');
  });

  it('lets a per-bean override replace the peak window and names it custom', () => {
    const bean = beanAgedDays(12, { roastLevel: 'light', bestFromDays: 8, bestUntilDays: 10 });
    const title = badgeTitle(bean);
    expect(title).toContain('8–10');
    expect(title).toContain('custom window');
  });

  it('ignores a lone override bound', () => {
    const bean = beanAgedDays(12, { roastLevel: 'light', bestFromDays: 8 });
    expect(badgeTitle(bean)).toContain('21–45');
    expect(badgeTitle(bean)).not.toContain('custom window');
  });
});
