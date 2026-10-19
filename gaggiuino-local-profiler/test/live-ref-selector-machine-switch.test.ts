// #1759: switching the machine used to leave the Live tab's "Reference"
// dropdown listing the previous machine's shots, because the selector is
// only rebuilt when the Live tab is entered.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// machines-settings.ts reads localStorage at module import time; stub the
// browser globals the way the other machine-switch tests do.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

const win = globalThis as unknown as {
  populateRefSelector: ReturnType<typeof vi.fn>;
  connectLiveStream: ReturnType<typeof vi.fn>;
};

const { S } = await import('../public-src/state/index.js');
const { applyActiveMachineChange } = await import('../public-src/components/machines-settings.js');

// applyActiveMachineChange() fires a few unrelated follow-up requests
// (profile list, status poll); they only need to resolve cleanly.
g.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });

describe('reference dropdown follows a machine switch (#1759)', () => {
  beforeEach(() => {
    g.document = { getElementById: () => undefined, querySelectorAll: () => [] };
    S.allShots = [];
    S.activeMachineId = 2;
    win.populateRefSelector = vi.fn();
    win.connectLiveStream = vi.fn();
  });

  it('rebuilds the Live reference dropdown when the machine changes', () => {
    S.currentMode = 'live';

    applyActiveMachineChange();

    expect(win.populateRefSelector).toHaveBeenCalledTimes(1);
  });

  it('leaves the reference dropdown alone on other tabs', () => {
    S.currentMode = 'shots';

    applyActiveMachineChange();

    expect(win.populateRefSelector).not.toHaveBeenCalled();
  });
});
