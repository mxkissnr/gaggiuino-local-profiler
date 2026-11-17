// #2093: every filter chip and single-choice pill group uses the shared
// .chip (docs/DESIGN.md, "Shapes and components"); its active state is
// aria-pressed="true" only. Each slice of #2093 adds the classes it retires
// to RETIRED.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postcss from 'postcss';
import type { Root, Rule } from 'postcss';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'public-src');

// test/node-builtins.d.ts types readdirSync for the one-argument call only.
const readdirRecursive = readdirSync as unknown as (
  path: string,
  options: { recursive: true; encoding: 'utf8' },
) => string[];

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

// Chip classes retired by #2093. No rule, markup or code may use them again.
const RETIRED = ['lib-shelf-chip', 'lib-shelf-view-btn', 'sort-btn', 'theme-btn', 'drink-pill', 'pdw-symptom-btn', 'orders-menu-use-beans', 'orders-menu-use-milks', 'orders-menu-trend'] as const;

// Status badge classes retired by #2094: every status label is a .badge
// (docs/DESIGN.md, "Shapes and components"). No rule, markup or code may
// use them again. Each slice of #2094 adds the classes it retires.
const RETIRED_BADGES = [
  'maint-chip', 'maint-auto-synced', 'maint-log-manual-badge',
  'delta-chip', 'freshness-badge', 'freshness-fresh', 'freshness-ok', 'freshness-old',
  'ordered-by-badge', 'meta-badge', 'channeling-warn', 'sidebar-grind-badge',
  'shot-machine-badge', 'shot-frozen-badge',
  'lib-fresh-badge', 'lib-frozen-badge', 'lib-decaf-badge', 'lib-roast-badge',
  'lib-disabled-badge', 'lib-inv-reorder',
  'lib-bag-active-badge', 'lib-bag-upcoming-badge', 'lib-bag-past-badge',
  'lib-shelf-sealed-badge', 'lib-shelf-open-badge', 'lib-shelf-archived-tag',
  'machine-row-firmware-badge', 'machine-row-firmware-badge-muted',
  'machine-row-firmware-badge-update', 'mbk-chip',
  'machine-row-badge', 'lib-utility-badge', 'lib-brew-badge',
  'orders-milk-badge', 'order-eta-tag', 'order-decline-tag',
  'order-variant-badge', 'orders-new-badge',
  'dw-score-chip', 'dw-chip',
] as const;

// Button classes retired by #2095: every action button outside the navigation
// is a .btn with one variant (docs/DESIGN.md, "Shapes and components"). No
// rule, markup or code may use them again. Each slice of #2095 adds the
// classes it retires.
const RETIRED_BUTTONS = [
  'analytics-filter-btn', 'maint-banner-btn', 'maint-done-btn', 'maint-pause-btn',
  'maint-disable-btn', 'maint-delete-btn', 'maint-reenable-btn',
  'maint-log-cancel-btn', 'maint-log-del-btn', 'maint-guide-btn',
  'order-btn', 'order-eta-btn', 'orders-clear-hist-btn', 'orders-menu-variant-btn', 'orders-menu-save-btn',
  'compare-btn', 'delete-btn', 'trash-restore-btn', 'trash-delete-btn', 'export-btn',
  'lib-open-btn', 'mbk-btn', 'mbk-btn-primary', 'mbk-btn-danger', 'bottom-nav-reorder-btn',
  'backup-btn', 'lib-btn-icon', 'lib-grinder-reset-burrs',
  'lib-frozen-thaw-btn', 'lib-frozen-edit-btn', 'lib-bag-edit-btn', 'lib-bag-del',
  'sticker-mode-btn', 'lib-save-btn', 'lib-btn-sm', 'lib-url-btn', 'scan-close-btn',
  'scan-photo-btn',
] as const;

function declsOf(rules: Rule[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    for (const node of rule.nodes ?? []) {
      if (node.type === 'decl') out.push(`${node.prop}: ${node.value}`);
    }
  }
  return out;
}

function rulesWith(root: Root, selector: string): Rule[] {
  const found: Rule[] = [];
  root.walkRules(rule => {
    if (rule.selector === selector) found.push(rule);
  });
  return found;
}

describe('shared filter chips (#2093)', () => {
  it('sizes controls by pointer: 36 px fine, 44 px coarse', () => {
    const root = postcss.parse(read('tokens.css'));

    const base: Rule[] = [];
    root.each(node => {
      if (node.type === 'rule' && node.selector === ':root') base.push(node);
    });

    const coarse: Rule[] = [];
    root.walkAtRules(atRule => {
      if (atRule.name !== 'media' || atRule.params !== '(pointer: coarse)') return;
      atRule.each(node => {
        if (node.type === 'rule' && node.selector === ':root') coarse.push(node);
      });
    });

    expect(declsOf(base)).toContain('--ctl-height: 36px');
    expect(declsOf(coarse)).toEqual(['--ctl-height: 44px']);
  });

  it('gives chips, buttons and the shelf search the shared height and radius', () => {
    const root = postcss.parse(read('style.css'));

    for (const selector of ['.chip', '.btn']) {
      const found = rulesWith(root, selector);
      expect(found.length, selector).toBeGreaterThan(0);
      expect(declsOf(found), selector).toContain('min-height: var(--ctl-height)');
    }

    const search = declsOf(rulesWith(root, '.lib-shelf-search'));
    expect(search).toContain('min-height: var(--ctl-height)');
    expect(search).toContain('border-radius: var(--radius-ctl)');
  });

  it('leaves no rule, markup or code using a retired chip, badge or button class', () => {
    const files = readdirRecursive(SRC, { recursive: true, encoding: 'utf8' })
      .filter(name => name.endsWith('.ts') || name.endsWith('.html') || name.endsWith('.css'));

    const hits: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const name of [...RETIRED, ...RETIRED_BADGES, ...RETIRED_BUTTONS]) {
        if (new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text)) hits.push(`${file}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

function buttons(action: string): string[] {
  return read('index.html').match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`, 'g')) ?? [];
}

describe('analytics chips (#2093)', () => {
  it.each(['analytics-range', 'set-bean-shelf-sort'])('%s: shared chips with exactly one pressed', action => {
    const found = buttons(action);
    expect(found.length).toBeGreaterThan(1);
    for (const button of found) {
      expect(button).toContain('class="chip"');
      expect(button).toMatch(/aria-pressed="(true|false)"/);
      expect(button).not.toMatch(/class="[^"]*\bactive\b/);
    }
    expect(found.filter(button => button.includes('aria-pressed="true"')).length).toBe(1);
  });

  it('syncs the period chips through aria-pressed only', () => {
    const views = read('boot/views.ts');
    expect(views).toContain("chip.setAttribute('aria-pressed'");
    expect(views).not.toContain("classList.toggle('active'");
  });

  it('renders the world map country chips as shared chips', () => {
    const map = read('views/analytics/world-map.ts');
    expect(map).toContain('class="chip" data-code=');
    expect(map).toContain("querySelectorAll<HTMLElement>('.chip')");
    expect(map).not.toContain('analytics-filter-btn');
  });
});

describe('status badges (#2094)', () => {
  it('renders the shot detail status labels as shared badges', () => {
    const index = read('index.html');
    for (const id of ['verdictDeltaChip', 'pressureDeltaChip', 'flowDeltaChip', 'tempDeltaChip']) {
      expect(index, id).toContain(`<span class="badge shot-delta" id="${id}"`);
    }
    expect(index).toContain('<span id="channelingWarning" class="badge badge--err"');
    expect(index).toContain('<span id="freshnessBadge" class="badge"');
    expect(index).toContain('<div id="orderedByBadge" class="badge badge--warn"');
    expect(index).toContain('<span class="badge badge--err" id="trash-count">');
  });

  it('colours score deltas through the score-scale badge variants', () => {
    const shots = read('views/shots/index.ts');
    expect(shots).toContain("'badge shot-delta'");
    expect(shots).toContain('badge shot-delta badge--');
  });
});

describe('shared buttons (#2095)', () => {
  it('gives the maintenance and analytics actions a shared button variant', () => {
    const index = read('index.html');
    expect(index).toContain('<button type="button" class="btn btn--tonal" data-action="open-maint-log-form"');
    expect(index).toContain('<button type="button" class="btn btn--tonal" data-action="open-maint-custom-form"');
    expect(index).toContain('<button type="button" class="btn btn--quiet" data-action="analytics-facts-shuffle"');
    expect(index).toContain('<button class="btn btn--primary" id="guidedMaintDoneBtn"');
    const maint = read('views/maintenance.ts');
    expect(maint).toContain('class="btn btn--primary" data-action="mark-maint-done"');
    expect(maint).toContain('class="btn btn--tonal" data-action="toggle-maint-disabled"');
  });

  it('gives the order actions a shared button variant and the ETA picker shared chips', () => {
    const orders = read('views/orders.ts');
    expect(orders).toContain('class="btn btn--tonal" data-order-accept=');
    expect(orders).toContain('class="btn btn--tonal" data-order-complete=');
    expect(orders).toContain('class="btn btn--danger" data-order-decline-toggle=');
    expect(orders).toContain('<button type="button" class="chip" aria-pressed="${esc(selectedEta === m');
    expect(orders).not.toContain("classList.add('selected')");
  });

  it('gives the shot view, shot list and trash actions a shared button variant', () => {
    const index = read('index.html');
    for (const id of ['exportAllCsvBtn', 'exportShotBtn', 'exportProfileBtn', 'shareCardBtn', 'annPhotoPickBtn']) {
      expect(index, id).toContain(`class="btn btn--quiet" id="${id}"`);
    }
    expect(index).toContain('class="btn btn--danger" id="annPhotoRemoveBtn"');
    const sidebar = read('components/sidebar.ts');
    expect(sidebar).toContain("btnCmp.className = 'chip shot-compare';");
    expect(sidebar).toContain("btnDel.className = 'btn btn--quiet btn--icon';");
    expect(read('views/shots/index.ts')).toContain('class="btn btn--danger btn--icon" title=');
  });

  it('gives the settings actions a shared button variant, saves tonal', () => {
    const index = read('index.html');
    for (const id of ['shotDefaultsSaveBtn', 'bfSaveBtn', 'mqttSaveBtn', 'backupDownloadBtn']) {
      expect(index, id).toContain(`<button id="${id}" type="button" class="btn btn--tonal"`);
    }
    expect(index).toContain('<button id="machineFormSaveBtn" type="button" class="btn btn--primary"');
    expect(index).not.toContain('class="backup-btn"');
  });

  it('keeps the frozen portion buttons outside the badge and gives bag actions shared buttons', () => {
    const card = read('views/library/bean-card.ts');
    expect(card).toContain('${fpAgeBadge}</span>\n      <button type="button" class="btn btn--tonal" data-action="thaw-portion"');
    const bags = read('views/library/bags.ts');
    expect(bags).toContain('class="btn btn--quiet btn--icon" data-action="open-edit-bag"');
    expect(bags).toContain('class="btn btn--danger btn--icon" data-action="delete-bag"');
  });

  it('gives the dialogs shared buttons and the sticker toggles shared chips', () => {
    const sticker = read('components/sticker/editor.ts');
    expect(sticker).toContain("themedButton('chip sticker-mode-add',");
    expect(sticker).toContain("themedButton('chip sticker-original',");
    expect(sticker).toContain("themedButton('btn btn--primary crop-editor-apply sticker-apply',");
    expect(read('components/confirm-dialog.ts')).toContain("accept.className = 'btn btn--primary';");
    expect(read('components/image-crop.ts')).toContain('class="btn btn--primary crop-editor-apply"');
    expect(read('views/library/bean-form-sheet.ts')).toContain("discard.className = 'btn btn--danger';");
  });

  it('gives the library forms one primary each and the new bean form one of its two saves', () => {
    const index = read('index.html');
    for (const id of ['saveGrinderBtn', 'saveRecipeBtn', 'saveMilkBtn', 'saveBasketBtn', 'savePuckScreenBtn', 'saveBeanAddBagBtn']) {
      expect(index, id).toContain(`<button type="button" class="btn btn--primary" id="${id}"`);
    }
    expect(index).toContain('<button type="button" class="btn btn--tonal" id="saveBeanNoBagBtn"');
    expect(index).not.toMatch(/class="[^"]*\b(?:lib-save-btn|lib-btn-sm)\b/);
  });

  it('gives the wizards and the profile editor one primary per step', () => {
    for (const file of ['views/dialin-wizard.ts', 'views/profile-dialin-wizard.ts', 'views/setup-wizard.ts', 'views/gaggimate-profile-editor.ts', 'views/shots/annotation-mix.ts']) {
      const text = read(file);
      expect(text, file).not.toMatch(/lib-save-btn|lib-btn-sm/);
      expect(text, file).toContain('class="btn btn--');
    }
  });
});
