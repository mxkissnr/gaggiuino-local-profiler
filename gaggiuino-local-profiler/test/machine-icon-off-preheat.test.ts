// #1383: a preheat event carries no reachability of its own, so it must not
// drop the last live message and re-light the machine icon while the machine
// is known to be off. Covers the Live view's own wiring (views/live.js);
// the topbar instance is covered in topbar-machine-icon-selected-machine.test.js.
import { describe, it, expect, beforeEach } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the sibling live tests use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { syncMachineIcon, updatePreheatWidget } = await import('../public-src/views/live.js');

const state = S as unknown as Record<string, unknown>;

function makeHost() {
  const cls = new Set<string>();
  return {
    set className(_v: string) { cls.clear(); },
    firstChild: null as unknown,
    classList: {
      add: (...c: string[]) => c.forEach(x => cls.add(x)),
      remove: (...c: string[]) => c.forEach(x => cls.delete(x)),
    },
    querySelector: () => null,
    set innerHTML(_v: string) { this.firstChild = {}; },
    has: (c: string) => cls.has(c),
  };
}

function makeZombie() {
  return {
    className: '', textContent: '', style: {} as Record<string, string>,
    firstChild: null as unknown,
    classList: { add() {}, remove() {}, contains: () => false },
    querySelector: () => null,
  };
}

function makeFakeDocument() {
  const registry = new Map<string, unknown>();
  registry.set('liveMachineIcon', makeHost());
  return {
    getElementById: (id: string): unknown => {
      if (!registry.has(id)) registry.set(id, makeZombie());
      return registry.get(id);
    },
  };
}

describe('Live view machine icon stays off through a preheat event (#1383)', () => {
  let host: ReturnType<typeof makeHost>;

  beforeEach(() => {
    const doc = makeFakeDocument();
    g.document = doc;
    host = doc.getElementById('liveMachineIcon') as ReturnType<typeof makeHost>;
    state.currentLang = 'en';
    state.machines = [{ id: 1, isDefault: true }];
    state.activeMachineId = 1;
  });

  it('an unreachable snapshot followed by a preheat update keeps the icon off', () => {
    syncMachineIcon({ machineReachable: false });
    expect(host.has('is-on')).toBe(false);

    updatePreheatWidget({ ready: false, remaining: 120, pct: 0 });
    expect(host.has('is-on')).toBe(false);
    expect(host.has('is-heating')).toBe(false);
  });
});
