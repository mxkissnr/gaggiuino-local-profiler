import { describe, it, expect, beforeAll } from 'vitest';

// Same harness as analytics-bean-shelf.test.ts: analytics.ts pulls in
// state/index.ts/i18n.ts (localStorage/navigator at module load) and calls
// window.calcShotScore at runtime, so stub a minimal scoring window.
type Analytics = typeof import('../public-src/views/analytics.js');
let _computeBeanRanking: Analytics['_computeBeanRanking'];
let S: (typeof import('../public-src/state/index.js'))['S'];

type ShotRow = Parameters<Analytics['_computeBeanRanking']>[0][number];

interface ShotOverrides {
  timestamp?: number | undefined;
  score?: number | undefined;
  coffee?: string | null | undefined;
  beanId?: number | null | undefined;
}

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en', userAgent: 'Node.js' },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: {
      calcShotScore: (shot: ShotRow) => shot.score ?? null,
      getShotData: () => ({}),
    },
    configurable: true, writable: true,
  });
  ({ _computeBeanRanking } = await import('../public-src/views/analytics.js'));
  ({ S } = await import('../public-src/state/index.js'));
});

const shot = (overrides: ShotOverrides = {}): ShotRow => ({
  id: overrides.timestamp ?? 1,
  timestamp: overrides.timestamp ?? 0,
  score: overrides.score,
  annotation: { coffee: overrides.coffee, beanId: overrides.beanId },
});

describe('_computeBeanRanking groups by resolved bean id (#1625)', () => {
  it('merges a renamed bean\'s old and new names into one row labelled with the current name', () => {
    S.coffeeLibrary = { beans: [{ id: 1, name: 'Current Name' }], grinders: [] };
    const rows = _computeBeanRanking([
      shot({ coffee: 'Old Name', beanId: 1, timestamp: 1 }),
      shot({ coffee: 'Current Name', beanId: 1, timestamp: 2 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Current Name');
    expect(rows[0]?.shots).toBe(2);
    expect(rows[0]?.beanId).toBe(1);
  });
});
