// #1201: SSE live data describes the default machine only, so the topbar
// icon must ignore it while another machine is selected and follow the
// machine-scoped /api/status reachability instead.
import { describe, it, expect, beforeEach } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { renderTopbarMachineIcon, handleTopbarLiveSnapshotEvent, handleTopbarPreheatUpdateEvent, syncTopbarMachineIconFallback } =
  await import('../public-src/components/topbar-machine-icon.js');

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

describe('topbar machine icon follows the selected machine (#1201)', () => {
  let el: ReturnType<typeof makeHost>;
  const state = S as unknown as Record<string, unknown>;

  beforeEach(() => {
    el = makeHost();
    g.document = { getElementById: (id: string) => (id === 'topbarMachineIcon' ? el : null) };
    state.machines = [{ id: 1, isDefault: true }, { id: 2, isDefault: false }];
    state.activeMachineId = 1;
    state.sseActive = true;
    renderTopbarMachineIcon();
  });

  it('default machine: SSE snapshot drives the icon and the fallback stays out', () => {
    handleTopbarLiveSnapshotEvent({ isLive: true });
    expect(el.has('is-brewing')).toBe(true);
    syncTopbarMachineIconFallback(false);
    expect(el.has('is-brewing')).toBe(true);
  });

  it('non-default machine: SSE is ignored, the fallback drives the icon even with SSE active', () => {
    state.activeMachineId = 2;
    renderTopbarMachineIcon();
    handleTopbarLiveSnapshotEvent({ isLive: true });
    expect(el.has('is-brewing')).toBe(false);
    syncTopbarMachineIconFallback(true);
    expect(el.has('is-on')).toBe(true);
    syncTopbarMachineIconFallback(false);
    expect(el.has('is-on')).toBe(false);
  });

  it('switching back to the default re-applies the last snapshot', () => {
    handleTopbarLiveSnapshotEvent({ isLive: true });
    state.activeMachineId = 2;
    renderTopbarMachineIcon();
    syncTopbarMachineIconFallback(false);
    state.activeMachineId = 1;
    renderTopbarMachineIcon();
    expect(el.has('is-brewing')).toBe(true);
  });

  // #1383: a preheat event carries no reachability of its own, so it must not
  // drop the snapshot that already told us the machine is off.
  it('machine off: a preheat event does not re-light the icon', () => {
    handleTopbarLiveSnapshotEvent({ machineReachable: false });
    expect(el.has('is-on')).toBe(false);
    handleTopbarPreheatUpdateEvent({ ready: false, remaining: 120, pct: 0 });
    expect(el.has('is-on')).toBe(false);
    expect(el.has('is-heating')).toBe(false);
  });
});
