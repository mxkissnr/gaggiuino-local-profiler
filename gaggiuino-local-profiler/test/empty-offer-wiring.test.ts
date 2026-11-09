// #1958 slice 4: renderBeanList() is the one choke point every library change
// passes through (loadLibrary and every stock action re-render through it), so
// hooking the offer check in there covers every path without each caller
// remembering to. The check must run before the DOM guard, because a stock
// change on another device can arrive while this view is not mounted.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// views/library.ts's import chain reads localStorage/navigator at module load —
// stub the minimum browser globals so the module graph can be imported under
// vitest's node environment (same pattern as
// test/library-shelf-classify.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.document = { getElementById: () => null };

const mocks = vi.hoisted(() => ({ checkEmptyBeanOffer: vi.fn() }));

vi.mock('../public-src/views/library/empty-offer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/views/library/empty-offer.js')>()),
  checkEmptyBeanOffer: mocks.checkEmptyBeanOffer,
}));

const { renderBeanList } = await import('../public-src/views/library.js');

describe('renderBeanList wiring (#1958)', () => {
  beforeEach(() => {
    mocks.checkEmptyBeanOffer.mockClear();
  });

  it('asks the offer check once when #beanListUI is missing', () => {
    g.document = { getElementById: () => null };

    renderBeanList();

    expect(mocks.checkEmptyBeanOffer).toHaveBeenCalledTimes(1);
  });

  it('asks the offer check once when the library has no beans', () => {
    const el = { innerHTML: '' };
    g.document = { getElementById: () => el };

    renderBeanList();

    expect(mocks.checkEmptyBeanOffer).toHaveBeenCalledTimes(1);
  });
});
