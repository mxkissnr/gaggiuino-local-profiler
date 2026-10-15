import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// wizard-session.ts imports state/index.ts (which reads localStorage and
// navigator at module load) and live-sync.ts, so stub the minimum browser
// globals to import the module graph under vitest's node environment (same
// pattern as test/profile-dialin-wizard.test.ts).
const g = globalThis as unknown as Record<string, unknown>;

const store = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string): string | null => store.get(key) ?? null,
  setItem: (key: string, value: string): void => { store.set(key, value); },
  removeItem: (key: string): void => { store.delete(key); },
};
g.localStorage = localStorageStub;
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { createWizardSession } = await import('../public-src/views/wizard-session.js');

interface TestSession extends Record<string, unknown> {
  status: string;
}

const setItemSpy = vi.spyOn(localStorageStub, 'setItem');
const removeItemSpy = vi.spyOn(localStorageStub, 'removeItem');

// Minimal document whose only field the wizard plumbing reads is the override
// input (plus activeElement for textEntryFocused()).
function fakeDocument(overrideValue: string | null) {
  const input = overrideValue === null ? null : { value: overrideValue };
  return {
    activeElement: null,
    getElementById: (id: string) => (id === 'dwOverrideInput' ? input : null),
  };
}

function makeWizard(onTick: () => void) {
  return createWizardSession<TestSession, unknown>({
    stateKey: 'dialinSession',
    storageKey: 'glp_dialin_session',
    overrideInputId: 'dwOverrideInput',
    onTick,
  });
}

describe('createWizardSession (#1622 shared wizard plumbing)', () => {
  beforeEach(() => {
    store.clear();
    setItemSpy.mockClear();
    removeItemSpy.mockClear();
    S.dialinSession = null;
    g.document = fakeDocument(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mirrors the session to its own localStorage key, and removes it when cleared', () => {
    const wizard = makeWizard(() => {});
    S.dialinSession = { status: 'active' };
    wizard.persist();
    expect(setItemSpy).toHaveBeenCalledWith('glp_dialin_session', JSON.stringify({ status: 'active' }));

    S.dialinSession = null;
    wizard.persist();
    expect(removeItemSpy).toHaveBeenCalledWith('glp_dialin_session');
  });

  it('startPoll replaces any running timer, stopPoll clears it', () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const wizard = makeWizard(onTick);
    S.dialinSession = { status: 'active' };

    wizard.startPoll();
    wizard.startPoll();
    vi.advanceTimersByTime(3000);
    expect(onTick).toHaveBeenCalledTimes(1);

    wizard.stopPoll();
    vi.advanceTimersByTime(3000);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('holds the poll back while a manual override value is present', () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const wizard = makeWizard(onTick);
    S.dialinSession = { status: 'active' };
    g.document = fakeDocument('7');

    expect(wizard.overrideHasValue()).toBe(true);
    wizard.startPoll();
    vi.advanceTimersByTime(3000);
    expect(onTick).not.toHaveBeenCalled();

    wizard.stopPoll();
  });
});
