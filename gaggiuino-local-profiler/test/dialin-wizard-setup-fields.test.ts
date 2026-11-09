// #1960: the dial-in wizard's setup step shares its two library fields with
// the annotation panel and the pre-shot setup — a bean select filled by
// _renderBeanSelect() and the grinder select-with-"Other…" pair. A value that
// left the library survives setup and start, and the wizard keeps both the
// #1954 default grinder and its own first-grinder prefill.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installFakeOptionDom } from './helpers/fake-option-dom.js';
import type { FakeOption } from './helpers/fake-option-dom.js';

// Same bridge as test/dialin-wizard-default-grinder.test.ts: state/index.ts
// and i18n.ts read localStorage/navigator at module load.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

interface FakeEl {
  tagName: string;
  value: string;
  hidden: boolean;
  innerHTML: string;
  style: Record<string, string>;
  selectedOptions: { dataset: Record<string, string> }[];
  classList: { add: () => void; remove: () => void };
  setAttribute: (name: string, value: string) => void;
}

function makeEl(overrides: Partial<FakeEl> = {}): FakeEl {
  return {
    tagName: 'INPUT',
    value: '',
    hidden: false,
    innerHTML: '',
    style: {},
    selectedOptions: [{ dataset: {} }],
    classList: { add() {}, remove() {} },
    setAttribute: () => {},
    ...overrides,
  };
}

// The fake select from the shared helper captures replaceChildren()'s options;
// the fields dialinAcceptNext reads off it are added here.
interface BeanSelect {
  tagName: string;
  value: string;
  selectedOptions: { dataset: Record<string, string> }[];
  options?: unknown[];
}

function makeBeanSelect(): BeanSelect {
  return { tagName: 'SELECT', value: '', selectedOptions: [{ dataset: {} }] };
}

const { S } = await import('../public-src/state/index.js');
const { openDialinWizard, closeDialinWizard, dialinAcceptNext, dialinGrinderChange } =
  await import('../public-src/views/dialin-wizard.js');

interface SessionView {
  bean: string;
  beanId: number | null;
  grinder: string;
  status: string;
}

function session(): SessionView {
  if (!S.dialinSession) throw new Error('dialin session was not created');
  return S.dialinSession as unknown as SessionView;
}

function library(grinders: { name: string; isDefault?: boolean }[], beans: { id: number; name: string }[]) {
  return { grinders, beans } as unknown as typeof S.coffeeLibrary;
}

interface Dom {
  body: FakeEl;
  bean: BeanSelect;
  grinder: FakeEl;
  grinderOther: FakeEl;
}

function installDom(overrides: Record<string, unknown> = {}): Dom {
  const body = makeEl({ tagName: 'DIV' });
  const grinder = makeEl({ tagName: 'SELECT' });
  const grinderOther = makeEl();
  const bean = makeBeanSelect();
  const selects = installFakeOptionDom(['dwBean'], {
    dwBody: body,
    dwGrinder: grinder,
    dwGrinderOther: grinderOther,
    dwDose: makeEl({ value: '18' }),
    dwRatio: makeEl({ value: '2' }),
    dwStartGrind: makeEl({ value: '12' }),
    dialinWizardModal: makeEl({ tagName: 'DIV' }),
    ...overrides,
  });
  // The shared helper's select captures the rendered options; adding the read
  // fields to it makes it behave like a real <select> for dialinAcceptNext.
  // A caller that passes dwBean supplies the text input an empty library
  // renders instead, and the helper's select is then unused.
  const fakeSelect = selects.dwBean as unknown as BeanSelect | undefined;
  if (fakeSelect) Object.assign(fakeSelect, bean);
  const beanEl = (overrides.dwBean as BeanSelect | undefined) ?? fakeSelect;
  if (!beanEl) throw new Error('missing fake #dwBean');
  return { body, bean: beanEl, grinder, grinderOther };
}

function optionsOf(select: BeanSelect): FakeOption[] {
  return (select.options ?? []) as FakeOption[];
}

// dialinAcceptNext reads the chosen option's data-bean-id off the select.
function chooseBean(dom: Dom, name: string, beanId?: number): void {
  dom.bean.value = name;
  dom.bean.selectedOptions = [{ dataset: beanId == null ? {} : { beanId: String(beanId) } }];
}

describe('dial-in wizard setup fields (#1960)', () => {
  beforeEach(() => {
    S.dialinSession = null;
    S.shots = [] as unknown as typeof S.shots;
    S.coffeeLibrary = library([{ name: 'Grinder X' }], [{ id: 1, name: 'Bean A' }]);
  });

  afterEach(() => {
    closeDialinWizard();
    S.dialinSession = null;
  });

  it('keeps a bean and a grinder that are outside the library', () => {
    const dom = installDom();

    openDialinWizard({ beanName: 'Mystery Bean', grinderName: 'Presto' });

    // The stale bean is its own option, after the library beans.
    expect(optionsOf(dom.bean).map(o => o.value)).toEqual(['', 'Bean A', 'Mystery Bean']);
    expect(optionsOf(dom.bean)[2]?.selected).toBe(true);

    // The unknown grinder sits under "Other…", its name in the text input.
    expect(dom.grinder.innerHTML).toContain('<option value="__other__" selected>');
    expect(dom.grinder.value).toBe('__other__');
    expect(dom.grinderOther.value).toBe('Presto');
    expect(dom.grinderOther.style.display).toBe('');

    chooseBean(dom, 'Mystery Bean');
    dialinAcceptNext();

    expect(session().bean).toBe('Mystery Bean');
    expect(session().beanId).toBeNull();
    expect(session().grinder).toBe('Presto');
    expect(session().status).toBe('active');
  });

  it('takes the bean id from the chosen option', () => {
    const dom = installDom();
    openDialinWizard({ beanName: 'Bean A', beanId: 1 });

    chooseBean(dom, 'Bean A', 1);
    dialinAcceptNext();

    expect(session().bean).toBe('Bean A');
    expect(session().beanId).toBe(1);
    expect(session().status).toBe('active');
  });

  it('selects the flagged default grinder when the wizard opens', () => {
    const dom = installDom();
    S.coffeeLibrary = library(
      [{ name: 'Old Grinder' }, { name: 'New Grinder', isDefault: true }],
      [{ id: 1, name: 'Bean A' }],
    );

    openDialinWizard({ beanName: 'Bean A', beanId: 1 });

    expect(session().grinder).toBe('New Grinder');
    expect(dom.grinder.innerHTML).toContain('<option value="New Grinder" selected>');
    expect(dom.grinder.value).toBe('New Grinder');
    expect(dom.grinderOther.style.display).toBe('none');

    chooseBean(dom, 'Bean A', 1);
    dialinAcceptNext();

    expect(session().grinder).toBe('New Grinder');
  });

  it('preselects the first library grinder when the session names none', () => {
    const dom = installDom();
    S.coffeeLibrary = library([{ name: 'Grinder X' }, { name: 'Grinder Y' }], [{ id: 1, name: 'Bean A' }]);

    openDialinWizard();

    expect(session().grinder).toBe('');
    expect(dom.grinder.innerHTML).toContain('<option value="Grinder X" selected>');

    chooseBean(dom, 'Bean A', 1);
    dialinAcceptNext();

    expect(session().grinder).toBe('Grinder X');
    expect(session().status).toBe('active');
  });

  it('falls back to text inputs when the library has no beans or grinders', () => {
    const typedBean = makeEl({ tagName: 'INPUT' });
    const dom = installDom({ dwBean: typedBean });
    S.coffeeLibrary = library([], []);

    openDialinWizard();

    expect(dom.body.innerHTML).toContain('<input type="text" id="dwBean"');
    expect(dom.grinder.hidden).toBe(true);

    typedBean.value = 'Typed Bean';
    dom.grinderOther.value = 'Niche';
    dialinAcceptNext();

    expect(session().bean).toBe('Typed Bean');
    expect(session().beanId).toBeNull();
    expect(session().grinder).toBe('Niche');
    expect(session().status).toBe('active');
  });

  it('renders no datalist in the setup step', () => {
    const dom = installDom();
    openDialinWizard({ beanName: 'Bean A', beanId: 1 });

    expect(dom.body.innerHTML).not.toContain('datalist');
  });

  it('shows the free-text grinder input only for "Other…"', () => {
    const dom = installDom();
    openDialinWizard({ beanName: 'Bean A', beanId: 1 });

    dom.grinder.value = '__other__';
    dialinGrinderChange();
    expect(dom.grinderOther.style.display).toBe('');

    dom.grinder.value = 'Grinder X';
    dialinGrinderChange();
    expect(dom.grinderOther.style.display).toBe('none');
  });
});
