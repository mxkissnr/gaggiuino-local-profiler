// #2016: a failed listOrders() used to be rendered as an empty list, so a
// background refresh wiped the pending orders, hid the badge and reset the
// known pending ids — the next good refresh then re-notified every order.
// The failure path must keep what is on screen and only speak up when the list
// had nothing but the loading line.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MenuItem, MilkStock, Order, OrdersSettings, QueueEta } from '../public-src/api/types.js';

const g = globalThis as unknown as Record<string, unknown>;

const store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k) ?? null : null),
  setItem: (k: string, v: unknown) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

const api = vi.hoisted(() => ({
  listOrders: vi.fn<() => Promise<Order[]>>(),
  getOrdersMenu: vi.fn<() => Promise<MenuItem[]>>(),
  getQueueEta: vi.fn<() => Promise<QueueEta>>(),
  getMilkStock: vi.fn<() => Promise<MilkStock[]>>(),
  getOrdersSettings: vi.fn<() => Promise<OrdersSettings>>(),
  getSwitch: vi.fn<() => Promise<Response>>(),
}));

vi.mock('../public-src/api/orders.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/orders.js')>();
  return {
    ...actual,
    listOrders: api.listOrders,
    getOrdersMenu: api.getOrdersMenu,
    getQueueEta: api.getQueueEta,
    getMilkStock: api.getMilkStock,
    getOrdersSettings: api.getOrdersSettings,
  };
});

vi.mock('../public-src/api/system.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/system.js')>();
  return { ...actual, getSwitch: api.getSwitch };
});

interface FakeEl {
  innerHTML: string;
  style: Record<string, string>;
  querySelectorAll: () => never[];
}

function fakeEl(innerHTML = ''): FakeEl {
  return { innerHTML, style: {}, querySelectorAll: () => [] };
}

const { loadOrdersView } = await import('../public-src/views/orders.js');
const { S } = await import('../public-src/state/index.js');

interface RuntimeState { _knownPendingIds?: Set<string> | null }
const SO = S as unknown as RuntimeState;

function docWith(els: Record<string, FakeEl | null>): Record<string, unknown> {
  return {
    activeElement: null,
    getElementById: (id: string) => els[id] ?? null,
    querySelectorAll: () => [],
  };
}

beforeEach(() => {
  api.listOrders.mockReset();
  api.getOrdersMenu.mockReset().mockResolvedValue([]);
  api.getQueueEta.mockReset().mockRejectedValue(new Error('no eta'));
  api.getMilkStock.mockReset().mockResolvedValue([]);
  api.getOrdersSettings.mockReset().mockResolvedValue({ enabled: true });
  api.getSwitch.mockReset().mockResolvedValue({ json: () => Promise.resolve({}) } as unknown as Response);
  SO._knownPendingIds = null;
});

describe('#2016 orders refresh failure', () => {
  it('keeps the list markup and the known pending ids', async () => {
    const list = fakeEl('<div class="order-card">Order A</div>');
    // Visible, as a good load with a pending order left it.
    const badge = fakeEl();
    badge.style.display = '';
    g.document = docWith({ 'orders-pending-list': list, ordersBadge: badge });
    const known = new Set(['o1']);
    SO._knownPendingIds = known;
    api.listOrders.mockRejectedValue(new Error('offline'));

    await loadOrdersView();

    expect(list.innerHTML).toBe('<div class="order-card">Order A</div>');
    expect(SO._knownPendingIds).toBe(known);
    expect([...known]).toEqual(['o1']);
    expect(badge.style.display).toBe('');
  });

  it('shows error_load when the list had nothing on screen', async () => {
    const list = fakeEl('');
    g.document = docWith({ 'orders-pending-list': list });
    api.listOrders.mockRejectedValue(new Error('offline'));

    await loadOrdersView();

    expect(list.innerHTML).toContain('Error loading data');
  });
});
