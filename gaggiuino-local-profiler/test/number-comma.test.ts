// #1962: components/number-comma.ts turns a typed comma into a dot for every
// number input, so Firefox does not empty the field on "8,3". vitest runs with
// environment 'node', so the document is the same minimal fake the sibling
// DOM tests use.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installNumberComma } from '../public-src/components/number-comma.js';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

interface FakeEvent {
  target: unknown;
  data: string | null;
  prevented: boolean;
  preventDefault(): void;
}

function fakeDocument() {
  const listeners: ((e: FakeEvent) => void)[] = [];
  const inserted: string[] = [];
  const doc = {
    addEventListener(type: string, fn: (e: FakeEvent) => void) { if (type === 'beforeinput') listeners.push(fn); },
    execCommand(command: string, _showUI: boolean, value: string) { inserted.push(`${command}:${value}`); return true; },
  };
  return {
    doc: doc as unknown as Document,
    inserted,
    fire(target: unknown, data: string | null): FakeEvent {
      const event: FakeEvent = { target, data, prevented: false, preventDefault() { event.prevented = true; } };
      for (const fn of listeners) fn(event);
      return event;
    },
  };
}

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

  it('is installed by wireAppShell before any other wiring', () => {
    const shell = readFileSync(join(appRoot, 'public-src', 'boot', 'shell.ts'), 'utf8');
    const body = shell.slice(shell.indexOf('export function wireAppShell'));
    expect(body).toContain('installNumberComma();');
    expect(body.indexOf('installNumberComma();')).toBeLessThan(body.indexOf('bindEasterEggPanelEscape();'));
  });
});
