// #662: one-time in-app banner pointing an upgrading install at Settings ->
// Machines while GET /api/status reports legacyMachineOptionsPending: true
// (see lib/machines/options-adoption.js's hasUnconfirmedLegacyMachineOptions(),
// covered separately in test/options-adoption.test.js). Fake DOM mirrors
// test/dev-banner.test.js's createElement/insertAdjacentElement pattern.
import { describe, it, expect, beforeEach } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };

const _sessionStore = new Map();
globalThis.sessionStorage = {
  getItem: k => (_sessionStore.has(k) ? _sessionStore.get(k) : null),
  setItem: (k, v) => { _sessionStore.set(k, String(v)); },
  removeItem: k => { _sessionStore.delete(k); },
};

const { S } = await import('../public-src/state.js');
const { updateLegacyMachineOptionsBanner } = await import('../public-src/components/onboarding.js');

function makeFakeDocument() {
  const registry = new Map();
  const body = { insertAdjacentElement: (_pos, el) => { registry.set(el.id, el); } };
  return {
    body,
    getElementById: id => registry.get(id),
    createElement: () => ({
      style: {}, textContent: '', append: () => {}, addEventListener: () => {},
      remove() { registry.delete(this.id); },
    }),
  };
}

describe('legacy machine options banner (#662)', () => {
  let doc;

  beforeEach(() => {
    doc = makeFakeDocument();
    globalThis.document = doc;
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
    doc.getElementById('glpLegacyMachineOptionsBanner').remove();

    // Re-evaluate with a status-less call (uses last-known S.legacyMachineOptionsPending).
    updateLegacyMachineOptionsBanner();
    expect(doc.getElementById('glpLegacyMachineOptionsBanner')).toBeUndefined();
  });
});
