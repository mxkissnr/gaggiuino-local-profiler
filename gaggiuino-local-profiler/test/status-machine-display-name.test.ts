// status.ts's topbar display name — #1454. The rail/topbar and the subtitle
// now prefer the name the machine reports in its own firmware settings
// (machines[].firmwareName), then the name configured in GLP (machines[].name),
// and only fall back to the unauthenticated machineHostname last. The machines[]
// entries need no auth token, so a name renders even on a response that omits
// machineHostname.
//
// Same minimal fake document/fetch scaffold as
// test/status-update-machine-id.test.ts (no jsdom/happy-dom in this repo).
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

function machineEntry(partial: Record<string, unknown>): Record<string, unknown> {
  return { id: 1, isDefault: true, ...partial };
}

describe('topbar machine display name — #1454', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let statusPayload: Record<string, unknown>;

  beforeEach(() => {
    doc = makeFakeDocument();
    ['statusDot', 'railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive'].forEach(id => doc._preRegister(id));
    g.document = doc;
    S.primaryShotId = null;
    S.currentLang = 'en';
    statusPayload = {};

    g.fetch = vi.fn((url: unknown) => {
      if (String(url).startsWith('api/status')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(statusPayload) } as unknown as Response);
      }
      return Promise.resolve({ ok: false } as unknown as Response); // api/switch
    });
  });

  it('rail shows the firmware name when the machine reports one', async () => {
    statusPayload = {
      machineHostname: 'kitchen.local',
      machines: [machineEntry({ name: 'Kitchen', firmwareName: 'GC-01' })],
    };
    await updateStatus();
    expect(doc.getElementById('railMachineName').textContent).toBe('GC-01');
  });

  it('rail falls back to the GLP name when the firmware reports none', async () => {
    statusPayload = {
      machineHostname: 'kitchen.local',
      machines: [machineEntry({ name: 'Kitchen' })],
    };
    await updateStatus();
    expect(doc.getElementById('railMachineName').textContent).toBe('Kitchen');
  });

  it('rail falls back to the hostname when no machines entry has a name', async () => {
    statusPayload = {
      machineHostname: 'kitchen.local',
      machines: [machineEntry({})],
    };
    await updateStatus();
    expect(doc.getElementById('railMachineName').textContent).toBe('kitchen.local');
  });

  it('renders a name even without machineHostname (unauthenticated response)', async () => {
    statusPayload = {
      machines: [machineEntry({ name: 'Kitchen', firmwareName: 'GC-01' })],
    };
    await updateStatus();
    expect(doc.getElementById('railMachineName').textContent).toBe('GC-01');
  });

  it('subtitle scopes to the requested machine and keeps the version suffix', async () => {
    statusPayload = {
      machineVersion: '1.2.3',
      machineHostname: 'kitchen.local',
      machines: [
        machineEntry({ id: 1, name: 'Kitchen' }),
        { id: 7, name: 'Second', firmwareName: 'GC-07' },
      ],
    };
    await updateStatus(7);
    expect(doc.getElementById('machineSubtitle').textContent).toBe('GC-07 · 1.2.3');
    // The rail always tracks the default machine, not the requested one (#447).
    expect(doc.getElementById('railMachineName').textContent).toBe('Kitchen');
  });

  it('subtitle uses the default entry when no machineId is given', async () => {
    statusPayload = {
      machineHostname: 'kitchen.local',
      machines: [machineEntry({ name: 'Kitchen', firmwareName: 'GC-01' })],
    };
    await updateStatus();
    expect(doc.getElementById('machineSubtitle').textContent).toBe('GC-01');
  });
});
