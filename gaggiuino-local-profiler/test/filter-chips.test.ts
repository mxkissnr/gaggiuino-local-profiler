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

// Classes retired by #2096: section headings are .section-title, input chips
// are .chip--input, notification dots are named *-dot and navigation items
// are not named *-btn (docs/DESIGN.md, "Shapes and components"). No rule,
// markup or code may use them again. Each slice of #2096 adds the classes it
// retires.
const RETIRED_2096 = [
  'analytics-section-title', 'lib-shelf-heading', 'lib-shelf-count',
  'maint-section-title', 'orders-col-title', 'orders-milk-title', 'orders-broadcast-title',
  'lib-sheet-aromas-title', 'lib-sheet-profiles-title', 'licenses-count',
  'flavor-chip', 'has-badge', 'maint-badge',
  'mobile-drawer-btn', 'bottom-nav-btn', 'lib-sheet-menu-btn',
  'lib-recipe-shots-badge',
] as const;

// Classes retired by #2112: the chart's time / P·Q switch is a pair of
// shared chips. No rule, markup or code may use them again.
const RETIRED_2112 = ['chart-tab'] as const;

// Classes retired by #2120: a card or form title is the shared .card-title
// or a .section-title, and a dialog's title sits in the sheet header bar
// (docs/DESIGN.md, "Shapes and components"). No rule, markup or code may
// use them again. Each slice of #2120 adds the classes it retires.
const RETIRED_2120 = [
  'settings-card-title', 'orders-menu-title', 'mbk-restore-title',
  'fw-header', 'fw-close-x', 'fw-bean-image', 'flavorWheelImage', 'dw-summary-title', 'dw-candidate-title',
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

  it('leaves no rule, markup or code using a retired class', () => {
    const files = readdirRecursive(SRC, { recursive: true, encoding: 'utf8' })
      .filter(name => name.endsWith('.ts') || name.endsWith('.html') || name.endsWith('.css'));

    const hits: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const name of [...RETIRED, ...RETIRED_BADGES, ...RETIRED_BUTTONS, ...RETIRED_2096, ...RETIRED_2112, ...RETIRED_2120]) {
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
    expect(read('components/confirm-dialog.ts')).toContain("accept.className = opts.destructive === true ? 'btn btn--danger' : 'btn btn--primary';");
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

describe('section titles (#2096)', () => {
  it('gives the analytics, maintenance, achievements and shelf headings the shared section title', () => {
    const index = read('index.html');
    expect(index).toContain('<h3 class="section-title" data-i18n="maint_log_title">');
    expect(index).toContain('<h3 class="section-title" data-i18n="analytics_trend">');
    expect(read('views/achievements.ts')).toContain('<h2 class="section-title">');
    expect(read('views/maintenance-sheet.ts')).toContain('<h3 class="section-title">');
    const library = read('views/library.ts');
    expect(library).toContain('<div class="section-title"><span>');
    expect(library).toContain('<summary class="section-title lib-shelf-archive-summary">');
    expect(library).toContain('<span class="section-title__count">');
  });

  it('gives the orders, licences and bean sheet headings the shared section title', () => {
    const index = read('index.html');
    expect(index).toContain('<div class="section-title" data-i18n="orders_queue">');
    expect(index).toContain('<div class="section-title orders-history-header">');
    expect(read('views/orders.ts')).toContain('<p class="section-title">');
    expect(read('components/licenses-sheet.ts')).toContain('<h3 class="section-title licenses-heading">');
    expect(read('views/library/bean-card.ts')).toContain('<div class="section-title">');
  });
});

describe('input chips (#2096)', () => {
  it('renders flavour, origin, aroma and order menu variant chips as shared input chips', () => {
    const form = read('views/library/bean-form-chips.ts');
    expect(form).toContain("chip.className = 'chip--input';");
    expect(form).toContain('<span class="chip--input origin-chip">');
    expect(read('components/flavor-mini-wheel.ts')).toContain('<button type="button" class="chip--input lib-aroma-chip"');
    expect(read('views/orders.ts')).toContain('<span class="chip--input orders-menu-variant-chip">');
  });

  it('lets the input chip page classes set only the tint', () => {
    const root = postcss.parse(read('style.css'));
    for (const selector of ['.origin-chip', '.lib-aroma-chip', '.orders-menu-variant-chip']) {
      const decls = declsOf(rulesWith(root, selector));
      expect(decls.length, selector).toBeGreaterThan(0);
      for (const decl of decls) expect(decl, selector).toMatch(/^(?:--input-chip-c|--input-chip-ink|cursor):/);
    }
  });
});

describe('notification dots and the live status (#2096)', () => {
  it('names the notification dots *-dot and gives the live status the shared badge', () => {
    const index = read('index.html');
    expect(index).toContain('<span id="maintBadge" class="maint-dot"');
    expect(index).toContain('<span id="ordersBadge" class="maint-dot"');
    expect(index).toContain('<div id="live-status-badge" class="badge">');
  });
});

describe('navigation and menu items (#2096)', () => {
  it('names the drawer toggle, the bottom navigation and the menu entries as items, not buttons', () => {
    const index = read('index.html');
    expect(index).toContain('class="mobile-drawer-toggle"');
    expect(index).toContain('class="lib-sheet-menu-item"');
    expect(read('components/bottom-nav.ts')).toContain("className = 'bottom-nav-item'");
    expect(read('components/machine-backups.ts')).toContain('<button type="button" class="lib-sheet-menu-item machine-backups-btn">');
  });
});

// #2096: radius and padding live in style.css, where the design ratchet sees
// them, never in an inline style that a view or component writes: a style
// attribute, a style object with a string value or a cssText entry. Offsets
// measured at runtime (body.style.paddingTop below a fixed banner) are no
// authored style and stay allowed.
const INLINE_RADIUS_OR_PADDING = [
  /style="[^"]*\b(?:padding|border-radius)/,
  /\b(?:padding(?:Top|Right|Bottom|Left|Inline|Block)?|borderRadius)\s*:\s*['"`]/,
  /['"`;]\s*(?:padding|border-radius)[\w-]*\s*:/,
] as const;

describe('inline styles (#2096)', () => {
  it('leaves no radius or padding in an inline style', () => {
    const files = readdirRecursive(SRC, { recursive: true, encoding: 'utf8' })
      .filter(name => name.endsWith('.ts') || name.endsWith('.html'));

    const hits: string[] = [];
    for (const file of files) {
      const lines = read(file).split('\n');
      lines.forEach((line, i) => {
        if (INLINE_RADIUS_OR_PADDING.some(re => re.test(line))) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('shows the firmware version and the recipe shot count as shared badges', () => {
    expect(read('index.html')).toContain('<span id="firmwareVersionBadge" class="badge" style="display:none"></span>');
    expect(read('views/library/recipes.ts')).toContain('<span class="badge lib-recipe-shots">');
  });
});

// #2111: a confirmation that deletes, replaces or overwrites data, or skips
// the safety backup, shows its confirm button as .btn--danger. Every delete
// confirmation passes the lib_btn_delete label; the four others are ending the
// demo (deletes the demo data), the raw database import (replaces the
// database), sending a profile (overwrites the machine's values) and a
// firmware update without a backup.
const DESTRUCTIVE_CONFIRM_KEYS = [
  'lib_btn_delete', 'demo_mode_end_confirm', 'settings_devtools_import_db_confirm',
  'profile_confirm_send', 'mbk_preupdate_confirm',
] as const;

describe('destructive confirmations (#2111)', () => {
  it('marks every delete, replace and overwrite confirmation as destructive', () => {
    const files = readdirRecursive(SRC, { recursive: true, encoding: 'utf8' })
      .filter(name => name.endsWith('.ts'));

    const calls: string[] = [];
    const unmarked: string[] = [];
    for (const file of files) {
      read(file).split('\n').forEach((line, i) => {
        if (!line.includes('confirmDialog(')) return;
        if (!DESTRUCTIVE_CONFIRM_KEYS.some(key => line.includes(`'${key}'`))) return;
        calls.push(`${file}:${i + 1}`);
        if (!line.includes('destructive: true')) unmarked.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(unmarked).toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(19);
  });
});

describe('remaining action buttons (#2112)', () => {
  it('gives the top bar actions and the chart controls the shared components', () => {
    const index = read('index.html');
    expect(index).toContain('<button id="powerBtn" type="button" class="btn btn--quiet btn--icon"');
    expect(index).toContain('<button id="syncBtn" type="button" class="btn btn--quiet"');
    expect(index).toContain('<button id="expandChartBtn" type="button" class="btn btn--quiet btn--icon"');
    expect(index).toContain('<button id="closeFullscreenBtn" type="button" class="btn btn--quiet"');
    for (const [id, pressed] of [['tabZeit', 'true'], ['tabPQ', 'false'], ['fsTabZeit', 'true'], ['fsTabPQ', 'false']] as const) {
      expect(index, id).toContain(`<button type="button" class="chip" aria-pressed="${pressed}" id="${id}"`);
    }
    const charts = read('views/shots/charts.ts');
    expect(charts).toContain("setAttribute('aria-pressed', String(tab === 'zeit'))");
    expect(charts).not.toContain("classList.toggle('active'");
    expect(read('components/status.ts')).toContain("const POWER_BTN_CLASS = 'btn btn--quiet btn--icon';");
  });

  it('gives the library triggers and the sheet saves a shared button variant', () => {
    const index = read('index.html');
    expect(index).not.toContain('<button class="lib-add-trigger"');
    expect(index).not.toContain('<button class="lib-scan-trigger"');
    expect(index.split('<button type="button" class="btn btn--tonal lib-add-trigger"').length - 1).toBe(7);
    expect(index.split('<button type="button" class="btn btn--quiet lib-scan-trigger"').length - 1).toBe(3);
    expect(read('views/library/bean-form-sheet.ts')).toContain("save.className = 'btn btn--tonal lib-sheet-save';");
    expect(read('views/maintenance.ts').split('class="btn btn--primary lib-sheet-save"').length - 1).toBe(2);

    const css = read('style.css');
    expect(css).not.toContain('.lib-sheet-save');
    const root = postcss.parse(css);
    expect(declsOf(rulesWith(root, '.lib-add-trigger'))).toEqual(['width: 100%']);
    expect(declsOf(rulesWith(root, '.lib-scan-trigger'))).toEqual(['white-space: nowrap']);
  });
});

describe('card titles (#2120)', () => {
  it('gives the settings cards, the orders cards and the backup restore the shared card title', () => {
    const index = read('index.html');
    expect(index.split('<h3 class="card-title"').length - 1).toBe(14);
    expect(index).toContain('<label for="settingsLang" class="card-title" data-i18n="settings_language">');
    for (const id of ['ordersMenuTitle', 'ordersStatsTitle', 'ordersNotifyTitle', 'ordersKioskTitle']) {
      expect(index, id).toContain(`<div class="card-title orders-menu-toggle" id="${id}">`);
    }
    expect(read('boot/popups.ts')).toContain('<h3 class="card-title" data-i18n="settings_popups_title">');
    expect(read('boot/settings-page.ts')).toContain("'.card-title, .settings-row-title, label'");
    expect(read('components/machine-backups.ts')).toContain('<h3 class="card-title">');
  });

  it('defines one card title look and leaves the orders toggle only its layout', () => {
    const root = postcss.parse(read('style.css'));
    expect(declsOf(rulesWith(root, '.card-title'))).toEqual([
      'margin: 0', 'font-size: var(--fs-3)', 'font-weight: 600', 'color: var(--gray-200)',
    ]);
    expect(declsOf(rulesWith(root, '.orders-menu-toggle'))).toEqual([
      'display: flex', 'align-items: center', 'justify-content: space-between', 'margin-bottom: var(--sp-4)', 'cursor: pointer',
    ]);
  });
});

// #2120: every dialog's title sits in the shared sheet header bar, which is
// the dialog's first child: the close button first, then the title.
const DIALOG_TITLES = [
  ['guidedMaintModal', 'id="guidedMaintTitle"'],
  ['profileEditorModal', 'data-i18n="profile_editor_title"'],
  ['flavorWheelModal', 'id="flavorWheelTitle"'],
  ['dialinWizardModal', 'data-i18n="dialin_wizard_title"'],
  ['profileDialinWizardModal', 'data-i18n="profile_dialin_title"'],
  ['setupWizardModal', 'data-i18n="setup_wizard_title"'],
  ['gmProfileEditorModal', 'id="gmEditorTitle"'],
  ['brewConfirmModal', 'id="brewConfirmTitle"'],
] as const;

describe('dialog titles (#2120)', () => {
  it.each(DIALOG_TITLES)('%s: close, then the title, in the sheet header bar', (modal, title) => {
    const index = read('index.html');
    const start = index.indexOf(`id="${modal}"`);
    expect(start, modal).toBeGreaterThan(-1);
    const bar = index.indexOf('<div class="lib-sheet-bar">', start);
    expect(bar, modal).toBeGreaterThan(start);
    // overlay line, dialog box line, then the bar: it is the box's first child
    expect(index.slice(start, bar).split('\n').length, modal).toBe(3);
    const end = index.indexOf('</div>', bar);
    const close = index.indexOf('<button type="button" class="lib-sheet-close"', bar);
    const heading = index.indexOf(`<h3 class="lib-sheet-bar-title" ${title}`, bar);
    expect(close, modal).toBeGreaterThan(bar);
    expect(heading, modal).toBeGreaterThan(close);
    expect(heading, modal).toBeLessThan(end);
  });

  it('lets the dialogs keep the bar without extra margin and wraps the brew question', () => {
    const root = postcss.parse(read('style.css'));
    expect(declsOf(rulesWith(root, '.guided-maint-modal > .lib-sheet-bar'))).toEqual(['flex-shrink: 0', 'margin-bottom: 0']);
    expect(declsOf(rulesWith(root, '#brewConfirmTitle'))).toEqual(['white-space: normal']);
  });

  it('gives the wizard results the card title and the candidate shot a section title', () => {
    expect(read('views/dialin-wizard.ts')).toContain('<div class="card-title">${title}</div>');
    expect(read('views/profile-dialin-wizard.ts')).toContain('<div class="card-title">${esc(title)}</div>');
    expect(read('views/setup-wizard.ts').split('<div class="card-title">').length - 1).toBe(2);
    for (const file of ['views/dialin-wizard.ts', 'views/profile-dialin-wizard.ts']) {
      expect(read(file), file).toContain('<div class="section-title">${tHtml(');
    }
  });
});
