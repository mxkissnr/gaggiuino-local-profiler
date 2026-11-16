// #1962: proves the `no-native-dialog` ESLint rule (eslint-rules/no-native-dialog.mts)
// rejects native alert(), confirm() and <datalist> however they are spelled, and
// accepts a local function or property of the same name. It lints the fixture
// through the project's real eslint.config.mts (the same typed setup as
// `npm run lint`). The fixture is globally ignored by that config, so the normal
// `eslint .` run never trips on its deliberate violations — this test lints it
// explicitly with ignore disabled.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const fixturePath = join(here, 'fixtures', 'no-native-dialog-cases.ts');
const fixtureCode = readFileSync(fixturePath, 'utf8');

const REJECTED = '// rejected';
const ACCEPTED = '// accepted';
const RULE = 'local/no-native-dialog';

describe('local/no-native-dialog (#1962)', () => {
  // Type-aware linting loads the TS program, which is slower than the default
  // 5s vitest budget on a cold cache.
  it('rejects native alert/confirm and <datalist>, and accepts same-named locals', async () => {
    const eslint = new ESLint({ cwd: appRoot, ignore: false, flags: ['unstable_native_nodejs_ts_config'] });
    const results = await eslint.lintFiles([fixturePath]);
    const messages = results
      .flatMap((result) => result.messages)
      .filter((message) => message.ruleId === RULE);

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
        expect(ruleIdsByLine.get(line) ?? [], `line ${line}: ${trimmed}`).toEqual([RULE]);
      } else if (trimmed.endsWith(ACCEPTED)) {
        accepted += 1;
        expect(ruleIdsByLine.get(line) ?? [], `line ${line}: ${trimmed}`).toEqual([]);
      }
    });

    expect(rejected).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(0);
  }, 60000);

  it('finds no native dialog in the two HTML pages', () => {
    for (const page of ['index.html', 'kiosk.html']) {
      const text = readFileSync(join(appRoot, 'public-src', page), 'utf8');
      for (const forbidden of ['<datalist', 'alert(', 'confirm(']) {
        expect(text.includes(forbidden), `${page} must not contain ${forbidden}`).toBe(false);
      }
    }
  });
});
