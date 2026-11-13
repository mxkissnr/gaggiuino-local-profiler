// #2052 pinned the settings-look fixes in style.css. Every bug in that round
// came from the same shape: a rule in the settings block lost to a later rule
// of equal (or higher) specificity further down this one file, so nothing in
// the TypeScript code or the markup showed the cause. These assertions read
// the final stylesheet and fail when a rule is removed or outranked again.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postcss, { type Rule } from 'postcss';
import de from '../public-src/i18n/de.js';
import en from '../public-src/i18n/en.js';
import es from '../public-src/i18n/es.js';
import fr from '../public-src/i18n/fr.js';
import it from '../public-src/i18n/it.js';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(here, '..', 'public-src', 'style.css');
const root = postcss.parse(readFileSync(CSS_PATH, 'utf-8'), { from: CSS_PATH });

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ');

function rules(selector: string): Rule[] {
  const want = norm(selector);
  const found: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selectors.some((sel) => norm(sel) === want)) found.push(rule);
  });
  return found;
}

function decl(selector: string, prop: string): string | undefined {
  let value: string | undefined;
  for (const rule of rules(selector)) {
    rule.walkDecls(prop, (d) => { value = d.value.trim(); });
  }
  return value;
}

function declares(selector: string, prop: string): boolean {
  return rules(selector).some((rule) => rule.some((d) => d.type === 'decl' && d.prop === prop));
}

describe('settings polish (#2052)', () => {
  it('sizes the verdict icon with an ID so the live icon cannot stretch it', () => {
    expect(decl('#settingsMachineIcon', 'width')).toMatch(/^\d+px$/);
    expect(decl('#settingsMachineIcon', 'height')).toMatch(/^\d+px$/);
    expect(decl('#settingsMachineIcon', 'overflow')).toBe('hidden');
    expect(decl('#settingsMachineIcon .m-svg', 'height')).toBe('100%');
    expect(decl('#settingsMachineIcon .m-svg', 'width')).toBe('auto');
    expect(declares('.settings-verdict-icon', 'width')).toBe(false);
  });

  it('uses the compact verdict title at every width', () => {
    const found = rules('.settings-verdict .analytics-verdict-title');
    const atRoot = found.filter((rule) => rule.parent?.type === 'root');
    expect(atRoot.length).toBeGreaterThan(0);
    expect(decl('.settings-verdict .analytics-verdict-title', 'font-size')).toBe('var(--fs-4)');
    expect(found.filter((rule) => rule.parent?.type !== 'root')).toHaveLength(0);
  });

  it('keeps row cards free of the general card padding', () => {
    expect(decl('.settings-card.settings-row-card', 'gap')).toBe('0');
    expect(decl('.settings-card.settings-row-card', 'padding')).toBe('var(--sp-2) var(--sp-5)');
    expect(rules('.settings-row-card')).toHaveLength(0);
    expect(decl('.settings-row-card .settings-row', 'padding-inline')).toBe('0');
    expect(
      decl('#settings-view .settings-card .orders-broadcast-list:last-child', 'margin-bottom'),
    ).toBe('0');
  });

  it('lets sub-page row titles wrap and the machine name keep its width', () => {
    expect(decl('.settings-pages .settings-row-title', 'white-space')).toBe('normal');
    expect(decl('.machine-row-main', 'flex')).toBe('1 1 auto');
  });

  it('shows the locked navigation entry as a switch, in a plain row', () => {
    let checkboxSelector = '';
    root.walkRules((rule) => {
      for (const sel of rule.selectors) {
        if (norm(sel).includes('.bottom-nav-config-check input')) checkboxSelector = sel;
      }
    });
    expect(checkboxSelector).toBe('');
    expect(decl('.bottom-nav-config-row', 'background')).toBeUndefined();
    expect(decl('.bottom-nav-config-row + .bottom-nav-config-row', 'border-top')).toContain(
      'var(--gray-800)',
    );
  });

  it('translates the backup title', () => {
    expect(de.backup_title).not.toBe(en.backup_title);
    expect(es.backup_title).not.toBe(en.backup_title);
    expect(fr.backup_title).not.toBe(en.backup_title);
    expect(it.backup_title).not.toBe(en.backup_title);
    expect(de.settings_api_token).toBe('API-Token');
  });
});
