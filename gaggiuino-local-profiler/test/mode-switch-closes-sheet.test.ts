import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1543: switching top-level tabs left an open bean detail sheet and/or the
// large flavour wheel from the old view hanging over the new one. switchMode
// now calls the two existing close helpers (reached via window, like its other
// cross-view calls) before switching. Minimal fake DOM/localStorage, same
// pattern as the other frontend tests.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

const { S } = await import('../public-src/state/index.js');
const { switchMode } = await import('../public-src/components/mode.js');

class FakeEl {
  style: Record<string, string> = {};
  classes = new Set<string>();
  classList = {
    add: (token: string): void => { this.classes.add(token); },
    remove: (token: string): void => { this.classes.delete(token); },
    toggle: (token: string, force?: boolean): void => {
      if (force === undefined ? this.classes.has(token) : !force) this.classes.delete(token);
      else this.classes.add(token);
    },
    contains: (token: string): boolean => this.classes.has(token),
  };
  closest(): FakeEl | null { return null; }
  contains(): boolean { return false; }
}

// Every id switchMode dereferences directly (btn* + #*-view); everything else
// (sidebar, bn* ids, …) may be absent and is optional-chained.
const DIRECT_IDS = [
  'btnShots', 'btnLive', 'btnAnalytics', 'btnDialin', 'btnLibrary',
  'btnMaintenance', 'btnAchievements', 'btnOrders', 'btnSettings',
  'shots-view', 'live-view', 'analytics-view', 'dialin-view', 'library-view',
  'maintenance-view', 'achievements-view', 'orders-view', 'settings-view',
];

function setup() {
  const nodes: Record<string, FakeEl> = {};
  for (const id of DIRECT_IDS) nodes[id] = new FakeEl();
  g.document = {
    getElementById: (id: string) => nodes[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const closeBeanSheet = vi.fn();
  const closeFlavorWheel = vi.fn();
  const target = g.window as Record<string, unknown>;
  target.closeBeanSheet = closeBeanSheet;
  target.closeFlavorWheel = closeFlavorWheel;
  target.flushAutoSave = vi.fn();
  return { nodes, closeBeanSheet, closeFlavorWheel };
}

describe('switching tabs closes the bean sheet and the flavour wheel (#1543)', () => {
  beforeEach(() => {
    S.currentMode = 'library';
  });

  it('closes both before switching to another tab', () => {
    const { closeBeanSheet, closeFlavorWheel } = setup();
    switchMode('live');
    expect(closeBeanSheet).toHaveBeenCalledTimes(1);
    expect(closeFlavorWheel).toHaveBeenCalledTimes(1);
    expect(S.currentMode).toBe('live');
  });

  it('still closes both when the target is the already-active tab', () => {
    const { closeBeanSheet, closeFlavorWheel } = setup();
    S.currentMode = 'analytics';
    switchMode('analytics');
    expect(closeBeanSheet).toHaveBeenCalledTimes(1);
    expect(closeFlavorWheel).toHaveBeenCalledTimes(1);
  });
});
