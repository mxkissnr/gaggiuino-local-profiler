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
const { profileDialinOverride } = await import('../public-src/views/profile-dialin-wizard.js');

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
    expect(session.rounds[0].appliedAdjustment.delta).toBe(4); // 96 - 92
  });
});
