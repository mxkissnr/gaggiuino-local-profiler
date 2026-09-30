// #1104 L1: proves the typed `html-sink` ESLint rule (eslint-rules/html-sink.js)
// rejects plain-string values at the innerHTML/outerHTML and insertAdjacentHTML
// sinks and accepts Html-branded ones. The fixture (test/fixtures) is linted via
// an ESLint Linter running the real @typescript-eslint/parser with type
// information, so the rule sees the Html brand exactly as it does under
// `npm run lint`.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

const nodeRequire = createRequire(import.meta.url);
const ruleModule = nodeRequire('../eslint-rules/html-sink.js') as { htmlSinkRule: unknown };

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const fixturePath = path.join(here, 'fixtures', 'html-sink-cases.ts');
const fixtureCode = readFileSync(fixturePath, 'utf8');

type VerifyConfig = Parameters<Linter['verify']>[1];
const flatConfig = {
  plugins: { local: { rules: { 'html-sink': ruleModule.htmlSinkRule } } },
  languageOptions: {
    parser: tsParser,
    parserOptions: { project: './tsconfig.json', tsconfigRootDir: appRoot },
  },
  rules: { 'local/html-sink': 'error' },
} as unknown as VerifyConfig;

describe('local/html-sink (#1104 L1)', () => {
  // Type-aware linting loads the TS program, which is slower than the default
  // 5s vitest budget on a cold cache.
  it('rejects plain strings and accepts Html-branded values at the markup sinks', () => {
    const linter = new Linter();
    const messages = linter.verify(fixtureCode, flatConfig, { filename: fixturePath });

    const ruleIdsByLine = new Map<number, string[]>();
    for (const message of messages) {
      const ruleIds = ruleIdsByLine.get(message.line) ?? [];
      ruleIds.push(message.ruleId ?? '');
      ruleIdsByLine.set(message.line, ruleIds);
    }

    let rejected = 0;
    let accepted = 0;
    fixtureCode.split('\n').forEach((text, index) => {
      const line = index + 1;
      if (text.includes('// rejected')) {
        rejected += 1;
        expect(ruleIdsByLine.get(line) ?? []).toEqual(['local/html-sink']);
      }
      if (text.includes('// accepted')) {
        accepted += 1;
        expect(ruleIdsByLine.get(line) ?? []).toEqual([]);
      }
    });

    expect(rejected).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
  }, 30000);
});
