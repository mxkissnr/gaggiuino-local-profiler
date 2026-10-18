import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// Ids that reach an API path or query must go through pathSeg (or
// encodeURIComponent) so they cannot change which endpoint a request hits
// (#1747). This guards the files the slice did not touch, and any new one:
// a template literal that builds an `api/...` URL may only interpolate a
// pathSeg/encodeURIComponent call or a pre-built query string.
const SRC_DIR = join(__dirname, '../public-src');
const ALLOWED_IDENTS = new Set(['params', 'qs']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  literal: string;
  expression: string;
}

function violations(): Violation[] {
  const found: Violation[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const literalMatch of source.matchAll(/`([^`]*)`/g)) {
      const literal = literalMatch[1] ?? '';
      if (!literal.trimStart().startsWith('api/')) continue;
      for (const exprMatch of literal.matchAll(/\$\{([^}]*)\}/g)) {
        const expression = (exprMatch[1] ?? '').trim();
        if (ALLOWED_IDENTS.has(expression)) continue;
        if (/^(pathSeg|encodeURIComponent)\(.*\)$/s.test(expression)) continue;
        const index = (literalMatch.index ?? 0) + 1 + (exprMatch.index ?? 0);
        found.push({
          file: relative(join(SRC_DIR, '..'), file),
          line: source.slice(0, index).split('\n').length,
          literal,
          expression,
        });
      }
    }
  }
  return found;
}

describe('API path guard (#1747)', () => {
  it('encodes every interpolation in an api/ template literal', () => {
    const report = violations()
      .map(v => `${v.file}:${v.line}: ${v.literal} interpolates ${'${'}${v.expression}} without pathSeg()`)
      .join('\n');
    expect(report).toBe('');
  });
});
