// orders.js's ordersDraftOpen(): the 10s orders poll and the live-sync `orders`
// handler must both hold back while the view holds text a reload would discard —
// a focused field inside #orders-view, or a decline-reason input left with a
// value (its row stays open even without focus).
//
// Same fake-document convention as the other frontend tests: stub the minimum
// browser globals the import chain needs, then swap document per case.
import { describe, it, expect } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;

const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k: string, v: unknown) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

const { ordersDraftOpen } = await import('../public-src/views/orders.js');

interface FakeDeclineInput { value: string }

function docWith(declineInputs: FakeDeclineInput[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activeElement: null,
    getElementById: () => null,
    querySelectorAll: (sel: string) => (sel === '[id^="declineReason_"]' ? declineInputs : []),
    ...over,
  };
}

describe('ordersDraftOpen', () => {
  it('is true when a decline-reason input has text', () => {
    g.document = docWith([{ value: '   ' }, { value: 'no milk' }]);
    expect(ordersDraftOpen()).toBe(true);
  });

  it('is false when every decline-reason input is empty and nothing is focused', () => {
    g.document = docWith([{ value: '' }, { value: '   ' }]);
    expect(ordersDraftOpen()).toBe(false);
  });

  it('is true when a text field is focused inside the orders view', () => {
    const view = { contains: () => true };
    g.document = docWith([], {
      activeElement: { tagName: 'INPUT', type: 'text', isContentEditable: false },
      getElementById: (id: string) => (id === 'orders-view' ? view : null),
    });
    expect(ordersDraftOpen()).toBe(true);
  });
});
