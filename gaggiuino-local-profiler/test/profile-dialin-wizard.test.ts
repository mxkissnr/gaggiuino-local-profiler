import { describe, it, expect, beforeEach, vi } from 'vitest';

// profile-dialin-wizard.js imports state.js/i18n.js/api/transport.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals needed so the module graph can be imported under vitest's node
// environment (same pattern as test/milk-deduct-gate.test.js and
// test/library-profile-editor.test.js).
// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the other typed fixtures use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { profileDialinOverride, openProfileDialinWizard, closeProfileDialinWizard, startProfileDialinFromList }
  = await import('../public-src/views/profile-dialin-wizard.js');

// _sendUpdatedProfile isn't exported — drive the race through
// profileDialinOverride(), the exported click handler that calls it.
// profileDialinOverride() reads its target value off #pdwOverrideInput
// synchronously (before any await), so a fake input whose .value we mutate
// between the two overlapping calls lets each call compute a distinct
// nextProfile, the same "fake minimal document" approach used elsewhere in
// this suite instead of pulling in jsdom.
function fakeDocument(overrideValue: string) {
  const input = { value: overrideValue };
  return {
    getElementById: (id: string) => (id === 'pdwOverrideInput' ? input : undefined),
    querySelectorAll: () => [],
  };
}

// state/index.ts types the session as Record<string, unknown>; name only the
// fields this test reads after the two racing calls settle.
interface DialinSessionView {
  profile: { waterTemperature: number };
  rounds: { appliedAdjustment: { delta: number } }[];
}

describe('profileDialinOverride / _sendUpdatedProfile (#521 race)', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    S.profileDialinSession = {
      profileId: 42,
      profile: { waterTemperature: 92 },
      rounds: [],
      reviewRound: {
        shotId: 1,
        score: 70,
        suggestion: {
          type: 'adjust', phaseIndex: null, field: 'waterTemperature',
          oldValue: 92, unit: 'C', reason: 'test_reason',
        },
      },
      pendingSymptoms: [],
      candidateShotId: null,
    };
  });

  it('the later-fired override call wins even when its PUT resolves before the earlier call\'s', async () => {
    let resolveA!: (value: Response) => void;
    let resolveB!: (value: Response) => void;
    const pA = new Promise<Response>(res => { resolveA = res; });
    const pB = new Promise<Response>(res => { resolveB = res; });
    fetchSpy.mockImplementationOnce(() => pA); // call A — fired first, target 94
    fetchSpy.mockImplementationOnce(() => pB); // call B — fired second (still while A pending), target 96

    g.document = fakeDocument('94');
    const callA = profileDialinOverride();

    g.document = fakeDocument('96');
    const callB = profileDialinOverride();

    // B (the later-fired call) resolves first...
    resolveB({ ok: true } as unknown as Response);
    await callB;
    // ...and A's stale response arrives after — it must not clobber B's write.
    resolveA({ ok: true } as unknown as Response);
    await callA;

    const session = S.profileDialinSession as unknown as DialinSessionView;
    expect(session.profile.waterTemperature).toBe(96);
    // Only B's round should have been recorded — A's write lost the race and
    // bailed out via `if (!ok) return;` before pushing its round.
    expect(session.rounds).toHaveLength(1);
    expect(session.rounds.at(0)?.appliedAdjustment.delta).toBe(4); // 96 - 92
  });
});

// The 3s poll re-renders the whole modal, which would clear a manual override
// value already typed into #pdwOverrideInput. The poll must hold the render back
// until the input is empty again.
describe('profile dial-in poll holds back while the override input has a value', () => {
  let renders = 0;

  function pollDocument(input: { value: string }): Record<string, unknown> {
    const modal = { classList: { add: () => {}, remove: () => {} }, style: {} as Record<string, string> };
    const body = {
      get innerHTML(): string { return ''; },
      set innerHTML(_value: string) { renders++; },
    };
    return {
      activeElement: null,
      getElementById: (id: string) => {
        if (id === 'pdwOverrideInput') return input;
        if (id === 'pdwBody') return body;
        if (id === 'profileDialinWizardModal') return modal;
        return undefined;
      },
      querySelectorAll: () => [],
    };
  }

  it('skips the re-render while the override holds a value, renders once it is cleared', async () => {
    vi.useFakeTimers();
    renders = 0;
    try {
      const input = { value: '' };
      g.document = pollDocument(input);
      S.profileDialinSession = {
        id: 1, startedAt: 1, profileId: 42, profileName: 'P',
        profile: { id: 42, name: 'P', phases: [] },
        rounds: [],
        reviewRound: {
          shotId: 1, score: 70,
          suggestion: {
            type: 'adjust', phaseIndex: null, field: 'waterTemperature',
            oldValue: 92, newValue: 94, unit: 'C', reason: 'test_reason',
          },
        },
        pendingSymptoms: [], candidateShotId: null, dismissedShotIds: [], awaitingShotSince: 0,
        status: 'active',
      };

      openProfileDialinWizard({ id: 42, name: 'P', phases: [] });
      const afterOpen = renders;
      expect(afterOpen).toBeGreaterThan(0);

      input.value = '94';
      await vi.advanceTimersByTimeAsync(3000);
      expect(renders).toBe(afterOpen);

      input.value = '';
      await vi.advanceTimersByTimeAsync(3000);
      expect(renders).toBe(afterOpen + 1);
    } finally {
      closeProfileDialinWizard();
      vi.useRealTimers();
    }
  });
});

// #1605: a dial-in started from the profile list must target the machine the
// list was showing (the active machine) — both the profile GET and every round
// PUT — even if the active machine changes mid-session.
describe('profile dial-in captures the machine it was started for (#1605)', () => {
  function dialinDocument(overrideValue: string): Record<string, unknown> {
    const input = { value: overrideValue };
    const modal = { classList: { add: () => {}, remove: () => {} }, style: {} as Record<string, string> };
    return {
      // #pdwBody absent -> renderProfileDialinWizard() bails on the first lookup.
      getElementById: (id: string) => {
        if (id === 'pdwOverrideInput') return input;
        if (id === 'profileDialinWizardModal') return modal;
        return undefined;
      },
      querySelectorAll: () => [],
    };
  }

  // The two requests the wizard makes against the machine: GET the full profile
  // (startProfileDialinFromList), then PUT one round's adjustment
  // (profileDialinOverride, which calls the unexported _sendUpdatedProfile).
  async function startAndSendOneRound(): Promise<void> {
    g.document = dialinDocument('94');
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 42, name: 'Turbo', waterTemperature: 92, phases: [] }),
    } as unknown as Response);
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);

    await startProfileDialinFromList(42);
    S.profileDialinSession!.reviewRound = {
      shotId: 1, score: 70,
      suggestion: {
        type: 'adjust', phaseIndex: null, field: 'waterTemperature',
        oldValue: 92, unit: 'C', reason: 'test_reason',
      },
    };
    await profileDialinOverride();
    closeProfileDialinWizard();
  }

  beforeEach(() => {
    fetchSpy.mockReset();
    S.profileDialinSession = null;
  });

  it('carries machineId on the profile GET and the round PUT when a machine is active', async () => {
    S.activeMachineId = 2;
    await startAndSendOneRound();

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('api/machine/profile/42?machineId=2');
    const put = fetchSpy.mock.calls[1];
    expect(String(put?.[0])).toBe('api/machine/profile/42');
    const body = JSON.parse((put?.[1] as RequestInit).body as string) as { machineId?: number };
    expect(body.machineId).toBe(2);
  });

  it("carries no machineId when the active machine is 'all'", async () => {
    S.activeMachineId = 'all';
    await startAndSendOneRound();

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('api/machine/profile/42');
    const put = fetchSpy.mock.calls[1];
    const body = JSON.parse((put?.[1] as RequestInit).body as string) as Record<string, unknown>;
    expect('machineId' in body).toBe(false);
  });
});
