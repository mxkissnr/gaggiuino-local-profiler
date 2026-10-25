// #1731: the Orders settings' Kiosk link panel. It shows the tablet URL with
// the orders-only key, and "New link" replaces the key after a confirm.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k) ?? null : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

const api = vi.hoisted(() => ({
  getKioskKey: vi.fn<() => Promise<{ kioskKey: string }>>(),
  rotateKioskKey: vi.fn<() => Promise<{ kioskKey: string }>>(),
}));
vi.mock('../public-src/api/orders.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/orders.js')>();
  return { ...actual, getKioskKey: api.getKioskKey, rotateKioskKey: api.rotateKioskKey };
});

interface FakeSection { innerHTML: string }

function docWith(section: FakeSection | null, opts: { pathname?: string; baseURI?: string } = {}) {
  return {
    baseURI: opts.baseURI ?? 'http://glp.local:8099/',
    documentElement: {},
    getElementById: (id: string) => (id === 'ordersKioskBody' ? section : null),
    querySelectorAll: () => [],
  };
}

const { loadKioskLinkView, kioskLinkFor } = await import('../public-src/views/orders.js');

beforeEach(() => {
  api.getKioskKey.mockReset();
  api.rotateKioskKey.mockReset();
  (g as Record<string, unknown>).location = { pathname: '/', href: 'http://glp.local:8099/' };
});

describe('kioskLinkFor', () => {
  it('puts the key in the fragment, url-encoded', () => {
    expect(kioskLinkFor('http://glp.local:8099/kiosk.html', 'a b&c'))
      .toBe('http://glp.local:8099/kiosk.html#key=a%20b%26c');
  });
});

describe('Kiosk link panel', () => {
  it('renders the ready-made link from the current key', async () => {
    const section: FakeSection = { innerHTML: '' };
    g.document = docWith(section);
    api.getKioskKey.mockResolvedValue({ kioskKey: 'k3y' });

    await loadKioskLinkView();

    expect(api.getKioskKey).toHaveBeenCalledTimes(1);
    expect(section.innerHTML).toContain('value="http://glp.local:8099/kiosk.html#key=k3y"');
    expect(section.innerHTML).toContain('ordersKioskCopyBtn');
    expect(section.innerHTML).toContain('ordersKioskRotateBtn');
    // Served on the direct port: no Ingress hint.
    expect(section.innerHTML).not.toContain('Ingress');
  });

  it('hints at the direct port when the page is served through HA Ingress', async () => {
    const section: FakeSection = { innerHTML: '' };
    g.document = docWith(section);
    g.location = { pathname: '/api/hassio_ingress/tok3n/orders', href: 'http://ha.local/api/hassio_ingress/tok3n/orders' };
    api.getKioskKey.mockResolvedValue({ kioskKey: 'k3y' });

    await loadKioskLinkView();

    expect(section.innerHTML).toContain('use the direct port');
    expect(section.innerHTML).toContain('http://&lt;host&gt;:8099');
  });

  it('shows the error instead of a link when the key cannot be read', async () => {
    const section: FakeSection = { innerHTML: '' };
    g.document = docWith(section);
    api.getKioskKey.mockRejectedValue(new Error('HTTP 503'));

    await loadKioskLinkView();

    expect(section.innerHTML).toContain('HTTP 503');
    expect(section.innerHTML).not.toContain('kiosk.html#key=');
  });

  it('does nothing without the panel in the DOM', async () => {
    g.document = docWith(null);
    await loadKioskLinkView();
    expect(api.getKioskKey).not.toHaveBeenCalled();
  });
});
