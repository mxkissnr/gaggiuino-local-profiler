// #2148: the Orders page in the Home Assistant page pattern (design doc,
// "Page anatomy"). Pins the markup (top app bar, verdict, grouped lists,
// Manage panels), the Manage rows opening their panel in the shared detail
// sheet, the poll guard and the verdict, with the fake-DOM style the other
// frontend tests use (no jsdom in this repo).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { MenuItem, MilkStock, NotifyMappingView, NotifyService, Order, OrderStats, OrdersSettings, QueueEta } from '../public-src/api/types.js';
import type { KioskKey } from '../public-src/api/orders.js';

const g = globalThis as unknown as Record<string, unknown>;

const store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k) ?? null : null),
  setItem: (k: string, v: unknown) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

interface SheetOptions {
  title: string;
  body: string;
  sub?: string;
  dialog?: boolean;
  content?: unknown;
  anchor?: unknown;
  onClose?: () => void;
}

const sheet = vi.hoisted(() => ({
  openDetailSheet: vi.fn<(opts: SheetOptions) => void>(),
  requestCloseDetailSheet: vi.fn<() => void>(),
  closeDetailSheet: vi.fn<() => void>(),
}));
vi.mock('../public-src/components/detail-sheet.js', () => sheet);

const api = vi.hoisted(() => ({
  listOrders: vi.fn<() => Promise<Order[]>>(),
  getOrdersMenu: vi.fn<() => Promise<MenuItem[]>>(),
  getQueueEta: vi.fn<() => Promise<QueueEta>>(),
  getMilkStock: vi.fn<() => Promise<MilkStock[]>>(),
  getOrdersSettings: vi.fn<() => Promise<OrdersSettings>>(),
  getOrdersStats: vi.fn<() => Promise<OrderStats>>(),
  getKioskKey: vi.fn<() => Promise<KioskKey>>(),
  getNotifyMapping: vi.fn<() => Promise<NotifyMappingView>>(),
  getNotifyServices: vi.fn<() => Promise<NotifyService[]>>(),
  postOrderAccept: vi.fn<() => Promise<Response>>(),
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
    getOrdersStats: api.getOrdersStats,
    getKioskKey: api.getKioskKey,
    getNotifyMapping: api.getNotifyMapping,
    getNotifyServices: api.getNotifyServices,
    postOrderAccept: api.postOrderAccept,
  };
});

vi.mock('../public-src/api/system.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/system.js')>();
  return { ...actual, getSwitch: api.getSwitch };
});

interface FakeEl {
  id: string;
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  value: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  inside: unknown[];
  contains: (el: unknown) => boolean;
  querySelectorAll: () => never[];
  querySelector: () => null;
  addEventListener: () => void;
  setAttribute: () => void;
}

function fakeEl(id: string): FakeEl {
  const el: FakeEl = {
    id,
    innerHTML: '',
    textContent: '',
    hidden: false,
    value: '',
    style: {},
    dataset: {},
    inside: [],
    contains: (other: unknown) => el.inside.includes(other),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    setAttribute: () => {},
  };
  return el;
}

let els: Record<string, FakeEl> = {};

function installDoc(activeElement: unknown = null): void {
  els = {};
  g.document = {
    activeElement,
    baseURI: 'http://glp.local:8099/',
    documentElement: {},
    getElementById: (id: string) => (els[id] ??= fakeEl(id)),
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  g.location = { pathname: '/', href: 'http://glp.local:8099/' };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dirname, '../public-src/index.html'), 'utf8');

const orders = await import('../public-src/views/orders.js');
const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');

const view = (() => {
  const start = indexHtml.indexOf('<div id="orders-view">');
  const end = indexHtml.indexOf('<!-- Library view -->', start);
  return indexHtml.slice(start, end);
})();
const bar = view.slice(0, view.indexOf('<div class="orders-layout">'));
const panels = view.slice(view.indexOf('<div class="orders-panels" hidden>'));

function order(over: Partial<Order> & Pick<Order, 'id' | 'status'>): Order {
  return {
    createdAt: Date.now(),
    customer: 'Ana',
    item: 'Latte',
    variant: null,
    note: '',
    notifyService: null,
    eta: null,
    acceptedAt: null,
    completedAt: null,
    declineReason: null,
    machine: null,
    machineId: 1,
    beanId: null,
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  sheet.openDetailSheet.mockReset();
  sheet.requestCloseDetailSheet.mockReset();
  sheet.closeDetailSheet.mockReset();
  api.listOrders.mockResolvedValue([]);
  api.getOrdersMenu.mockResolvedValue([]);
  api.getQueueEta.mockRejectedValue(new Error('no eta'));
  api.getMilkStock.mockResolvedValue([]);
  api.getOrdersSettings.mockResolvedValue({ enabled: true });
  api.getOrdersStats.mockResolvedValue({ total: 0 } as unknown as OrderStats);
  api.getKioskKey.mockResolvedValue({ kioskKey: 'k3y' });
  api.getNotifyMapping.mockResolvedValue({ mapping: {}, customers: {} });
  api.getNotifyServices.mockResolvedValue([]);
  api.postOrderAccept.mockResolvedValue({ ok: true } as unknown as Response);
  api.getSwitch.mockResolvedValue({ json: () => Promise.resolve({}) } as unknown as Response);
});

describe('orders markup (#2148)', () => {
  it('opens with the settings top app bar carrying the title and the accept switch', () => {
    expect(bar).toContain('<div class="settings-bar orders-bar">');
    expect(bar).toContain('<h1 class="settings-bar-title" data-i18n="nav_orders">');
    expect(bar).toContain('data-i18n="orders_accept_toggle"');
    expect(bar).toContain('id="ordersEnabledToggle"');
  });

  it('has the verdict, the two grouped lists and the Manage group', () => {
    expect(view).toContain('id="ordersVerdictTitle"');
    expect(view).toContain('id="ordersVerdictSub"');
    expect(view).toContain('id="ordersWaitingCount"');
    expect(view).toContain('<div id="orders-pending-list" class="settings-group"></div>');
    expect(view).toContain('<div id="orders-accepted-list" class="settings-group"></div>');
    expect(view).toContain('<section class="orders-manage" id="ordersManage"></section>');
  });

  it('keeps every existing control exactly once, inside a Manage panel', () => {
    for (const id of [
      'ordersMenuList', 'ordersMenuEmoji', 'ordersMenuName', 'addOrderMenuItemBtn',
      'orders-milk-stock', 'ordersStatsContent', 'ordersKioskBody', 'ordersNotifyBody',
      'orders-history-list', 'orders-clear-history',
    ]) {
      expect(indexHtml.split(`id="${id}"`).length - 1, id).toBe(1);
      expect(panels, id).toContain(`id="${id}"`);
    }
  });

  it('has one panel per Manage row', () => {
    for (const row of orders.ORDERS_MANAGE_ROWS) {
      expect(panels, row.id).toContain(`id="${row.panelId}"`);
    }
  });

  it('drops the folds, the banner and the old toggle row', () => {
    for (const gone of ['card-title', 'orders-menu-toggle', 'orders-machine-off-banner', 'orders-columns', 'orders-toggle-row', '▾', '▸']) {
      expect(view, gone).not.toContain(gone);
    }
  });
});

describe('Manage rows (#2148)', () => {
  it('renders one chevron row per panel, in table order', () => {
    const markup = orders.ordersManageHtml();
    const ids = [...markup.matchAll(/data-orders-manage="([^"]+)"/g)].map(m => m[1]);
    expect(ids).toEqual(['history', 'menu', 'guests', 'kiosk']);
    expect(markup.split('class="settings-chev"').length - 1).toBe(4);
    for (const row of orders.ORDERS_MANAGE_ROWS) {
      expect(markup, row.id).toContain(`data-i18n="${row.titleKey}"`);
    }
  });

  it.each(['history', 'menu', 'guests', 'kiosk'])('%s opens its panel in the detail sheet', (id) => {
    installDoc();
    const row = orders.ORDERS_MANAGE_ROWS.find(r => r.id === id)!;
    orders.openOrdersManage(id);

    expect(sheet.openDetailSheet).toHaveBeenCalledTimes(1);
    const opts = sheet.openDetailSheet.mock.calls[0]?.[0] as SheetOptions;
    expect(opts.content).toBe(els[row.panelId]);
    expect(opts.dialog).toBe(true);
    expect(opts.title).toBe(t(row.titleKey));
  });

  it('Guests loads the statistics while its sheet is open', () => {
    installDoc();
    S._ordersStatsOpen = false;
    orders.openOrdersManage('guests');

    expect(api.getOrdersStats).toHaveBeenCalledTimes(1);
    expect(S._ordersStatsOpen).toBe(true);

    const opts = sheet.openDetailSheet.mock.calls[0]?.[0] as SheetOptions;
    opts.onClose?.();
    expect(S._ordersStatsOpen).toBe(false);
  });

  it('Kiosk link loads the link and the notification settings', () => {
    installDoc();
    orders.openOrdersManage('kiosk');

    expect(api.getKioskKey).toHaveBeenCalledTimes(1);
    expect(api.getNotifyServices).toHaveBeenCalledTimes(1);
  });

  it('ignores an unknown row', () => {
    installDoc();
    orders.openOrdersManage('nope');
    expect(sheet.openDetailSheet).not.toHaveBeenCalled();
  });
});

describe('poll guard (#2148)', () => {
  it('holds the poll while a field inside an open Manage panel has focus', () => {
    const input = { tagName: 'INPUT', type: 'text', isContentEditable: false };
    installDoc(input);
    const panel = fakeEl('ordersMenuPanel');
    panel.inside.push(input);
    els.ordersMenuPanel = panel;

    expect(orders.ordersDraftOpen()).toBe(true);
  });

  it('stays quiet when nothing is focused', () => {
    installDoc();
    expect(orders.ordersDraftOpen()).toBe(false);
  });
});

describe('verdict (#2148)', () => {
  const now = new Date(2026, 10, 21, 12, 0, 0).getTime();

  it('takes the server estimate for the queue minutes', () => {
    expect(orders.ordersQueueMinutes([], { acceptedRemaining: 3.2, pendingCount: 2, prepTime: 4, positions: {} }, now)).toBe(12);
  });

  it('adds up the orders themselves without an estimate', () => {
    const list = [
      order({ id: 'a1', status: 'accepted', acceptedAt: now - 60000, eta: 5 }),
      order({ id: 'p1', status: 'pending' }),
    ];
    expect(orders.ordersQueueMinutes(list, null, now)).toBe(8);
  });

  it('counts the waiting orders', () => {
    const list = [
      order({ id: 'p1', status: 'pending' }),
      order({ id: 'p2', status: 'pending' }),
      order({ id: 'a1', status: 'accepted', acceptedAt: now, eta: 5 }),
    ];
    expect(orders.ordersVerdictText(list, null, {}, now).count).toBe(2);
  });

  it('says when the machine is off', () => {
    expect(orders.ordersVerdictText([], null, { configured: true, state: false }, now).sub).toBe(t('orders_machine_off'));
    expect(orders.ordersVerdictText([], null, { configured: true, state: true }, now).sub).toBe('');
  });

  it('writes the verdict into the page', () => {
    installDoc();
    orders.renderOrdersVerdict({ count: 3, title: 'T', sub: '' });

    expect(els.ordersWaitingCount?.textContent).toBe('3');
    expect(els.ordersVerdictTitle?.textContent).toBe('T');
    expect(els.ordersVerdictSub?.hidden).toBe(true);
  });
});
