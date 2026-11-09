// #1961 slice 6: the guide dial-in wizard's two grind entries (the setup
// step's start grind and the review step's override) share the grind field
// with the annotation panel and the pre-shot setup — a dropdown of valid
// clicks on a stepped grinder, a validated number on a stepless one, and the
// unchanged free-text field without a scale.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeOptionDom } from './helpers/fake-option-dom.js';
import type { FakeOption } from './helpers/fake-option-dom.js';
import type { GrindScale } from '../public-src/grind-scale.js';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

type Handler = () => void;

interface FakeEl {
  tagName: string;
  value: string;
  hidden: boolean;
  innerHTML: string;
  textContent: string;
  style: Record<string, string>;
  selectedOptions: { dataset: Record<string, string> }[];
  classList: { add: () => void; remove: () => void };
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  focus: () => void;
  addEventListener: (name: string, cb: Handler) => void;
  options?: unknown[];
  onchange?: (() => void) | null;
}

function makeEl(overrides: Partial<FakeEl> = {}): FakeEl {
  return {
    tagName: 'INPUT',
    value: '',
    hidden: false,
    innerHTML: '',
    textContent: '',
    style: {},
    selectedOptions: [{ dataset: {} }],
    classList: { add() {}, remove() {} },
    setAttribute: () => {},
    removeAttribute: () => {},
    focus: () => {},
    addEventListener: () => {},
    ...overrides,
  };
}

const { S } = await import('../public-src/state/index.js');
const { openDialinWizard, closeDialinWizard, renderDialinWizard, dialinAcceptNext,
        dialinGrinderChange, dialinOverride } = await import('../public-src/views/dialin-wizard.js');
const { createWizardSession } = await import('../public-src/views/wizard-session.js');

interface SessionView {
  grinder: string;
  status: string;
  pendingGrind: number | string;
  reviewRound: unknown;
  rounds: { grindSetting: number }[];
}

function session(): SessionView {
  if (!S.dialinSession) throw new Error('dialin session was not created');
  return S.dialinSession as unknown as SessionView;
}

const STEPPED_0_60: GrindScale = { type: 'stepped', min: 0, max: 60, step: 1 };
const STEPLESS_0_9: GrindScale = { type: 'stepless', min: 0, max: 9, step: 0.1 };

interface TestGrinder { name: string; isDefault?: boolean; scale?: GrindScale }

function library(grinders: TestGrinder[]): void {
  S.coffeeLibrary = { grinders, beans: [{ id: 1, name: 'Bean A' }] } as unknown as typeof S.coffeeLibrary;
}

interface Dom {
  body: FakeEl;
  bean: FakeEl;
  grinder: FakeEl;
  grinderOther: FakeEl;
  start: FakeEl;
  startSelect: FakeEl;
  startHint: FakeEl;
  override: FakeEl;
  overrideSelect: FakeEl;
  overrideHint: FakeEl;
}

function installDom(): Dom {
  const body = makeEl({ tagName: 'DIV' });
  const bean = makeEl({ tagName: 'SELECT', value: 'Bean A', selectedOptions: [{ dataset: { beanId: '1' } }] });
  const grinder = makeEl({ tagName: 'SELECT' });
  const grinderOther = makeEl();
  const start = makeEl();
  const startHint = makeEl({ hidden: true });
  const override = makeEl();
  const overrideHint = makeEl({ hidden: true });
  const selects = installFakeOptionDom(['dwBean', 'grindSelect-dwStartGrind', 'grindSelect-dwOverrideInput'], {
    dwBody: body,
    dwGrinder: grinder,
    dwGrinderOther: grinderOther,
    dwDose: makeEl({ value: '18' }),
    dwRatio: makeEl({ value: '2' }),
    dwStartGrind: start,
    'grindHint-dwStartGrind': startHint,
    dwOverrideInput: override,
    'grindHint-dwOverrideInput': overrideHint,
    dialinWizardModal: makeEl({ tagName: 'DIV' }),
  });
  // The bean select needs the fields dialinAcceptNext reads off it; the
  // helper's fake select already has replaceChildren().
  Object.assign(selects.dwBean as unknown as FakeEl, bean);
  // The grind field's companions are static markup: both start hidden.
  const startSelect = selects['grindSelect-dwStartGrind'] as unknown as FakeEl;
  const overrideSelect = selects['grindSelect-dwOverrideInput'] as unknown as FakeEl;
  Object.assign(startSelect, makeEl({ tagName: 'SELECT', hidden: true }));
  Object.assign(overrideSelect, makeEl({ tagName: 'SELECT', hidden: true }));
  // renderGrindField assigns select.onchange, so the fakes have to keep it.
  Object.assign(startSelect, { onchange: null });
  Object.assign(overrideSelect, { onchange: null });
  const doc = g.document as { activeElement: unknown };
  doc.activeElement = null;
  return { body, bean, grinder, grinderOther, start, startSelect, startHint,
           override, overrideSelect, overrideHint };
}

function optionsOf(select: FakeEl): FakeOption[] {
  return (select.options ?? []) as FakeOption[];
}

function setLibrary(): void {
  S.coffeeLibrary = { grinders: [{ name: 'K6', scale: STEPPED_0_60 }], beans: [{ id: 1, name: 'Bean A' }] } as unknown as typeof S.coffeeLibrary;
}

function reviewSession(grinder: string): void {
  S.dialinSession = {
    id: 1,
    startedAt: Date.now(),
    bean: 'Bean A',
    beanId: 1,
    grinder,
    dose: 18,
    targetRatio: 2,
    recipeId: null,
    startGrind: 8,
    rounds: [],
    pendingGrind: 8,
    candidateShotId: null,
    reviewRound: {
      grindSetting: 8,
      shotId: 42,
      score: 70,
      seconds: 20,
      ratio: null,
      channeling: false,
      suggestion: { type: 'finer', nextGrind: 7, delta: -1, reason: 'dialin_suggest_finer', band: { low: 25, high: 32 } },
    },
    awaitingShotSince: null,
    status: 'active',
  };
}

describe('the dial-in wizard start grind on a grinder scale (#1961)', () => {
  beforeEach(() => {
    S.dialinSession = null;
    S.shots = [];
    library([{ name: 'K6', scale: STEPPED_0_60 }]);
  });

  afterEach(() => {
    closeDialinWizard();
    S.dialinSession = null;
  });

  it('shows the suggested start as a dropdown of valid clicks', () => {
    const dom = installDom();

    openDialinWizard({ beanName: 'Bean A', beanId: 1, startGrind: 33.5 });

    expect(dom.startSelect.hidden).toBe(false);
    expect(dom.start.hidden).toBe(true);
    expect(dom.startSelect.value).toBe('34');
    expect(optionsOf(dom.startSelect).map(o => o.value)).toContain('34');

    dialinAcceptNext();

    expect(session().pendingGrind).toBe('34');
    expect(session().status).toBe('active');
  });

  it('leaves the field empty for a suggestion outside the range', () => {
    const dom = installDom();

    openDialinWizard({ beanName: 'Bean A', beanId: 1, startGrind: 70 });

    expect(dom.startSelect.hidden).toBe(false);
    expect(dom.startSelect.value).toBe('');
  });

  it('rejects an out-of-range number on a stepless grinder and starts on a comma decimal', () => {
    library([{ name: 'Lagom', scale: STEPLESS_0_9 }]);
    const dom = installDom();
    openDialinWizard({ beanName: 'Bean A', beanId: 1, startGrind: 5 });

    expect(dom.start.hidden).toBe(false);
    expect(dom.startSelect.hidden).toBe(true);

    dom.start.value = '12';
    dialinAcceptNext();
    expect(session().status).toBe('setup');
    expect(dom.startHint.hidden).toBe(false);

    dom.start.value = '8,3';
    dialinAcceptNext();
    expect(session().status).toBe('active');
    expect(session().pendingGrind).toBe('8.3');
  });

  it('swaps the control when the setup grinder changes', () => {
    library([{ name: 'K6', scale: STEPPED_0_60 }, { name: 'Niche' }]);
    const dom = installDom();
    openDialinWizard({ beanName: 'Bean A', beanId: 1, startGrind: 34 });
    expect(dom.startSelect.hidden).toBe(false);

    dom.grinder.value = 'Niche';
    dialinGrinderChange();
    expect(dom.startSelect.hidden).toBe(true);
    expect(dom.start.hidden).toBe(false);
    expect(dom.start.value).toBe('34');

    dom.grinder.value = 'K6';
    dialinGrinderChange();
    expect(dom.startSelect.hidden).toBe(false);
    expect(dom.start.hidden).toBe(true);
    expect(dom.startSelect.value).toBe('34');
  });

  it('keeps the free-text field for a grinder without a scale', () => {
    library([{ name: 'Niche' }]);
    const dom = installDom();
    openDialinWizard({ beanName: 'Bean A', beanId: 1, startGrind: '1.2.3' });

    expect(dom.start.hidden).toBe(false);
    expect(dom.startSelect.hidden).toBe(true);

    dom.start.value = '1.2.3';
    dialinAcceptNext();

    expect(session().pendingGrind).toBe('1.2.3');
    expect(session().status).toBe('active');
  });
});

describe('the dial-in wizard override on a grinder scale (#1961)', () => {
  beforeEach(() => {
    S.dialinSession = null;
    S.shots = [];
    setLibrary();
  });

  afterEach(() => {
    closeDialinWizard();
    S.dialinSession = null;
  });

  it('sets the pending grind from a picked click on a stepped grinder', () => {
    const dom = installDom();
    reviewSession('K6');

    renderDialinWizard();

    expect(dom.overrideSelect.hidden).toBe(false);
    expect(dom.override.hidden).toBe(true);

    dom.overrideSelect.value = '3';
    dom.overrideSelect.onchange?.();
    dialinOverride();

    expect(session().pendingGrind).toBe('3');
    expect(session().reviewRound).toBeNull();
  });

  it('rejects an out-of-range override on a stepless grinder', () => {
    library([{ name: 'Lagom', scale: STEPLESS_0_9 }]);
    const dom = installDom();
    reviewSession('Lagom');

    renderDialinWizard();
    expect(dom.override.hidden).toBe(false);
    expect(dom.overrideSelect.hidden).toBe(true);

    dom.override.value = '12';
    dialinOverride();

    expect(session().reviewRound).not.toBeNull();
    expect(session().rounds).toEqual([]);
    expect(dom.overrideHint.hidden).toBe(false);
  });

  it('keeps the free-text override for a grinder without a scale', () => {
    library([{ name: 'Niche' }]);
    const dom = installDom();
    reviewSession('Niche');

    renderDialinWizard();
    dom.override.value = '1.2.3';
    dialinOverride();

    expect(session().pendingGrind).toBe('1.2.3');
    expect(session().reviewRound).toBeNull();
  });
});

describe('the poll guard and the override dropdown (#1961)', () => {
  beforeEach(() => { S.dialinSession = null; });

  afterEach(() => { S.dialinSession = null; });

  it('holds the poll back while the override select is focused', () => {
    const dom = installDom();
    const wizard = createWizardSession<Record<string, unknown>, unknown>({
      stateKey: 'dialinSession',
      storageKey: 'glp_dialin_session',
      overrideInputId: 'dwOverrideInput',
      onTick: () => {},
    });

    expect(wizard.overrideHasValue()).toBe(false);

    (g.document as { activeElement: unknown }).activeElement = dom.overrideSelect;
    expect(wizard.overrideHasValue()).toBe(true);

    (g.document as { activeElement: unknown }).activeElement = dom.override;
    expect(wizard.overrideHasValue()).toBe(false);
  });
});
