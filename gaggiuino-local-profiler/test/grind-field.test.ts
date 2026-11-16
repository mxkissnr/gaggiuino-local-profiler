import { describe, it, expect, beforeEach } from 'vitest';
import { FakeOption, FakeFragment } from './helpers/fake-option-dom.js';

// grind-field.ts pulls in state/index.ts (localStorage/navigator at module
// load) and i18n.ts, so stub the minimum before importing — the same approach
// best-grind-combo.test.ts uses.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const {
  checkGrindField, forgetGrindField, getGrindFieldValue, grindFieldInvalid,
  readGrinderScaleForm, refreshGrindField, renderGrindField, renderGrinderScaleForm,
  tidyGrindField,
} = await import('../public-src/views/shots/grind-field.js');

// `noUncheckedIndexedAccess` makes every index read optional; these narrow it.
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`missing element at index ${i}`);
  return v;
}

class FakeInput {
  value = '';
  hidden = false;
  textContent = '';
  readonly attrs: Record<string, string> = {};
  private markup = '';
  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  removeAttribute(name: string): void { delete this.attrs[name]; }
  get innerHTML(): string { return this.markup; }
  set innerHTML(value: string) { this.markup = value; }
}

class FakeSelect {
  value = '';
  hidden = false;
  innerHTML = '';
  options?: unknown[];
  onchange: (() => void) | null = null;
  replaceChildren(fragment: FakeFragment): void { this.options = fragment.children; }
}

// The grinder form's root: setting innerHTML in a browser creates the range
// inputs, so the fake does the same for the ids the markup carries.
class FakeRoot {
  onclick: ((e: unknown) => void) | null = null;
  markup = '';
  doc: FakeDocument;
  constructor(doc: FakeDocument) { this.doc = doc; }
  get innerHTML(): string { return this.markup; }
  // A browser creates the range inputs the markup carries; the fake does too.
  set innerHTML(value: string) {
    this.markup = value;
    for (const m of value.matchAll(/<input[^>]*id="([^"]*)"[^>]*value="([^"]*)"/g)) {
      const el = this.doc.els[m[1] ?? ''];
      if (el instanceof FakeInput) el.value = m[2] ?? '';
    }
  }
}

class FakeDocument {
  els: Record<string, unknown> = {};
  readonly lookups: string[] = [];
  activeElement: unknown = null;
  getElementById(id: string): unknown { this.lookups.push(id); return this.els[id] ?? null; }
  createDocumentFragment(): FakeFragment { return new FakeFragment(); }
  add<T>(id: string, el: T): T { this.els[id] = el; return el; }
}

const doc = new FakeDocument();
g.Option = FakeOption;
g.document = doc;

function inputEl(id: string): FakeInput {
  const el = doc.els[id];
  if (!(el instanceof FakeInput)) throw new Error(`no input ${id}`);
  return el;
}
function rootEl(id: string): FakeRoot {
  const el = doc.els[id];
  if (!(el instanceof FakeRoot)) throw new Error(`no root ${id}`);
  return el;
}
function optionsOf(select: FakeSelect): FakeOption[] { return (select.options ?? []) as FakeOption[]; }

// One plain text field plus the two optional companions the render path looks up.
function field(id: string): { input: FakeInput; select: FakeSelect; hint: FakeInput } {
  return {
    input: doc.add(id, new FakeInput()),
    select: doc.add(`grindSelect-${id}`, new FakeSelect()),
    hint: doc.add(`grindHint-${id}`, new FakeInput()),
  };
}

function setGrinder(scale: unknown, name = 'Niche'): void {
  S.coffeeLibrary = { beans: [], grinders: [{ name, scale }] };
}

const STEPPED_0_10 = { type: 'stepped', min: 0, max: 10, step: 1 };
const STEPLESS_0_9 = { type: 'stepless', min: 0, max: 9, step: 0.1 };

beforeEach(() => {
  doc.els = {};
  doc.lookups.length = 0;
  doc.activeElement = null;
  setGrinder(STEPPED_0_10);
});

describe('renderGrindField on a stepped grinder', () => {
  it('offers exactly the valid clicks', () => {
    const { input, select } = field('f1');
    setGrinder({ type: 'stepped', min: 0, max: 4, step: 1 });
    renderGrindField('f1', 'Niche', '2');
    expect(optionsOf(select).map(o => o.value)).toEqual(['', '0', '1', '2', '3', '4']);
    expect(input.hidden).toBe(true);
    expect(select.hidden).toBe(false);
  });

  it('selects a numerically matching click but reads the stored text back', () => {
    const { select } = field('f2');
    renderGrindField('f2', 'Niche', '8.0');
    expect(select.value).toBe('8');
    expect(getGrindFieldValue('f2')).toBe('8.0');
    select.value = '5';
    expect(getGrindFieldValue('f2')).toBe('5');
  });

  it('shows an off-list value as an extra top option and reads it back unchanged', () => {
    const { select } = field('f3');
    setGrinder({ type: 'stepped', min: 0, max: 40, step: 1 });
    renderGrindField('f3', 'Niche', '33.5');
    const opts = optionsOf(select);
    expect(at(opts, 1).value).toBe('33.5');
    expect(at(opts, 1).text).toBe('33.5 (not on this scale)');
    expect(select.value).toBe('33.5');
    expect(getGrindFieldValue('f3')).toBe('33.5');

    const second = field('f3b');
    renderGrindField('f3b', 'Niche', '33 clicks');
    expect(at(optionsOf(second.select), 1).value).toBe('33 clicks');
    expect(at(optionsOf(second.select), 1).text).toBe('33 clicks (not on this scale)');
    expect(getGrindFieldValue('f3b')).toBe('33 clicks');

    // The extra option belongs to that one value; the next shot does not see it.
    renderGrindField('f3', 'Niche', '34');
    expect(optionsOf(select).map(o => o.value)).not.toContain('33.5');
    expect(optionsOf(select)).toHaveLength(42);
  });

  it('never writes a stored value into markup', () => {
    const { input, select, hint } = field('f4');
    renderGrindField('f4', 'Niche', '<img src=x onerror=1>');
    for (const el of [input, select, hint]) expect(el.innerHTML).not.toContain('onerror');
    expect(at(optionsOf(select), 1).text).toContain('(not on this scale)');
    expect(select.value).toBe('<img src=x onerror=1>');
  });

  it('copies a picked click into the hidden input', () => {
    const { input, select } = field('f5');
    renderGrindField('f5', 'Niche', '2');
    select.value = '5';
    select.onchange?.();
    expect(input.value).toBe('5');
  });
});

describe('renderGrindField on a stepless grinder', () => {
  beforeEach(() => { setGrinder(STEPLESS_0_9); });

  it('rejects an out-of-range value and keeps the last good one', () => {
    const { input, hint } = field('s1');
    renderGrindField('s1', 'Niche', '5');
    expect(input.attrs.inputmode).toBe('decimal');
    input.value = '12';
    expect(grindFieldInvalid('s1')).toBe(true);
    checkGrindField('s1');
    expect(hint.textContent).toBe('Enter a value from 0 to 9 in steps of 0.1.');
    expect(hint.hidden).toBe(false);
    expect(getGrindFieldValue('s1')).toBe('5');
  });

  it('rejects a value off the step grid the same way', () => {
    const { input, hint } = field('s2');
    renderGrindField('s2', 'Niche', '5');
    input.value = '8.35';
    expect(grindFieldInvalid('s2')).toBe(true);
    checkGrindField('s2');
    expect(hint.textContent).toBe('Enter a value from 0 to 9 in steps of 0.1.');
    expect(getGrindFieldValue('s2')).toBe('5');
  });

  it('accepts a comma and tidies a valid entry on blur', () => {
    const { input } = field('s3');
    renderGrindField('s3', 'Niche', '');
    input.value = '8,3';
    expect(getGrindFieldValue('s3')).toBe('8.3');
    tidyGrindField('s3');
    expect(input.value).toBe('8.3');

    const second = field('s3b');
    renderGrindField('s3b', 'Niche', '');
    second.input.value = '8.0';
    expect(getGrindFieldValue('s3b')).toBe('8');
  });

  it('shows a stored out-of-range value and reads it back unchanged', () => {
    const { input } = field('s4');
    renderGrindField('s4', 'Niche', '12');
    expect(input.value).toBe('12');
    expect(grindFieldInvalid('s4')).toBe(false);
    expect(getGrindFieldValue('s4')).toBe('12');
  });

  it('leaves an empty field empty and valid', () => {
    const { input } = field('s5');
    renderGrindField('s5', 'Niche', '');
    expect(input.value).toBe('');
    expect(grindFieldInvalid('s5')).toBe(false);
    expect(getGrindFieldValue('s5')).toBe('');
  });
});

describe('renderGrindField without a scale', () => {
  beforeEach(() => { setGrinder(null); });

  it('round-trips free text and never looks up the select or the hint', () => {
    for (const [id, stored, expected] of [
      ['n1', '1.2.3', '1.2.3'],
      ['n2', ' 8,3 ', '8,3'],
      ['n3', '33 clicks', '33 clicks'],
    ] as const) {
      const { input } = field(id);
      renderGrindField(id, 'Niche', stored);
      expect(input.value).toBe(stored);
      expect(getGrindFieldValue(id)).toBe(expected);
    }
    expect(doc.lookups.filter(id => id.startsWith('grindSelect-') || id.startsWith('grindHint-'))).toEqual([]);
  });
});

describe('forgetGrindField', () => {
  // Called for a field whose markup was re-created: it is plain text again,
  // so it returns the input's own text instead of the stored string.
  it('drops the scale state so the input reads back as its trimmed text', () => {
    setGrinder(STEPPED_0_10);
    const { input } = field('gs1');
    renderGrindField('gs1', 'Niche', '8.0');
    expect(getGrindFieldValue('gs1')).toBe('8.0');
    forgetGrindField('gs1');
    input.value = ' 9 ';
    expect(getGrindFieldValue('gs1')).toBe('9');
  });
});

describe('refreshGrindField', () => {
  it('moves the input between the three shapes and keeps the value', () => {
    const { input, select } = field('r1');
    renderGrindField('r1', 'Niche', '5');
    expect(input.hidden).toBe(true);

    setGrinder(STEPLESS_0_9);
    refreshGrindField('r1', 'Niche');
    expect(input.hidden).toBe(false);
    expect(select.hidden).toBe(true);
    expect(input.attrs.inputmode).toBe('decimal');
    expect(input.value).toBe('5');

    setGrinder(null);
    refreshGrindField('r1', 'Niche');
    expect(input.attrs.inputmode).toBeUndefined();
    expect(select.hidden).toBe(true);
    expect(input.value).toBe('5');
  });

  it('leaves the field alone while the user is in it', () => {
    const { input, select } = field('r2');
    renderGrindField('r2', 'Niche', '5');
    setGrinder(STEPLESS_0_9);

    doc.activeElement = input;
    refreshGrindField('r2', 'Niche');
    expect(input.hidden).toBe(true);
    expect(select.hidden).toBe(false);

    doc.activeElement = select;
    refreshGrindField('r2', 'Niche');
    expect(input.hidden).toBe(true);
    expect(input.attrs.inputmode).toBeUndefined();

    doc.activeElement = null;
    refreshGrindField('r2', 'Niche');
    expect(input.hidden).toBe(false);
  });
});

describe('the grinder form', () => {
  beforeEach(() => {
    doc.add('grinderFormScale', new FakeRoot(doc));
    doc.add('grinderFormScaleType', new FakeInput());
    doc.add('grinderFormScaleRange', new FakeInput());
    doc.add('grinderFormScaleMin', new FakeInput());
    doc.add('grinderFormScaleMax', new FakeInput());
    doc.add('grinderFormScaleStep', new FakeInput());
    doc.add('grinderFormScaleError', new FakeInput());
  });

  it('marks the saved scale type and fills its values', () => {
    renderGrinderScaleForm(STEPLESS_0_9);
    expect(inputEl('grinderFormScaleType').innerHTML).toContain('aria-pressed="true" data-scale-type="stepless"');
    expect(inputEl('grinderFormScaleMin').value).toBe('0');
    expect(inputEl('grinderFormScaleMax').value).toBe('9');
    expect(inputEl('grinderFormScaleStep').value).toBe('0.1');
    expect(inputEl('grinderFormScaleRange').hidden).toBe(false);
  });

  it('marks the none pill and hides the range for no scale', () => {
    renderGrinderScaleForm(undefined);
    expect(inputEl('grinderFormScaleType').innerHTML).toContain('aria-pressed="true" data-scale-type=""');
    expect(inputEl('grinderFormScaleRange').hidden).toBe(true);
  });

  it('fills only empty fields with the picked type defaults', () => {
    renderGrinderScaleForm(undefined);
    inputEl('grinderFormScaleMin').value = '5';
    rootEl('grinderFormScale').onclick?.({ target: { closest: () => ({ dataset: { scaleType: 'stepped' } }) } });
    expect(inputEl('grinderFormScaleRange').hidden).toBe(false);
    expect(inputEl('grinderFormScaleMin').value).toBe('5');
    expect(inputEl('grinderFormScaleMax').value).toBe('40');
    expect(inputEl('grinderFormScaleStep').value).toBe('1');
    expect(inputEl('grinderFormScaleType').innerHTML).toContain('aria-pressed="true" data-scale-type="stepped"');
  });

  it('reads back no scale, a valid scale (comma accepted) and an invalid one', () => {
    renderGrinderScaleForm(undefined);
    expect(readGrinderScaleForm()).toBeNull();

    renderGrinderScaleForm(STEPLESS_0_9);
    inputEl('grinderFormScaleStep').value = '0,1';
    expect(readGrinderScaleForm()).toEqual({ type: 'stepless', min: 0, max: 9, step: 0.1 });

    inputEl('grinderFormScaleMin').value = '9';
    inputEl('grinderFormScaleMax').value = '2';
    expect(readGrinderScaleForm()).toBeUndefined();
    expect(inputEl('grinderFormScaleError').hidden).toBe(false);
    expect(inputEl('grinderFormScaleError').textContent).toBe('Check the range: From must be below To, and the step must fit inside it.');

    renderGrinderScaleForm(STEPLESS_0_9);
    inputEl('grinderFormScaleStep').value = '';
    expect(readGrinderScaleForm()).toBeUndefined();
    expect(inputEl('grinderFormScaleError').hidden).toBe(false);
  });
});
