// #1104 L1: proves the typed `html-sink` ESLint rule (eslint-rules/html-sink.js)
// rejects plain-string values at the innerHTML/outerHTML and insertAdjacentHTML
// sinks and accepts Html-branded ones. It lints the fixture through the project's
// real eslint.config.js (the same typed setup as `npm run lint`), so the rule sees
// the exact parser services and Html types it does in production. The fixture is
// globally ignored by that config, so the normal `eslint .` run never trips on its
// deliberate violations — this test lints it explicitly with ignore disabled.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const fixturePath = join(here, 'fixtures', 'html-sink-cases.ts');
const fixtureCode = readFileSync(fixturePath, 'utf8');

// The fixture is annotated by a trailing marker on each sink line. Match it at
// the end of the line only: the file's own header comment mentions both marker
// strings, and an `includes()` check would treat those comment lines as sinks.
const REJECTED = '// rejected';
const ACCEPTED = '// accepted';

describe('local/html-sink (#1104 L1)', () => {
  // Type-aware linting loads the TS program, which is slower than the default
  // 5s vitest budget on a cold cache.
  it('rejects plain strings and accepts Html-branded values at the markup sinks', async () => {
    const eslint = new ESLint({ cwd: appRoot, ignore: false });
    const results = await eslint.lintFiles([fixturePath]);
    const messages = results
      .flatMap((result) => result.messages)
      .filter((message) => message.ruleId === 'local/html-sink');

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
      const trimmed = text.trimEnd();
      if (trimmed.endsWith(REJECTED)) {
        rejected += 1;
        expect(ruleIdsByLine.get(line) ?? [], `line ${line}: ${trimmed}`).toEqual(['local/html-sink']);
      } else if (trimmed.endsWith(ACCEPTED)) {
        accepted += 1;
        expect(ruleIdsByLine.get(line) ?? [], `line ${line}: ${trimmed}`).toEqual([]);
      }
    });

    expect(rejected).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
  }, 60000);
});
