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

// vitest's node environment has no browser globals; the stubs go through a
// loose view of globalThis (the same bridge test/dev-banner.test.ts uses)
// rather than satisfying Storage/Navigator/Document.
const g = globalThis as unknown as Record<string, unknown>;
const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => _store.get(k) ?? null,
  setItem: (k: string, v: string) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { updateStatus } = await import('../public-src/components/status.js');

// Only the fields status.js writes on the rail/topbar nodes it looks up.
interface FakeStatusElement {
  className: string;
  textContent: string;
  title: string;
  style: Record<string, string>;
  disabled: boolean;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeStatusElement>();
  function makeElement(): FakeStatusElement {
    return { className: '', textContent: '', title: '', style: {}, disabled: false };
  }
  return {
    getElementById: (id: string): FakeStatusElement => registry.get(id)!,
    _preRegister(id: string) {
      const el = makeElement();
      registry.set(id, el);
      return el;
    },
  };
}

describe('updateStatus(machineId) — #464', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let fetchCalls: string[];

  beforeEach(() => {
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive'].forEach(id => doc._preRegister(id));
    g.document = doc;
    S.primaryShotId = null;
    S.currentLang = 'en';

    fetchCalls = [];
    // `json: async () => …` would trip @typescript-eslint/require-await.
    g.fetch = vi.fn((url: unknown) => {
      fetchCalls.push(String(url));
      if (String(url).startsWith('api/status')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ lastSync: '2026-01-01T00:00:00.000Z', machineHostname: 'kitchen.local' }),
        } as unknown as Response);
      }
      return Promise.resolve({ ok: false } as unknown as Response); // api/switch
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
