// #1954 — once the library names a default grinder, the guided dial-in
// wizard must not leak another grinder's numbers or another bean's: both
// prefill sources it used before (the bean's best combo on any grinder, and
// the last shot on the chosen grinder for any bean) are only safe while no
// grinder is designated. Without a default the wizard keeps its old result,
// which the last case here pins.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Same bridge as the sibling tests: state/index.ts and i18n.ts read
// localStorage/navigator at module load, and renderDialinWizard() returns
// early unless #dwBody exists — a modal-only fake document is enough.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const modalStub = (): { classList: { add: () => void; remove: () => void }; style: Record<string, string> } => ({
  classList: { add() {}, remove() {} },
  style: {},
});
g.document = {
  getElementById: (id: string) => (id === 'dialinWizardModal' ? modalStub() : null),
};

const { S } = await import('../public-src/state/index.js');
const { openDialinWizard, closeDialinWizard } = await import('../public-src/views/dialin-wizard.js');

interface SessionView {
  grinder: string;
  startGrind: number | string;
  pendingGrind: number | string;
}

function session(): SessionView {
  if (!S.dialinSession) throw new Error('dialin session was not created');
  return S.dialinSession as unknown as SessionView;
}

// Shots only need the annotation fields the grind module reads; .score is
// preferred by calcShotScore(), so no curve/datapoints are required.
const shot = (coffee: string, grinder: string, grindSetting: string, score: number, timestamp: number) => ({
  timestamp,
  score,
  annotation: { coffee, grinder, grindSetting, dose: '18' },
});

function library(grinders: { name: string; isDefault?: boolean }[], beans: unknown[]) {
  return { grinders, beans } as unknown as typeof S.coffeeLibrary;
}

function shots(value: unknown[]) {
  return value as unknown as typeof S.shots;
}

describe('dial-in wizard start grind with a default grinder (#1954)', () => {
  beforeEach(() => {
    S.dialinSession = null;
    S.shots = shots([]);
  });

  afterEach(() => {
    closeDialinWizard();
    S.dialinSession = null;
  });

  it('uses the default grinder and leaves the start grind empty when only another grinder is known', () => {
    S.coffeeLibrary = library(
      [{ name: 'Old Grinder' }, { name: 'New Grinder', isDefault: true }],
      [{
        id: 1,
        name: 'Bean A',
        knownGrindSettings: [{ grinder: 'Old Grinder', grindSetting: '12' }],
      }],
    );

    openDialinWizard({ beanName: 'Bean A', beanId: 1 });

    expect(session().grinder).toBe('New Grinder');
    expect(session().startGrind).toBe('');
    expect(session().pendingGrind).toBe('');
  });

  it('does not take another bean\'s shot on the default grinder as the start grind', () => {
    S.coffeeLibrary = library(
      [{ name: 'Old Grinder' }, { name: 'New Grinder', isDefault: true }],
      [{ id: 1, name: 'Bean A' }, { id: 2, name: 'Bean B' }],
    );
    S.shots = shots([
      shot('Bean B', 'New Grinder', '24', 95, 100),
      shot('Bean B', 'New Grinder', '24', 95, 200),
      shot('Bean B', 'New Grinder', '24', 95, 300),
    ]);

    openDialinWizard({ beanName: 'Bean A', beanId: 1 });

    expect(session().grinder).toBe('New Grinder');
    expect(session().startGrind).toBe('');
    expect(session().pendingGrind).toBe('');
  });

  it('takes the bean\'s known setting for the default grinder', () => {
    S.coffeeLibrary = library(
      [{ name: 'Old Grinder' }, { name: 'New Grinder', isDefault: true }],
      [{
        id: 1,
        name: 'Bean A',
        knownGrindSettings: [
          { grinder: 'Old Grinder', grindSetting: '12' },
          { grinder: 'New Grinder', grindSetting: '24' },
        ],
      }],
    );

    openDialinWizard({ beanName: 'Bean A', beanId: 1 });

    expect(session().grinder).toBe('New Grinder');
    expect(session().startGrind).toBe(24);
    expect(session().pendingGrind).toBe(24);
  });

  it('without a default keeps today\'s first known entry and best combo', () => {
    S.coffeeLibrary = library(
      [{ name: 'Old Grinder' }, { name: 'New Grinder' }],
      [{
        id: 1,
        name: 'Bean A',
        knownGrindSettings: [{ grinder: 'Old Grinder', grindSetting: '12' }],
      }],
    );
    S.shots = shots([
      shot('Bean A', 'New Grinder', '24', 80, 100),
      shot('Bean A', 'New Grinder', '24', 80, 200),
      shot('Bean A', 'New Grinder', '24', 80, 300),
      shot('Bean A', 'Old Grinder', '12', 95, 400),
    ]);

    openDialinWizard({ beanName: 'Bean A', beanId: 1 });

    // No default: the first known entry names the grinder, and the
    // best-scoring combo wins for the start grind, as before #1954.
    expect(session().grinder).toBe('Old Grinder');
    expect(session().startGrind).toBe(24);
  });

  it('sets the default grinder but no start grind for a bean-less session', () => {
    S.coffeeLibrary = library(
      [{ name: 'New Grinder', isDefault: true }],
      [],
    );

    openDialinWizard();

    expect(session().grinder).toBe('New Grinder');
    expect(session().startGrind).toBe('');
    expect(session().pendingGrind).toBe('');
  });

  // #1960: the setup step now fills its two library fields through the DOM
  // (_fillSetupFields) instead of rendering them as one markup string. This
  // file's fake document is the one place the setup step renders against a
  // page with no field elements, so pin that the new path handles them
  // missing: the wizard must still open and keep the flagged grinder.
  it('keeps the default grinder when the setup field elements are missing', () => {
    const body: { innerHTML: string } = { innerHTML: '' };
    g.document = {
      getElementById: (id: string) => {
        if (id === 'dialinWizardModal') return modalStub();
        if (id === 'dwBody') return body;
        return null;
      },
    };
    try {
      S.coffeeLibrary = library(
        [{ name: 'Old Grinder' }, { name: 'New Grinder', isDefault: true }],
        [{ id: 1, name: 'Bean A' }],
      );

      expect(() => openDialinWizard({ beanName: 'Bean A', beanId: 1 })).not.toThrow();
      expect(session().grinder).toBe('New Grinder');
      // The setup step did render, so _fillSetupFields really ran.
      expect(body.innerHTML).toContain('dwGrinder');
    } finally {
      g.document = {
        getElementById: (id: string) => (id === 'dialinWizardModal' ? modalStub() : null),
      };
    }
  });
});
