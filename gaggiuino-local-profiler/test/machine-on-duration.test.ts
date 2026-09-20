// #681: the bottom-left footer's #syncTime used to always show the last
// shot-sync wall-clock time. While the machine is on, it now shows how long
// it's been on instead ("on Xh Ym"/"on Xm"), falling back to the previous
// last-sync display whenever the machine is off (or the response predates
// these additive fields). Same fake-document/fetch harness as
// test/status-update-machine-id.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis so the minimal fakes below need not satisfy the full
// Storage/Navigator shapes.
const g = globalThis as unknown as Record<string, unknown>;

const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string): string | null => _store.get(k) ?? null,
  setItem: (k: string, v: unknown) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { updateStatus } = await import('../public-src/components/status.js');

interface FakeStatusEl {
  className: string;
  textContent: string;
  title: string;
  style: Record<string, string>;
  disabled: boolean;
}
interface FakeDocument {
  getElementById(id: string): FakeStatusEl | undefined;
  _preRegister(id: string): FakeStatusEl;
}
function makeFakeDocument(): FakeDocument {
  const registry = new Map<string, FakeStatusEl>();
  function makeElement(): FakeStatusEl {
    return { className: '', textContent: '', title: '', style: {}, disabled: false };
  }
  return {
    getElementById: (id: string) => registry.get(id),
    _preRegister(id: string) {
      const el = makeElement();
      registry.set(id, el);
      return el;
    },
  };
}

function mockStatusResponse(overrides: Record<string, unknown>): void {
  g.fetch = vi.fn((url: RequestInfo | URL) => {
    if (String(url).startsWith('api/status')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ lastSync: '2026-01-01T00:00:00.000Z', machineHostname: 'kitchen.local', ...overrides }),
      });
    }
    return Promise.resolve({ ok: false }); // api/switch
  });
}

describe('#syncTime on-duration display (#681)', () => {
  let doc: FakeDocument;

  beforeEach(() => {
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive'].forEach(id => doc._preRegister(id));
    g.document = doc;
    S.primaryShotId = null;
    S.currentLang = 'en';
  });

  it('shows minutes-only duration when the machine has been on less than an hour', async () => {
    mockStatusResponse({ machineOn: true, machineOnSince: Date.now() - 5 * 60000 });
    await updateStatus();
    expect(doc.getElementById('syncTime')!.textContent).toBe('on 5 min');
  });

  it('shows hours+minutes duration once the machine has been on an hour or more', async () => {
    mockStatusResponse({ machineOn: true, machineOnSince: Date.now() - (2 * 60 + 14) * 60000 });
    await updateStatus();
    expect(doc.getElementById('syncTime')!.textContent).toBe('on 2h 14m');
  });

  it('falls back to the last-sync clock time when the machine is off', async () => {
    mockStatusResponse({ machineOn: false, machineOnSince: Date.now() - 600000 });
    await updateStatus();
    expect(doc.getElementById('syncTime')!.textContent).not.toMatch(/^on /);
  });

  it('falls back to the last-sync clock time when machineOnSince is missing (older GLP version)', async () => {
    mockStatusResponse({ machineOn: true, machineOnSince: null });
    await updateStatus();
    expect(doc.getElementById('syncTime')!.textContent).not.toMatch(/^on /);
  });
});
