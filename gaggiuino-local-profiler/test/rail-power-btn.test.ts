// #914 added a phone-only topbar copy of the power toggle (#railPowerBtn),
// because the real one lived in the shot list footer, which mobile hides.
// #2056 moved that one toggle -- together with the sync time and the Sync
// button -- from the footer into the topbar for every layout, dropped the
// copy and the footer's second status dot. Same fake-document/fetch harness
// as test/machine-on-duration.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(__dirname, '../public-src/index.html'), 'utf8');
const CSS = readFileSync(join(__dirname, '../public-src/style.css'), 'utf8');

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

interface FakeResponse { ok: boolean; json: () => Promise<unknown> }

// A pending fetch response whose resolution the test controls, so it can
// observe the in-flight (disabled) state of toggleMachinePower().
function deferredResponse(): { promise: Promise<FakeResponse>; resolve: (r: FakeResponse) => void } {
  let resolve!: (r: FakeResponse) => void;
  const promise = new Promise<FakeResponse>(res => { resolve = res; });
  return { promise, resolve };
}

function mockResponses({ switchBody, togglePending }: {
  switchBody: { configured: boolean; state: boolean } | null;
  togglePending?: Promise<FakeResponse>;
}): void {
  g.fetch = vi.fn((url: string) => {
    if (String(url).startsWith('api/status')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ lastSync: '2026-01-01T00:00:00.000Z', machineHostname: 'kitchen.local' }),
      });
    }
    if (String(url).startsWith('api/switch/toggle')) {
      if (togglePending) return togglePending;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ state: switchBody?.state ?? true }) });
    }
    if (String(url).startsWith('api/switch')) {
      return switchBody
        ? Promise.resolve({ ok: true, json: () => Promise.resolve(switchBody) })
        : Promise.resolve({ ok: false });
    }
    return Promise.resolve({ ok: false });
  });
}

describe('the topbar power toggle and sync controls (#914, #2056)', () => {
  let doc: FakeDocument;

  beforeEach(() => {
    doc = makeFakeDocument();
    // No #statusDot and no #railPowerBtn: the status code must not need them
    // any more.
    ['railStatusDot', 'syncTime', 'machineSubtitle', 'railMachineName',
     'glpVersionBadge', 'btnOrders', 'bnOrders', 'powerBtn', 'btnLive'].forEach(id => doc._preRegister(id));
    g.document = doc;
    S.primaryShotId = null;
    S.currentLang = 'en';
  });

  it('hides the toggle when no switch is configured', async () => {
    mockResponses({ switchBody: null });
    await updateStatus();
    expect(doc.getElementById('powerBtn')!.style.display).toBe('none');
  });

  it('shows the toggle with the on state', async () => {
    mockResponses({ switchBody: { configured: true, state: true } });
    await updateStatus();
    const btn = doc.getElementById('powerBtn')!;
    expect(btn.style.display).toBe('');
    expect(btn.className).toBe('machine-on');
    expect(btn.title).not.toBe('');
  });

  it('shows the off state', async () => {
    mockResponses({ switchBody: { configured: true, state: false } });
    await updateStatus();
    expect(doc.getElementById('powerBtn')!.className).toBe('machine-off');
  });

  it('keeps the toggle disabled while the switch request is in flight', async () => {
    // Hold the switch request pending so the in-flight state is observable;
    // checking only the resolved end state would never catch a build that
    // forgets to disable the button.
    const pending = deferredResponse();
    mockResponses({ switchBody: { configured: true, state: false }, togglePending: pending.promise });
    const btn = doc.getElementById('powerBtn')!;

    const done = toggleMachinePower();
    expect(btn.disabled).toBe(true);

    pending.resolve({ ok: true, json: () => Promise.resolve({ state: true }) });
    await done;

    expect(btn.disabled).toBe(false);
  });

  it('writes the reachability to the topbar dot alone', async () => {
    mockResponses({ switchBody: null });
    await updateStatus();
    expect(doc.getElementById('railStatusDot')!.className).toBe('status-dot ok');
  });

  it('the markup has one toggle, in the topbar', () => {
    const topbar = HTML.slice(HTML.indexOf('class="topbar-machine"'), HTML.indexOf('id="machineSwitcher"'));
    const syncAt = topbar.indexOf('id="syncTime"');
    const powerAt = topbar.indexOf('id="powerBtn"');
    const syncBtnAt = topbar.indexOf('id="syncBtn"');
    expect(syncAt).toBeGreaterThan(-1);
    expect(powerAt).toBeGreaterThan(syncAt);
    expect(syncBtnAt).toBeGreaterThan(powerAt);

    const footer = HTML.slice(HTML.indexOf('id="sidebar-footer"'), HTML.indexOf('<!-- ── Bottom navigation'));
    expect(footer).toContain('id="glpVersionBadge"');
    expect(footer).toContain('id="glpDemoBadge"');
    expect(footer).not.toContain('id="syncTime"');
    expect(footer).not.toContain('id="powerBtn"');
    expect(footer).not.toContain('id="syncBtn"');

    expect(HTML.split('id="syncTime"').length - 1).toBe(1);
    expect(HTML.split('id="powerBtn"').length - 1).toBe(1);
    expect(HTML.split('id="syncBtn"').length - 1).toBe(1);
    expect(HTML).not.toContain('id="railPowerBtn"');
    expect(HTML).not.toContain('id="statusDot"');

    const syncBtnTag = HTML.slice(HTML.indexOf('<button id="syncBtn"'), HTML.indexOf('</button>', HTML.indexOf('<button id="syncBtn"')));
    expect(syncBtnTag).toContain('data-i18n-title="btn_sync"');

    expect(CSS).not.toContain('#railPowerBtn');
    const mediaAt = CSS.indexOf('@media (max-width: 999px)');
    expect(mediaAt).toBeGreaterThan(-1);
    const mediaBlock = CSS.slice(mediaAt, CSS.indexOf('\n        }', mediaAt));
    expect(mediaBlock).toContain('#syncTime { display: none; }');
    expect(mediaBlock).toContain('#syncBtn::before');
  });
});
