// #681: the bottom-left footer's #syncTime used to always show the last
// shot-sync wall-clock time. While the machine is on, it now shows how long
// it's been on instead ("on Xh Ym"/"on Xm"), falling back to the previous
// last-sync display whenever the machine is off (or the response predates
// these additive fields). Same fake-document/fetch harness as
// test/status-update-machine-id.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const _store = new Map();
globalThis.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: k => { _store.delete(k); },
};
globalThis.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const { updateStatus } = await import('../public-src/components/status.js');

function makeFakeDocument() {
  const registry = new Map();
  function makeElement() {
    return { className: '', textContent: '', title: '', style: {}, disabled: false };
  }
  return {
    getElementById: id => registry.get(id),
    _preRegister(id) {
      const el = makeElement();
      registry.set(id, el);
      return el;
    },
  };
}

function mockStatusResponse(overrides) {
  globalThis.fetch = vi.fn((url) => {
    if (String(url).startsWith('api/status')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ lastSync: '2026-01-01T00:00:00.000Z', machineHostname: 'kitchen.local', ...overrides }),
      });
    }
    return Promise.resolve({ ok: false }); // api/switch
  });
}

describe('#syncTime on-duration display (#681)', () => {
  let doc;

  beforeEach(() => {
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive'].forEach(id => doc._preRegister(id));
    globalThis.document = doc;
    S.primaryShotId = null;
    S.currentLang = 'en';
  });

  it('shows minutes-only duration when the machine has been on less than an hour', async () => {
    mockStatusResponse({ machineOn: true, machineOnSince: Date.now() - 5 * 60000 });
    await updateStatus();
    expect(doc.getElementById('syncTime').textContent).toBe('on 5 min');
  });

  it('shows hours+minutes duration once the machine has been on an hour or more', async () => {
    mockStatusResponse({ machineOn: true, machineOnSince: Date.now() - (2 * 60 + 14) * 60000 });
    await updateStatus();
    expect(doc.getElementById('syncTime').textContent).toBe('on 2h 14m');
  });

  it('falls back to the last-sync clock time when the machine is off', async () => {
    mockStatusResponse({ machineOn: false, machineOnSince: Date.now() - 600000 });
    await updateStatus();
    expect(doc.getElementById('syncTime').textContent).not.toMatch(/^on /);
  });

  it('falls back to the last-sync clock time when machineOnSince is missing (older GLP version)', async () => {
    mockStatusResponse({ machineOn: true, machineOnSince: null });
    await updateStatus();
    expect(doc.getElementById('syncTime').textContent).not.toMatch(/^on /);
  });
});
