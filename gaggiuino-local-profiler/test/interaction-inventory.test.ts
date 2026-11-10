// #1962: docs/interaction-inventory.md lists every existing control that breaks
// an interaction rule, with the slice that migrates it. Rows must stay true: a
// migrated control's row has to go, and a new violation of a measurable rule
// has to be fixed rather than added.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = resolve(appRoot, '..', 'docs', 'interaction-inventory.md');

interface Row { rule: string; file: string; anchor: string; slice: string }

const rows: Row[] = readFileSync(docPath, 'utf8').split('\n')
  .filter(line => line.startsWith('| ') && !line.startsWith('| Rule'))
  .map(line => {
    const [rule = '', file = '', anchor = '', slice = ''] = line.split('|').slice(1, -1).map(c => c.trim());
    return { rule, file, anchor: anchor.replace(/^`|`$/g, ''), slice };
  });

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'i18n') sources(path, out); } else if (/\.(ts|html)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const files = sources(join(appRoot, 'public-src')).map(p => ({ file: relative(appRoot, p), text: readFileSync(p, 'utf8') }));
const rowsPerFile = (rule: string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const row of rows) if (row.rule === rule) counts[row.file] = (counts[row.file] ?? 0) + 1;
  return counts;
};
const sorted = (counts: Record<string, number>): [string, number][] => Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));

const DATE_CALL = /\.toLocale(?:Date|Time)?String\(|new Intl\.(?:DateTimeFormat|RelativeTimeFormat)\(/g;
const NUMBER_INPUT = /<input\b[^>]*?\btype="number"[^>]*>/g;
const complete = (tag: string): boolean => /\bmin=/.test(tag) && /\bmax=/.test(tag) && /\bstep=/.test(tag);

describe('interaction rule inventory (#1962)', () => {
  it('every row names a real file, a live anchor and a slice', () => {
    for (const row of rows) {
      const where = `${row.rule} ${row.file} ${row.anchor}`;
      expect(existsSync(join(appRoot, row.file)), where).toBe(true);
      expect(readFileSync(join(appRoot, row.file), 'utf8').includes(row.anchor), where).toBe(true);
      expect(row.slice, where).toMatch(/^(S\d{1,2}|exempt: .+|open: .+)$/);
    }
  });

  it('lists every date or time format call outside the shared helper', () => {
    const found: Record<string, number> = {};
    for (const { file, text } of files) {
      if (file === join('public-src', 'utils.ts')) continue;
      const n = text.match(DATE_CALL)?.length ?? 0;
      if (n > 0) found[file] = n;
    }
    expect(sorted(found)).toEqual(sorted(rowsPerFile('Dates')));
  });

  it('lists every number input missing min, max or step', () => {
    const found: Record<string, number> = {};
    for (const { file, text } of files) {
      const n = (text.match(NUMBER_INPUT) ?? []).filter(tag => !complete(tag)).length;
      if (n > 0) found[file] = n;
    }
    expect(sorted(found)).toEqual(sorted(rowsPerFile('Numbers')));
  });

  it('lists every suppressed native dialog', () => {
    const path = join(appRoot, 'eslint-suppressions.json');
    const raw = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, { count: number }>>
      : {};
    const found: Record<string, number> = {};
    for (const [file, rules] of Object.entries(raw)) {
      const count = rules['local/no-native-dialog']?.count;
      if (count) found[file] = count;
    }
    expect(sorted(found)).toEqual(sorted(rowsPerFile('Confirming')));
  });
});
