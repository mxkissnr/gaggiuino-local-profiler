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
    'lib-recipe-steps-header', 'lib-import-settings-title', 'lib-import-settings-subtitle', 'lib-import-extra-recipes-title', 'annotation-title',
] as const;

// Classes retired by #2141: the crop and sticker editors' title sits in the
// sheet header bar, whose close is the sticker editor's only way out, so its
// failure-state Close button is gone too. No rule, markup or code may use
// them again.
const RETIRED_2141 = ['crop-editor-title', 'sticker-close'] as const;

// Classes retired by #2148: the Orders page uses grouped rows and the shared
// buttons, chips, badges and inputs; its page classes only lay out. No rule,
// markup or code may use them again.
const RETIRED_2148 = [
  'order-card', 'order-hist-del', 'order-shot-link', 'order-actions', 'order-queue-hint',
  'order-eta-suggest', 'order-decline-input', 'orders-empty', 'orders-toggle-row',
  'orders-toggle-state', 'orders-queue-banner', 'orders-machine-off', 'orders-menu-toggle',
  'orders-menu-section', 'orders-columns', 'orders-history-header', 'orders-section',
  'orders-menu-del', 'orders-menu-input', 'orders-notify-select', 'orders-notify-row',
  'orders-notify-hint', 'orders-notify-customer', 'orders-notify-list', 'orders-stats-card',
  'orders-stats-grid', 'orders-milk-row', 'orders-milk-emoji', 'orders-milk-name',
  'orders-broadcast-empty',
] as const;

// Classes and ids retired by #2152: the shot detail uses the top app bar,
// the shared verdict, grouped rows and the detail sheet; its page classes
// only lay out. No rule, markup or code may use them again.
const RETIRED_2152 = [
  'sprofiler-header', 'sph-title', 'sph-actions', 'shotHeaderZone', 'verdict-header',
  'verdict-line', 'verdict-headline', 'verdict-subline', 'verdictSubline', 'verdict-score-num',
  'process-zone', 'process-card', 'annotation-header', 'card-fmt-wrap', 'card-fmt-menu',
  'card-fmt-opt', 'cardFmtWrap', 'cardFmtMenu', 'grind-comparative', 'comp-toggle',
  'shot-header-thumb', 'shotHeaderThumb', 'ann-ordered-by', 'orderedByBadge', 'meta-stability',
  'tempStability', 'channelingWarning', 'toggle-comp-grind',
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
      for (const name of [...RETIRED, ...RETIRED_BADGES, ...RETIRED_BUTTONS, ...RETIRED_2096, ...RETIRED_2112, ...RETIRED_2120, ...RETIRED_2141, ...RETIRED_2148, ...RETIRED_2152]) {
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
    expect(index).toContain('<span class="badge shot-delta" id="verdictDeltaChip"');
    const page = read('views/shots/detail-page.ts');
    expect(page).toContain('<span class="badge shot-delta" title=');
    expect(page).toContain('<span class="badge badge--err">${LIGHTNING_ICON_SVG} Channeling</span>');
    expect(index).toContain('<span id="freshnessBadge" class="badge"');
    expect(index).not.toContain('orderedByBadge');
    expect(index).toContain('<span class="badge badge--err" id="trash-count">');
  });

  it('colours score deltas through the score-scale badge variants', () => {
    const shots = read('views/shots/index.ts');
    expect(read('views/shots/detail-page.ts')).toContain('<span class="badge shot-delta" title=');
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
    expect(orders).toContain('class="btn btn--tonal" data-order-eta-open=');
    expect(orders).toContain('class="btn btn--quiet btn--icon" data-order-decline-toggle=');
    expect(orders).toContain('class="btn btn--danger" data-order-decline-submit=');
    expect(orders).toContain('<button type="button" class="chip" aria-pressed="${esc(selectedEta === m');
    expect(orders).not.toContain("classList.add('selected')");
  });

  it('gives the shot view, shot list and trash actions a shared button variant', () => {
    const index = read('index.html');
    for (const id of ['exportAllCsvBtn', 'exportShotBtn', 'exportProfileBtn']) {
      expect(index, id).toContain(`class="lib-sheet-menu-item" id="${id}"`);
    }
    expect(index).toContain('class="lib-sheet-iconbtn" id="shareCardBtn"');
    expect(index).toContain('class="btn btn--quiet" id="annPhotoPickBtn"');
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
    expect(read('views/library/bean-form-sheet.ts')).toContain("{ confirmLabel: t('lib_form_discard'), destructive: true }");
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
    expect(index).toContain('<h2 class="section-title" data-i18n="orders_queue">');
    expect(index).toContain('<h2 class="section-title" data-i18n="orders_inprogress">');
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
    // #2135: the bean form sheet's bar has no Save; the form's own row saves.
    expect(read('views/library/bean-form-sheet.ts')).not.toContain('lib-sheet-save');
    expect(read('views/maintenance.ts').split('class="btn btn--primary lib-sheet-save"').length - 1).toBe(2);

    const css = read('style.css');
    expect(css).not.toContain('.lib-sheet-save');
    const root = postcss.parse(css);
    expect(declsOf(rulesWith(root, '.lib-add-trigger'))).toEqual(['width: 100%']);
    expect(declsOf(rulesWith(root, '.lib-scan-trigger'))).toEqual(['white-space: nowrap']);
  });
});

describe('card titles (#2120)', () => {
  it('gives the settings cards and the backup restore the shared card title', () => {
    const index = read('index.html');
    // 14 cards plus the barcode scanner's title (#2141)
    expect(index.split('<h3 class="card-title"').length - 1).toBe(15);
    expect(index).toContain('<label for="settingsLang" class="card-title" data-i18n="settings_language">');
    expect(index).not.toContain('orders-menu-toggle'); // #2148: the orders folds became Manage rows
    expect(read('boot/popups.ts')).toContain('<h3 class="card-title" data-i18n="settings_popups_title">');
    expect(read('boot/settings-page.ts')).toContain("'.card-title, .settings-row-title, label'");
    expect(read('components/machine-backups.ts')).toContain('<h3 class="card-title">');
  });

  it('defines one card title look', () => {
    const root = postcss.parse(read('style.css'));
    expect(declsOf(rulesWith(root, '.card-title'))).toEqual([
      'margin: 0', 'font-size: var(--fs-3)', 'font-weight: 600', 'color: var(--gray-200)',
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
  ['backupModal', 'id="backupModalTitle"'],
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

// #2120: closing is the cancel. Guided maintenance and the GaggiMate editor
// have one cancel, the header close; the brew confirmation keeps its two
// answers and its header close does the same as Back.
describe('dialog close (#2120)', () => {
  it.each(['guided-maint-cancel', 'gm-editor-close'] as const)('%s: the header close is the only cancel', action => {
    expect(buttons(action)).toEqual([
      `<button type="button" class="lib-sheet-close" data-action="${action}" data-i18n-aria-label="lib_sheet_close" aria-label="Close">`,
    ]);
  });

  it('routes both closes to the close functions the Cancel buttons used', () => {
    expect(read('boot/delegation.ts')).toContain("case 'guided-maint-cancel': closeGuidedMaint(); break;");
    expect(read('views/gaggimate-profile-editor.ts')).toContain("case 'gm-editor-close': closeGaggiMateEditor(); break;");
  });

  it('keeps both answers in the brew confirmation', () => {
    const back = buttons('brew-confirm-cancel');
    expect(back.length).toBe(2);
    expect(back[0]).toContain('class="lib-sheet-close"');
    expect(back[1]).toContain('class="btn btn--quiet"');
    expect(buttons('brew-confirm-start').length).toBe(1);
  });
});

describe('form headings (#2120)', () => {
  it('gives the step lists, the import settings and the annotation panel the shared section title', () => {
    const index = read('index.html');
    expect(index.split('<div class="section-title">').length - 1).toBe(2);
    expect(index).toContain('<div class="section-title" data-i18n="lib_import_settings_title">');
    expect(index).toContain('<div class="section-title" data-i18n="lib_import_settings_custom_label">');
    expect(index).toContain('<h2 class="section-title" data-i18n="ann_title">');
    expect(read('views/gaggimate-profile-editor.ts').split('<div class="section-title">').length - 1).toBe(2);
    expect(read('views/library/import.ts')).toContain('<div class="section-title">${esc(t(');
  });

  it('keeps only layout in the step list head', () => {
    const root = postcss.parse(read('style.css'));
    expect(declsOf(rulesWith(root, '.lib-recipe-steps-section > .section-title'))).toEqual(['justify-content: space-between', 'align-items: center']);
  });
});

// #2141: the crop and sticker editors and the backup dialog put their title in
// the shared sheet header bar; the barcode scanner, a full-screen overlay
// without a sheet surface, names itself with the shared card title.
describe('remaining dialog titles (#2141)', () => {
  it('puts the crop editor title in the sheet header bar, with the close as its only cancel', () => {
    const crop = read('components/image-crop.ts');
    const bar = crop.indexOf('<div class="lib-sheet-bar">');
    const close = crop.indexOf('<button type="button" class="lib-sheet-close crop-editor-cancel"');
    const title = crop.indexOf('<h3 class="lib-sheet-bar-title" id="cropEditorTitle">');
    expect(bar).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(bar);
    expect(title).toBeGreaterThan(close);
    expect(crop).toContain("aria-label=\"${esc(t('lib_sheet_close'))}\">${CLOSE_ICON_SVG}</button>");
    expect(crop).not.toContain('btn btn--quiet crop-editor-cancel');
    expect(crop).not.toContain("t('lib_cancel')");
  });

  it('puts the sticker editor title in the sheet header bar', () => {
    const sticker = read('components/sticker/editor.ts');
    expect(sticker).toContain("const bar = element('div', 'lib-sheet-bar');");
    expect(sticker).toContain("const cancelBtn = element('button', 'lib-sheet-close sticker-cancel');");
    expect(sticker).toContain("const title = element('h3', 'lib-sheet-bar-title');");
    expect(sticker).toContain('for (const child of [bar, viewport,');
    expect(sticker).not.toContain("t('lib_cancel')");
  });

  it('gives the barcode scanner the shared card title and drops the old title rules', () => {
    expect(read('index.html')).toContain('<h3 class="card-title" data-i18n="scan_title">');
    const root = postcss.parse(read('style.css'));
    for (const selector of ['#scanModal h3', '.backup-modal-card h3', '.crop-editor-title']) {
      expect(rulesWith(root, selector), selector).toEqual([]);
    }
  });

  it('lets the crop editor and the backup dialog hold the bar', () => {
    const root = postcss.parse(read('style.css'));
    expect(declsOf(rulesWith(root, '.crop-editor-modal > .lib-sheet-bar'))).toEqual(['align-self: stretch', 'flex-shrink: 0', 'margin-bottom: 0']);
    expect(declsOf(rulesWith(root, '.backup-modal-card > .lib-sheet-bar'))).toEqual(['flex-shrink: 0', 'margin-bottom: 0', 'top: calc(-1 * var(--sp-5))']);
  });

  it('keeps both answers in the backup dialog next to its header close', () => {
    const index = read('index.html');
    expect(index).toContain('<button type="button" class="lib-sheet-close" id="backupModalCloseBtn" data-i18n-aria-label="lib_sheet_close" aria-label="Close">');
    expect(index).toContain('<button id="backupModalConfirmBtn" type="button" class="btn btn--primary"></button>');
    expect(index).toContain('<button id="backupModalCancelBtn" type="button" class="btn btn--quiet" data-i18n="backup_modal_cancel">');
  });
});
