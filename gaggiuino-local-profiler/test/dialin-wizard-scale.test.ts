// #1961 slice 3: the wizard reads the grinder's scale fresh on every action, so
// editing the scale mid-session changes the next pending grind at once.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const modalStub = (): { classList: { add: () => void; remove: () => void }; style: Record<string, string> } => ({
  classList: { add() {}, remove() {} },
  style: {},
});
// No #dwBody: the renderer returns early, so the action under test is all that runs.
g.document = {
  getElementById: (id: string) => (id === 'dialinWizardModal' ? modalStub() : null),
};

const { S } = await import('../public-src/state/index.js');
const { dialinAcceptNext } = await import('../public-src/views/dialin-wizard.js');
const { calcNextGrindSuggestion } = await import('../public-src/dialin-convergence.js');

const GRINDER = 'Lagom';
const REVIEW_GRIND = 8.3;
const STEPLESS = { type: 'stepless', min: 0, max: 9, step: 0.1 };
const STEPPED = { type: 'stepped', min: 0, max: 60, step: 1 };

interface SessionView {
  grinder: string;
  pendingGrind: number | string;
  rounds: { grindSetting: number; seconds: number }[];
  reviewRound: { grindSetting: number; seconds: number; shotId: number; score: number | null; ratio: number | null; channeling: boolean; suggestion?: { nextGrind: number | null } };
}

// A session already waiting on confirmation of one 20 s shot at 8.3 — a fast
// shot, so the next suggestion asks finer.
function startSession(scale: unknown): SessionView {
  S.coffeeLibrary = { grinders: [{ name: GRINDER, isDefault: true, scale }], beans: [] } as unknown as typeof S.coffeeLibrary;
  const session = {
    id: Date.now(),
    startedAt: Date.now(),
    bean: 'Bean A',
    beanId: 1,
    grinder: GRINDER,
    dose: 18,
    targetRatio: 2,
    recipeId: null,
    startGrind: REVIEW_GRIND,
    rounds: [],
    pendingGrind: REVIEW_GRIND,
    candidateShotId: null,
    reviewRound: {
      grindSetting: REVIEW_GRIND,
      shotId: 42,
      score: 70,
      seconds: 20,
      ratio: null,
      channeling: false,
    },
    awaitingShotSince: null,
    status: 'active',
  };
  S.dialinSession = session as unknown as typeof S.dialinSession;
  return session as unknown as SessionView;
}

describe('dial-in wizard steps on a grinder scale (#1961)', () => {
  beforeEach(() => { S.dialinSession = null; });

  afterEach(() => { S.dialinSession = null; });

  it('moves a 0..9 dial in 0.1 steps, a small move from the last round', () => {
    const session = startSession(STEPLESS);
    dialinAcceptNext();
    const pending = Number(session.pendingGrind);
    expect(Math.abs(pending * 10 - Math.round(pending * 10))).toBeLessThan(1e-9);
    const move = Math.abs(pending - REVIEW_GRIND);
    expect(move).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(move).toBeLessThanOrEqual(0.4 + 1e-9);
  });

  it('gives a different, whole-number step after the scale changes to 0..60 stepped', () => {
    const session = startSession(STEPLESS);
    dialinAcceptNext();
    const onStepless = Number(session.pendingGrind);

    const changed = startSession(STEPPED);
    dialinAcceptNext();
    const onStepped = Number(changed.pendingGrind);

    expect(Number.isInteger(onStepped)).toBe(true);
    expect(onStepped).not.toBe(onStepless);
  });

  it('without a scale, keeps the old suggestion untouched', () => {
    const session = startSession(undefined);
    const rounds = [session.reviewRound];
    dialinAcceptNext();
    expect(session.pendingGrind).toBe(calcNextGrindSuggestion(rounds).nextGrind);
  });
});
