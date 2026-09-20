// #914: the power button (#powerBtn) lives in #sidebar-footer, which is
// hidden entirely on mobile (updateMobileShotSidebarVisibility() in
// sidebar.js), stranding it off-screen. #railPowerBtn is its topbar
// duplicate; updatePowerButton() (components/status.js) must mirror the
// same display/className/title onto it, and toggleMachinePower() must keep
// both buttons disabled in lockstep. Same fake-document/fetch harness as
// test/machine-on-duration.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis so the minimal fakes below need not satisfy the full
// Storage/Navigator shapes.
const g = globalThis as unknown as Record<string, unknown>;

const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string): string | null => (_store.has(k) ? _store.get(k) ?? null : null),
  setItem: (k: string, v: unknown) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { updateStatus, toggleMachinePower } = await import('../public-src/components/status.js');

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

function mockResponses({ switchBody }: { switchBody: { configured: boolean; state: boolean } | null }): void {
  g.fetch = vi.fn((url: string) => {
    if (String(url).startsWith('api/status')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ lastSync: '2026-01-01T00:00:00.000Z', machineHostname: 'kitchen.local' }),
      });
    }
    if (String(url).startsWith('api/switch/toggle')) {
      return Promise.resolve({ ok: true, json: async () => ({ state: switchBody?.state ?? true }) });
    }
    if (String(url).startsWith('api/switch')) {
      return switchBody
        ? Promise.resolve({ ok: true, json: async () => switchBody })
        : Promise.resolve({ ok: false });
    }
    return Promise.resolve({ ok: false });
  });
}

describe('#railPowerBtn mirrors #powerBtn (#914)', () => {
  let doc: FakeDocument;

  beforeEach(() => {
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'railPowerBtn', 'btnLive'].forEach(id => doc._preRegister(id));
    g.document = doc;
    S.primaryShotId = null;
    S.currentLang = 'en';
  });

  it('hides both buttons when the switch is not configured', async () => {
    mockResponses({ switchBody: null });
    await updateStatus();
    expect(doc.getElementById('powerBtn')!.style.display).toBe('none');
    expect(doc.getElementById('railPowerBtn')!.style.display).toBe('none');
  });

  it('mirrors display/className/title onto #railPowerBtn when configured and on', async () => {
    mockResponses({ switchBody: { configured: true, state: true } });
    await updateStatus();
    const btn = doc.getElementById('powerBtn')!;
    const railBtn = doc.getElementById('railPowerBtn')!;
    expect(railBtn.style.display).toBe('');
    expect(railBtn.className).toBe(btn.className);
    expect(railBtn.className).toBe('machine-on');
    expect(railBtn.title).toBe(btn.title);
  });

  it('mirrors the machine-off state too', async () => {
    mockResponses({ switchBody: { configured: true, state: false } });
    await updateStatus();
    const railBtn = doc.getElementById('railPowerBtn')!;
    expect(railBtn.className).toBe('machine-off');
  });

  it('toggleMachinePower disables and re-enables both buttons in lockstep', async () => {
    mockResponses({ switchBody: { configured: true, state: false } });
    const btn = doc.getElementById('powerBtn')!;
    const railBtn = doc.getElementById('railPowerBtn')!;
    await toggleMachinePower();
    expect(btn.disabled).toBe(false);
    expect(railBtn.disabled).toBe(false);
  });
});
