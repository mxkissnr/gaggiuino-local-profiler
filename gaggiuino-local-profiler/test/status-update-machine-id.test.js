// status.js's updateStatus(machineId) — #464. Before this, switching the
// active machine via the topbar switcher left #railStatusDot/#railMachineName
// showing the default machine (or stale data) until the next unparameterized
// 30s poll. updateStatus() now accepts an optional machineId and forwards it
// as ?machineId= on /api/status; omitting it (or passing 'all', the
// switcher's "all machines" value) must keep hitting the endpoint
// unparameterized, matching the existing "'all' == default machine"
// convention already used by views/live.js's _isActiveMachineLiveCapable()
// and views/maintenance.js's _effectiveScope().
//
// This repo has no jsdom/happy-dom dependency (vitest runs with
// environment: 'node') — build just enough of a fake document/fetch to
// exercise updateStatus(), mirroring the convention in
// test/bottom-nav-config.test.js.
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
    const el = { className: '', textContent: '', title: '', style: {}, disabled: false };
    return el;
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

describe('updateStatus(machineId) — #464', () => {
  let doc, fetchCalls;

  beforeEach(() => {
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive'].forEach(id => doc._preRegister(id));
    globalThis.document = doc;
    S.primaryShotId = null;
    S.currentLang = 'en';

    fetchCalls = [];
    globalThis.fetch = vi.fn((url) => {
      fetchCalls.push(String(url));
      if (String(url).startsWith('api/status')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ lastSync: '2026-01-01T00:00:00.000Z', machineHostname: 'kitchen.local' }),
        });
      }
      return Promise.resolve({ ok: false }); // api/switch
    });
  });

  it('omits the query param when called with no argument (unparameterized 30s poll)', async () => {
    await updateStatus();
    expect(fetchCalls).toContain('api/status');
  });

  it('omits the query param for the "all machines" switcher value', async () => {
    await updateStatus('all');
    expect(fetchCalls).toContain('api/status');
  });

  it('omits the query param when explicitly passed null/undefined', async () => {
    await updateStatus(null);
    expect(fetchCalls).toContain('api/status');
  });

  it('adds ?machineId=<id> for a concrete non-default machine id', async () => {
    await updateStatus(7);
    expect(fetchCalls).toContain('api/status?machineId=7');
  });

  it('refreshes railStatusDot/railMachineName from the scoped response instead of waiting for the next poll', async () => {
    doc.getElementById('railStatusDot').className = 'status-dot unknown';
    doc.getElementById('railMachineName').textContent = 'stale-default.local';

    await updateStatus(7);

    expect(doc.getElementById('railMachineName').textContent).toBe('kitchen.local');
    expect(doc.getElementById('railStatusDot').className).toBe('status-dot ok');
  });
});
