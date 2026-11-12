// #1962: components/number-comma.ts turns a typed comma into a dot for every
// number input, so Firefox does not empty the field on "8,3". vitest runs with
// environment 'node', so the document is the same minimal fake the sibling
// DOM tests use.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installNumberComma, normalizePastedNumber } from '../public-src/components/number-comma.js';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

interface FakeEvent {
  target: unknown;
  data: string | null;
  prevented: boolean;
  preventDefault(): void;
}

interface FakePasteEvent {
  target: unknown;
  clipboardData: { getData: (type: string) => string } | null;
  prevented: boolean;
  preventDefault(): void;
}

function fakeDocument() {
  const listeners = new Map<string, ((e: FakeEvent) => void)[]>();
  const inserted: string[] = [];
  const doc = {
    addEventListener(type: string, fn: (e: FakeEvent) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    execCommand(command: string, _showUI: boolean, value: string) { inserted.push(`${command}:${value}`); return true; },
  };
  function dispatch(type: string, event: FakeEvent): void {
    for (const fn of listeners.get(type) ?? []) fn(event);
  }
  return {
    doc: doc as unknown as Document,
    inserted,
    fire(target: unknown, data: string | null): FakeEvent {
      const event: FakeEvent = { target, data, prevented: false, preventDefault() { event.prevented = true; } };
      dispatch('beforeinput', event);
      return event;
    },
    firePaste(target: unknown, text: string): FakePasteEvent {
      const event: FakePasteEvent = {
        target,
        clipboardData: { getData: (): string => text },
        prevented: false,
        preventDefault() { event.prevented = true; },
      };
      dispatch('paste', event as unknown as FakeEvent);
      return event;
    },
  };
}

describe('normalizePastedNumber (#2026)', () => {
  it('turns a decimal comma into a dot', () => {
    expect(normalizePastedNumber('1,5')).toBe('1.5');
  });

  it('reads a dot-grouped value as thousands with a decimal comma', () => {
    expect(normalizePastedNumber('1.000,5')).toBe('1000.5');
  });

  it('reads a comma-grouped value as thousands with a decimal dot', () => {
    expect(normalizePastedNumber('1,000.5')).toBe('1000.5');
  });

  it('leaves a number without a comma as it is', () => {
    expect(normalizePastedNumber('12')).toBe('12');
  });

  it('drops plain and non-breaking spaces', () => {
    expect(normalizePastedNumber(' 1\u00a0000\u202f,5 ')).toBe('1000.5');
  });
});

describe('installNumberComma (#1962)', () => {
  it('turns a comma typed into a number field into a dot', () => {
    const fake = fakeDocument();
    installNumberComma(fake.doc);

    const event = fake.fire({ type: 'number' }, '8,3');

    expect(event.prevented).toBe(true);
    expect(fake.inserted).toEqual(['insertText:8.3']);
  });

  it('leaves a dot alone', () => {
    const fake = fakeDocument();
    installNumberComma(fake.doc);

    const event = fake.fire({ type: 'number' }, '8.3');

    expect(event.prevented).toBe(false);
    expect(fake.inserted).toEqual([]);
  });

  it('leaves a text field alone', () => {
    const fake = fakeDocument();
    installNumberComma(fake.doc);

    const event = fake.fire({ type: 'text' }, '8,3');

    expect(event.prevented).toBe(false);
    expect(fake.inserted).toEqual([]);
  });

  it('leaves an event without data alone', () => {
    const fake = fakeDocument();
    installNumberComma(fake.doc);

    const event = fake.fire({ type: 'number' }, null);

    expect(event.prevented).toBe(false);
    expect(fake.inserted).toEqual([]);
  });

  it('converts a pasted value with a comma into a dot', () => {
    const fake = fakeDocument();
    installNumberComma(fake.doc);

    const event = fake.firePaste({ type: 'number' }, '1,5');

    expect(event.prevented).toBe(true);
    expect(fake.inserted).toEqual(['insertText:1.5']);
  });

  it('leaves a paste without a comma to the browser', () => {
    const fake = fakeDocument();
    installNumberComma(fake.doc);

    const event = fake.firePaste({ type: 'number' }, '1.5');

    expect(event.prevented).toBe(false);
    expect(fake.inserted).toEqual([]);
  });

  it('leaves a paste into a text field alone', () => {
    const fake = fakeDocument();
    installNumberComma(fake.doc);

    const event = fake.firePaste({ type: 'text' }, '1,5');

    expect(event.prevented).toBe(false);
    expect(fake.inserted).toEqual([]);
  });

  it('is installed by wireAppShell before any other wiring', () => {
    const shell = readFileSync(join(appRoot, 'public-src', 'boot', 'shell.ts'), 'utf8');
    const body = shell.slice(shell.indexOf('export function wireAppShell'));
    expect(body).toContain('installNumberComma();');
    expect(body.indexOf('installNumberComma();')).toBeLessThan(body.indexOf('bindEasterEggPanelEscape();'));
  });
});
