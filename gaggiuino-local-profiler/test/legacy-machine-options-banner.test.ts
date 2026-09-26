// #662: one-time in-app banner pointing an upgrading install at Settings ->
// Machines while GET /api/status reports legacyMachineOptionsPending: true
// (see lib/machines/options-adoption.js's hasUnconfirmedLegacyMachineOptions(),
// covered separately in test/options-adoption.test.js). Fake DOM mirrors
// test/dev-banner.test.js's createElement/insertAdjacentElement pattern.
import { describe, it, expect, beforeEach } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge test/dev-banner.test.ts uses) so the
// minimal fakes below need not satisfy the full Storage/Navigator/Document shapes.
const g = globalThis as unknown as Record<string, unknown>;

g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const _sessionStore = new Map<string, string>();
g.sessionStorage = {
  getItem: (k: string) => (_sessionStore.has(k) ? _sessionStore.get(k) : null),
  setItem: (k: string, v: unknown) => { _sessionStore.set(k, String(v)); },
  removeItem: (k: string) => { _sessionStore.delete(k); },
};

const { S } = await import('../public-src/state/index.js');
const { updateLegacyMachineOptionsBanner } = await import('../public-src/components/onboarding.js');

interface FakeBannerEl {
  id: string;
  style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  append: (...nodes: FakeBannerEl[]) => void;
  addEventListener: (type: string, listener: () => void) => void;
  remove(): void;
}

function makeFakeDocument() {
  const registry = new Map<string, FakeBannerEl>();
  const body = { insertAdjacentElement: (_pos: string, el: FakeBannerEl) => { registry.set(el.id, el); } };
  return {
    body,
    getElementById: (id: string): FakeBannerEl | undefined => registry.get(id),
    createElement: (): FakeBannerEl => ({
      id: '', style: {}, textContent: '', innerHTML: '', append: () => {}, addEventListener: () => {},
      remove() { registry.delete(this.id); },
    }),
  };
}

describe('legacy machine options banner (#662)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;

  beforeEach(() => {
    doc = makeFakeDocument();
    g.document = doc;
    S.legacyMachineOptionsPending = false;
    _sessionStore.clear();
  });

  it('does not create a banner when nothing is pending', () => {
    updateLegacyMachineOptionsBanner({ legacyMachineOptionsPending: false });
    expect(doc.getElementById('glpLegacyMachineOptionsBanner')).toBeUndefined();
  });

  it('creates the banner when the status response reports it pending', () => {
    updateLegacyMachineOptionsBanner({ legacyMachineOptionsPending: true });
    expect(doc.getElementById('glpLegacyMachineOptionsBanner')).toBeDefined();
  });

  it('removes an existing banner once the server reports nothing pending anymore (user confirmed in Settings)', () => {
    updateLegacyMachineOptionsBanner({ legacyMachineOptionsPending: true });
    expect(doc.getElementById('glpLegacyMachineOptionsBanner')).toBeDefined();

    updateLegacyMachineOptionsBanner({ legacyMachineOptionsPending: false });
    expect(doc.getElementById('glpLegacyMachineOptionsBanner')).toBeUndefined();
  });

  it('does not re-show the banner once dismissed this session, even if still pending', () => {
    updateLegacyMachineOptionsBanner({ legacyMachineOptionsPending: true });
    expect(doc.getElementById('glpLegacyMachineOptionsBanner')).toBeDefined();

    sessionStorage.setItem('glp_legacy_machine_options_banner_dismissed', '1');
    doc.getElementById('glpLegacyMachineOptionsBanner')!.remove();

    // Re-evaluate with a status-less call (uses last-known S.legacyMachineOptionsPending).
    updateLegacyMachineOptionsBanner();
    expect(doc.getElementById('glpLegacyMachineOptionsBanner')).toBeUndefined();
  });
});
