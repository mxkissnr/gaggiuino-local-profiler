import { describe, it, expect, beforeAll } from 'vitest';

// analytics.js pulls in state.js/i18n.js (localStorage/navigator at module
// load) and its charts read window.calcShotScore at runtime — the same minimal
// window stub as the other analytics tests. shouldBuildAnalyticsMore() is pure,
// so the lazy fold's "closed → skip, first open → build" contract is pinned
// without a DOM.
type Analytics = typeof import('../public-src/views/analytics.js');
let shouldBuildAnalyticsMore: Analytics['shouldBuildAnalyticsMore'];

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
      calcShotScore: () => null,
      getShotData: () => ({}),
    },
    configurable: true, writable: true,
  });
  ({ shouldBuildAnalyticsMore } = await import('../public-src/views/analytics.js'));
});

describe('"More insights" fold (#1467)', () => {
  it('skips the folded builders while the fold is closed', () => {
    expect(shouldBuildAnalyticsMore(false, false)).toBe(false);
  });

  it('runs them once the fold is opened', () => {
    expect(shouldBuildAnalyticsMore(true, false)).toBe(true);
  });

  it('skips them while the filter has no shots, even with the fold open', () => {
    expect(shouldBuildAnalyticsMore(true, true)).toBe(false);
  });
});
