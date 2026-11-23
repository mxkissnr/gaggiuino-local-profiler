// #2152: the shot detail in the Home Assistant page pattern (design doc,
// "Page anatomy"). Pins what the shot page module builds or opens: the notes
// sheet (the static note fields moved into the shared detail sheet, a pending
// save flushed on close and the page redrawn once a changed note has saved),
// the share menu, the compare sheet, the Process group, the verdict's
// comparison line and the similar-shots title. Fake DOM, no jsdom (same style as the
// orders page test).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ShotLike } from '../public-src/views/shots/utils.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

interface SheetOptions {
  title: string;
  body: string;
  sub?: string;
  dialog?: boolean;
  content?: unknown;
  anchor?: unknown;
  onClose?: () => void;
}

const sheet = vi.hoisted(() => ({
  openDetailSheet: vi.fn<(opts: SheetOptions) => void>(),
  requestCloseDetailSheet: vi.fn<() => void>(),
  closeDetailSheet: vi.fn<() => void>(),
}));
vi.mock('../public-src/components/detail-sheet.js', () => sheet);

// The annotation module runs the real autosave; the page module only needs
// its flush and its busy flag.
const ann = vi.hoisted(() => ({
  flushAutoSave: vi.fn<() => void>(),
  annotationBusy: vi.fn<() => boolean>(() => false),
}));
vi.mock('../public-src/views/shots/annotation.js', () => ann);

const list = vi.hoisted(() => ({ toggleCompare: vi.fn<(id: number) => void>() }));
vi.mock('../public-src/components/sidebar.js', () => list);

const card = vi.hoisted(() => ({ shareCard: vi.fn<(format?: string, verdict?: unknown) => Promise<void>>(() => Promise.resolve()) }));
vi.mock('../public-src/views/shots/export.js', () => card);

const { S } = await import('../public-src/state/index.js');
const { t } = await import('../public-src/i18n.js');
const page = await import('../public-src/views/shots/detail-page.js');
const { findPreviousComparableShot } = await import('../public-src/views/shots/utils.js');

interface FakeEl {
  id: string;
  innerHTML: string;
  title: string;
  attrs: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
}

function fakeEl(id: string): FakeEl {
  const el: FakeEl = {
    id,
    innerHTML: '',
    title: '',
    attrs: {},
    setAttribute: (name: string, value: string) => { el.attrs[name] = value; },
  };
  return el;
}

interface FieldEl {
  hidden: boolean;
  style: { display: string };
  focus: ReturnType<typeof vi.fn>;
  box: { scrollIntoView: ReturnType<typeof vi.fn> };
  closest: ReturnType<typeof vi.fn>;
}

// A note field in the sheet: the page focuses it and centres its block.
function fieldEl(hidden = false, display = ''): FieldEl {
  const box = { scrollIntoView: vi.fn() };
  return { hidden, style: { display }, focus: vi.fn(), box, closest: vi.fn(() => box) };
}

let els: Record<string, FakeEl> = {};
function installDoc(ids: string[]): void {
  els = Object.fromEntries(ids.map(id => [id, fakeEl(id)]));
  g.document = { getElementById: (id: string) => els[id] ?? null };
}

function shot(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, nativeId: id, timestamp: 1_700_000_000 + id * 60, profileName: 'Adaptive', score: 80, annotation: { coffee: 'Guji' }, ...over };
}

function setShots(rows: Record<string, unknown>[]): void {
  S.shots = rows as typeof S.shots;
}

function lastSheet(): SheetOptions {
  const call = sheet.openDetailSheet.mock.calls.at(-1);
  if (!call) throw new Error('openDetailSheet was not called');
  return call[0];
}

const count = (text: string, part: string): number => text.split(part).length - 1;

beforeEach(() => {
  vi.clearAllMocks();
  ann.annotationBusy.mockImplementation(() => false);
  S.currentLang = 'en';
  S.primaryShotId = null;
  S.compareShotId = null;
  setShots([]);
  installDoc([]);
});

afterEach(() => {
  vi.useRealTimers();
  delete g.updateView;
});

describe('notes sheet (#2152)', () => {
  it('opens the static note fields in the detail sheet, a dialog on desktop', () => {
    installDoc(['shotNotesPanel']);
    setShots([shot(1)]);
    S.primaryShotId = 1;
    page.openShotNotes();
    expect(sheet.openDetailSheet).toHaveBeenCalledTimes(1);
    const opts = lastSheet();
    expect(opts.content).toBe(els.shotNotesPanel);
    expect(opts.dialog).toBe(true);
    expect(opts.title).toBe(t('shot_notes_all'));
  });

  it('opens nothing without the panel or an open shot', () => {
    setShots([shot(1)]);
    S.primaryShotId = 1;
    page.openShotNotes();
    installDoc(['shotNotesPanel']);
    S.primaryShotId = null;
    page.openShotNotes();
    expect(sheet.openDetailSheet).not.toHaveBeenCalled();
  });

  it('saves a pending edit on close and redraws the page once the changed note has saved', () => {
    const updateView = vi.fn();
    g.updateView = updateView;
    installDoc(['shotNotesPanel']);
    const row = shot(1, { annotation: { notes: 'thin' } });
    setShots([row]);
    S.primaryShotId = 1;
    page.openShotNotes();
    row.annotation = { notes: 'sweet' };
    lastSheet().onClose?.();
    expect(ann.flushAutoSave).toHaveBeenCalledTimes(1);
    expect(updateView).toHaveBeenCalledTimes(1);
  });

  it('leaves the page alone when nothing changed', () => {
    const updateView = vi.fn();
    g.updateView = updateView;
    installDoc(['shotNotesPanel']);
    setShots([shot(1)]);
    S.primaryShotId = 1;
    page.openShotNotes();
    lastSheet().onClose?.();
    expect(ann.flushAutoSave).toHaveBeenCalledTimes(1);
    expect(updateView).not.toHaveBeenCalled();
  });

  it('waits for a running save before it redraws', () => {
    vi.useFakeTimers();
    const updateView = vi.fn();
    g.updateView = updateView;
    installDoc(['shotNotesPanel']);
    const row = shot(1);
    setShots([row]);
    S.primaryShotId = 1;
    page.openShotNotes();
    row.annotation = { coffee: 'Santos' };
    ann.annotationBusy.mockReturnValueOnce(true).mockReturnValueOnce(true);
    lastSheet().onClose?.();
    expect(updateView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(updateView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(updateView).toHaveBeenCalledTimes(1);
  });
});

describe('notes sheet at a field (#2164)', () => {
  it('opens at the bean field and focuses its select', () => {
    installDoc(['shotNotesPanel']);
    const bean = fieldEl();
    els.annCoffee = bean as unknown as FakeEl;
    setShots([shot(1)]);
    S.primaryShotId = 1;
    page.openShotNotes('bean');
    expect(sheet.openDetailSheet).toHaveBeenCalledTimes(1);
    expect(lastSheet().title).toBe(t('shot_notes_all'));
    expect(lastSheet().dialog).toBe(true);
    expect(bean.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(bean.box.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    const open = sheet.openDetailSheet.mock.invocationCallOrder[0]!;
    expect(bean.focus.mock.invocationCallOrder[0]!).toBeGreaterThan(open);
  });

  it('opens at the grinder select when the library has grinders', () => {
    installDoc(['shotNotesPanel']);
    const grinder = fieldEl();
    const other = fieldEl(false, 'none');
    els.annGrinder = grinder as unknown as FakeEl;
    els.annGrinderOther = other as unknown as FakeEl;
    setShots([shot(1)]);
    S.primaryShotId = 1;
    page.openShotNotes('grinder');
    expect(grinder.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(grinder.box.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(other.focus).not.toHaveBeenCalled();
  });

  it('falls back to the free-text grinder input when the select is hidden', () => {
    installDoc(['shotNotesPanel']);
    const grinder = fieldEl(true);
    const other = fieldEl();
    els.annGrinder = grinder as unknown as FakeEl;
    els.annGrinderOther = other as unknown as FakeEl;
    setShots([shot(1)]);
    S.primaryShotId = 1;
    page.openShotNotes('grinder');
    expect(other.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(other.box.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(grinder.focus).not.toHaveBeenCalled();
  });

  it('All notes opens at the top and moves no focus', () => {
    installDoc(['shotNotesPanel']);
    const bean = fieldEl();
    const grinder = fieldEl();
    els.annCoffee = bean as unknown as FakeEl;
    els.annGrinder = grinder as unknown as FakeEl;
    setShots([shot(1)]);
    S.primaryShotId = 1;
    page.openShotNotes();
    expect(sheet.openDetailSheet).toHaveBeenCalledTimes(1);
    expect(lastSheet().title).toBe(t('shot_notes_all'));
    expect(bean.focus).not.toHaveBeenCalled();
    expect(grinder.focus).not.toHaveBeenCalled();
    expect(bean.box.scrollIntoView).not.toHaveBeenCalled();
    expect(grinder.box.scrollIntoView).not.toHaveBeenCalled();
  });

  it('opening at a field writes nothing', () => {
    installDoc(['shotNotesPanel']);
    els.annGrinder = fieldEl() as unknown as FakeEl;
    setShots([shot(1)]);
    S.primaryShotId = 1;
    page.openShotNotes('grinder');
    expect(sheet.openDetailSheet).toHaveBeenCalledTimes(1);
    expect(ann.flushAutoSave).not.toHaveBeenCalled();
  });
});

describe('Coffee rows (#2164)', () => {
  it('shows the saved label as it is', () => {
    expect(page.coffeeRowText('K6 · Grind 12', 'Niche')).toEqual({ text: 'K6 · Grind 12', prefilled: false });
    expect(page.coffeeRowText('K6 · Grind 12', '')).toEqual({ text: 'K6 · Grind 12', prefilled: false });
  });

  it('shows the prefilled default, marked, instead of a dash', () => {
    expect(page.coffeeRowText(null, 'Niche')).toEqual({ text: 'Niche', prefilled: true });
    expect(page.coffeeRowText('', 'Guji')).toEqual({ text: 'Guji', prefilled: true });
    expect(page.coffeeRowText('Huila', 'Guji')).toEqual({ text: 'Huila', prefilled: false });
  });

  it('shows a dash when nothing is saved or prefilled', () => {
    expect(page.coffeeRowText(null, '')).toEqual({ text: '–', prefilled: false });
    expect(page.coffeeRowText('', '')).toEqual({ text: '–', prefilled: false });
  });

  it('mutes a default and shows its hint, and clears both for a saved value', () => {
    installDoc([]);
    const value = { textContent: '', className: '', hidden: false };
    const hint = { textContent: '', className: '', hidden: true };
    els.beanVal = value as unknown as FakeEl;
    els.beanDefaultHint = hint as unknown as FakeEl;
    page.showCoffeeRow('beanVal', 'beanDefaultHint', '', 'Guji');
    expect(value.textContent).toBe('Guji');
    expect(value.className).toBe('settings-row-title settings-row-title--muted');
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('');
    page.showCoffeeRow('beanVal', 'beanDefaultHint', 'Huila', 'Guji');
    expect(value.textContent).toBe('Huila');
    expect(value.className).toBe('settings-row-title');
    expect(hint.hidden).toBe(true);
  });

  it('the page feeds both rows from the same defaults as the notes sheet', () => {
    const src = read('views/shots/index.ts');
    expect(src).toContain('const prefill = _applyShotDefaults(ann);');
    expect(src).toContain("import { renderAnnotationPanel, annotationBusy, _applyShotDefaults } from './annotation.js';");
    expect(src).toContain("showCoffeeRow('beanVal', 'beanDefaultHint', beanLabel(ann, true), beanLabel(prefill, true));");
    expect(src).toContain("showCoffeeRow('grinderVal', 'grinderDefaultHint', grinderLabel, prefill?.grinder || '');");
  });
});

describe('share menu (#2165)', () => {
  it('shares the chosen format without a sheet', () => {
    page.chooseShareFormat('story');
    expect(card.shareCard).toHaveBeenCalledWith('story', null);
    expect(sheet.openDetailSheet).not.toHaveBeenCalled();
    expect(sheet.closeDetailSheet).not.toHaveBeenCalled();
  });

  it('has no share sheet any more', () => {
    expect('openShotShare' in page).toBe(false);
  });

  it('shares the remembered verdict of the open shot (#2166)', () => {
    const v = { type: 'coarser', text: 'Shot ran long (55 s) – grind coarser', delta: -11, vs: 'vs shot 306' };
    S.primaryShotId = 7;
    page.rememberShotVerdict(7, v);
    page.chooseShareFormat('square');
    expect(card.shareCard).toHaveBeenCalledWith('square', v);
  });

  it('drops a verdict remembered for another shot (#2166)', () => {
    const v = { type: 'coarser', text: 'Shot ran long (55 s) – grind coarser', delta: -11, vs: 'vs shot 306' };
    page.rememberShotVerdict(8, v);
    S.primaryShotId = 7;
    page.chooseShareFormat('square');
    expect(card.shareCard).toHaveBeenCalledWith('square', null);
  });

  it('updateView records the verdict for the share card (#2166)', () => {
    const view = read('views/shots/index.ts');
    const exp = read('views/shots/export.ts');
    expect(view).toContain('rememberShotVerdict(shotA.id, {');
    expect(view).toContain('rememberShotVerdict(shotA.id, null);');
    expect(exp).toContain("getPropertyValue('--accent')");
  });
});

describe('compare (#2152)', () => {
  it('lists the newest other shots, newest first, without the open one', () => {
    setShots([shot(1), shot(2, { score: 91 }), shot(3)]);
    S.primaryShotId = 3;
    const anchor = fakeEl('shotCompareBtn');
    page.onShotCompareClick(anchor as unknown as HTMLElement);
    const opts = lastSheet();
    expect(opts.title).toBe(t('shot_compare_pick'));
    expect(opts.anchor).toBe(anchor);
    const two = opts.body.indexOf('data-action="pick-compare-shot" data-id="2"');
    const one = opts.body.indexOf('data-action="pick-compare-shot" data-id="1"');
    expect(two).toBeGreaterThan(-1);
    expect(one).toBeGreaterThan(two);
    expect(opts.body).not.toContain('data-id="3"');
    expect(opts.body).toContain('>91</span>');
  });

  it('offers at most COMPARE_PICK_LIMIT shots', () => {
    setShots(Array.from({ length: 40 }, (_, i) => shot(i + 1)));
    S.primaryShotId = 40;
    page.onShotCompareClick(null);
    expect(page.COMPARE_PICK_LIMIT).toBe(30);
    expect(count(lastSheet().body, 'data-action="pick-compare-shot"')).toBe(30);
  });

  it('says so when there is no other shot', () => {
    setShots([shot(1)]);
    S.primaryShotId = 1;
    page.onShotCompareClick(null);
    expect(lastSheet().body).toContain(t('shot_compare_none'));
  });

  it('ends a running comparison instead of opening the picker', () => {
    setShots([shot(1), shot(2)]);
    S.primaryShotId = 1;
    S.compareShotId = 2;
    page.onShotCompareClick(null);
    expect(list.toggleCompare).toHaveBeenCalledWith(2);
    expect(sheet.openDetailSheet).not.toHaveBeenCalled();
  });

  it('compares with the picked shot and closes the sheet', () => {
    page.pickCompareShot(2);
    expect(sheet.closeDetailSheet).toHaveBeenCalledTimes(1);
    expect(list.toggleCompare).toHaveBeenCalledWith(2);
  });

  it('names the bar button after what a click does', () => {
    installDoc(['shotCompareBtn']);
    page.syncShotCompareButton(true);
    expect(els.shotCompareBtn?.attrs['aria-label']).toBe(t('shot_compare_end'));
    expect(els.shotCompareBtn?.title).toBe(t('shot_compare_end'));
    expect(els.shotCompareBtn?.innerHTML).toContain('M6 6l12 12');
    page.syncShotCompareButton(false);
    expect(els.shotCompareBtn?.attrs['aria-label']).toBe(t('shot_compare_pick'));
    expect(els.shotCompareBtn?.innerHTML).toContain('M7 7h11');
  });
});

describe('Process group (#2152)', () => {
  it('renders one row per value with its change and the channeling warning', () => {
    const markup = page.processGroupHtml([
      { titleKey: 'process_pressure', value: '8.7 bar / 9.0 bar', delta: '+0.3 bar', deltaTitle: 'vs. Shot 41', channeling: true },
      { titleKey: 'process_flow', value: '2.3 ml/s / 2.0 ml/s', delta: null, deltaTitle: '' },
    ]);
    expect(markup).toContain(`<h2 class="section-title">${t('shot_section_process')}</h2>`);
    expect(count(markup, 'class="settings-row settings-row-static"')).toBe(2);
    expect(markup).toContain(t('process_pressure'));
    expect(markup).toContain('8.7 bar / 9.0 bar');
    expect(markup).toContain('<span class="badge shot-delta" title="vs. Shot 41">+0.3 bar</span>');
    expect(count(markup, 'shot-delta')).toBe(1);
    expect(count(markup, 'badge badge--err')).toBe(1);
  });
});

describe('verdict line and similar shots (#2152)', () => {
  it('names the compared shot and whether it shares the bean', () => {
    expect(page.verdictComparisonText(null)).toBe('');
    expect(page.verdictComparisonText({ shot: { id: 20000041, nativeId: 41 }, sameBean: true }))
      .toBe('vs. Shot 41, the last one with this profile and bean');
    expect(page.verdictComparisonText({ shot: { id: 41 }, sameBean: false }))
      .toBe('vs. Shot 41, the last one with this profile');
  });

  it('titles the similar shots fold with their number', () => {
    expect(page.similarShotsTitle(4)).toBe('Similar shots · 4');
  });
});

describe('the shot the verdict compares against (#2152)', () => {
  function at(id: number, ts: number, over: Partial<ShotLike> = {}): ShotLike {
    return { id, machineId: 1, profileName: 'Adaptive', timestamp: ts, annotation: { beanId: 1, coffee: 'Guji' }, ...over };
  }

  beforeEach(() => {
    S.coffeeLibrary = { beans: [{ id: 1, name: 'Guji' }, { id: 2, name: 'Santos' }], grinders: [] };
  });

  it('takes the newest earlier shot with the same profile, machine and bean', () => {
    const shots = [
      at(1, 100),
      at(2, 200, { annotation: { beanId: 2, coffee: 'Santos' } }),
      at(3, 250, { profileName: 'Blooming' }),
      at(4, 150, { machineId: 2 }),
      at(5, 300),
    ];
    expect(findPreviousComparableShot(shots, shots[4]!)).toEqual({ shot: shots[0], sameBean: true });
  });

  it('compares nothing for the first shot of a bean on that profile', () => {
    const shots = [at(1, 100, { annotation: { beanId: 2, coffee: 'Santos' } }), at(2, 200)];
    expect(findPreviousComparableShot(shots, shots[1]!)).toBeNull();
  });

  it('falls back to the same profile for a shot without a bean', () => {
    const shots = [at(1, 100), at(2, 200, { annotation: {} })];
    expect(findPreviousComparableShot(shots, shots[1]!)).toEqual({ shot: shots[0], sameBean: false });
  });

  it('falls back to the same profile for a mixed shot', () => {
    const mix = { beanId: 1, coffee: 'Guji', beanMix: [{ beanId: 1, coffee: 'Guji', grams: 9 }, { beanId: 2, coffee: 'Santos', grams: 9 }] };
    const shots = [at(1, 100, { annotation: { beanId: 2, coffee: 'Santos' } }), at(2, 200, { annotation: mix })];
    expect(findPreviousComparableShot(shots, shots[1]!)).toEqual({ shot: shots[0], sameBean: false });
  });
});

const SRC = join(import.meta.dirname, '..', 'public-src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const indexHtml = read('index.html');
const between = (from: string, to: string): string => {
  const start = indexHtml.indexOf(from);
  const end = start === -1 ? -1 : indexHtml.indexOf(to, start);
  return end === -1 ? '' : indexHtml.slice(start, end);
};

describe('shot page markup (#2152)', () => {
  const bar = between('<div class="shot-bar">', '<div class="shot-layout">');
  const layout = between('<div class="shot-layout">', '<div class="shot-notes-panels" hidden>');
  const panel = between('<div class="shot-notes-panels" hidden>', '</div><!-- #shots-view -->');

  it('opens with a top app bar: title, compare, share and the downloads in the overflow menu', () => {
    expect(bar).toContain('<h1 id="topTitle" class="settings-bar-title">');
    expect(bar).toContain('class="lib-sheet-iconbtn" id="shotCompareBtn"');
    expect(bar).toContain('<summary id="shareCardBtn"');
    const more = between('<details class="lib-sheet-more shot-more" id="shotMore">', '</details>');
    for (const id of ['exportShotBtn', 'exportProfileBtn', 'exportAllCsvBtn']) {
      expect(more, id).toContain(`class="lib-sheet-menu-item" id="${id}"`);
    }
  });

  it('puts the share formats into a menu in the shared pattern (#2165)', () => {
    const share = between('<details class="lib-sheet-more shot-share" id="shotShare">', '</details>');
    expect(share).toContain('<summary id="shareCardBtn" data-i18n-title="share_card_tooltip"');
    expect(share).toContain('<button type="button" class="lib-sheet-menu-item" data-action="share-shot-card" data-format="square">');
    expect(share).toContain('<button type="button" class="lib-sheet-menu-item" data-action="share-shot-card" data-format="story">');
    expect(share).toContain('<span data-i18n="card_fmt_square">');
    expect(share).toContain('<span data-i18n="card_fmt_story">');
    expect(count(share, '<svg class="rail-icon sm"')).toBe(2);
    expect(count(indexHtml, 'id="shareCardBtn"')).toBe(1);
  });

  it('gives every download an icon and a label that says what it does (#2165)', () => {
    const more = between('<details class="lib-sheet-more shot-more" id="shotMore">', '</details>');
    expect(count(more, '<svg class="rail-icon sm"')).toBe(3);
    for (const key of ['export_shot_menu', 'btn_export_profile', 'export_csv_title']) {
      expect(more, key).toContain(`<span data-i18n="${key}">`);
    }
    expect(more).not.toContain('\u2193');
    for (const lang of ['de', 'en', 'es', 'fr', 'it', 'nl']) {
      const locale = read('i18n/' + lang + '.ts');
      expect(locale, lang).toContain(`export_shot_menu:'`);
      expect(locale, lang).not.toContain(`btn_export_profile:'\u2193`);
    }
  });

  it('keeps the stars and the taste tag on the page and every other note field in the notes sheet', () => {
    for (const id of ['starRating', 'tasteTagPillsContainer', 'quickCloneBtn', 'shotNotesOpen']) {
      expect(layout, id).toContain(`id="${id}"`);
      expect(panel, id).not.toContain(`id="${id}"`);
    }
    for (const id of ['annDrinkType', 'annCoffee', 'annBasket', 'annPuckScreen', 'annGrinder', 'annGrindSetting', 'annDose', 'annTds', 'annNotes', 'annPhotoPickBtn', 'autoSaveStatus']) {
      expect(panel, id).toContain(`id="${id}"`);
      expect(layout, id).not.toContain(`id="${id}"`);
    }
    expect(count(layout, 'data-shot-notes-open')).toBe(3);
  });

  it('heads Notes, Coffee and Process with the shared section title', () => {
    expect(layout).toContain('<h2 class="section-title" data-i18n="ann_title">');
    expect(layout).toContain('<h2 class="section-title" data-i18n="settings_group_coffee">');
    expect(layout).toContain('<section class="shot-process" id="shotProcess"></section>');
  });

  it('gives the bean and grinder rows their own field and distinct icons (#2164)', () => {
    const coffee = between('<section class="shot-coffee">', '</section>');
    expect(coffee).toContain('data-shot-notes-open="bean"');
    expect(coffee).toContain('data-shot-notes-open="grinder"');
    expect(coffee).toContain('M6 12c0-4 3-7.5 7-7.5S19 8 19 12s-3.5 7-7.5 7A6.5 6.5 0 0 1 6 12z');
    expect(count(coffee, 'M6 12c0-4 3-7.5 7-7.5')).toBe(1);
    expect(coffee).toContain('M12 6.5V3.5h5.5');
    expect(coffee).not.toContain('M17 8h1a3 3 0 0 1 0 6h-1');
    expect(coffee).not.toContain('M12 4v4M12 16v4');
    expect(read('icons.ts')).toContain('M6 12c0-4 3-7.5 7-7.5S19 8 19 12s-3.5 7-7.5 7A6.5 6.5 0 0 1 6 12z');
  });

  it('marks a default bean or grinder with the shared hint (#2164)', () => {
    const coffee = between('<section class="shot-coffee">', '</section>');
    expect(coffee).toContain('<span class="settings-row-value" id="beanDefaultHint" data-i18n="lib_grinder_default" hidden>');
    expect(coffee).toContain('<span class="settings-row-value" id="grinderDefaultHint" data-i18n="lib_grinder_default" hidden>');
    expect(count(indexHtml, 'id="beanDefaultHint"')).toBe(1);
    expect(count(indexHtml, 'id="grinderDefaultHint"')).toBe(1);
    expect(read('style.css')).toContain('.settings-row-title--muted { color: var(--gray-400); }');
    expect(count(read('style.css'), '.settings-row-title--muted { color: var(--gray-400); }')).toBe(1);
  });

  it('shows nothing twice', () => {
    for (const id of ['verdictRingVal', 'verdictDeltaChip', 'doseYieldVal', 'beanVal', 'grinderVal', 'orderedByInfo', 'shotHeroPhoto', 'freshnessBadge', 'grindAdviceComparative']) {
      expect(count(indexHtml, `id="${id}"`), id).toBe(1);
    }
    expect(indexHtml).not.toContain('orderedByBadge');
    expect(indexHtml).not.toContain('shotHeaderThumb');
  });
});

describe('shot page wiring (#2152)', () => {
  it('routes the compare picker and share rows through the click delegation', () => {
    const src = read('boot/delegation.ts');
    expect(src).toContain("case 'pick-compare-shot':  pickCompareShot(numId()); break;");
    expect(src).toContain("case 'share-shot-card':    chooseShareFormat(el.dataset.format ?? 'square'); break;");
    expect(src).not.toContain('toggle-comp-grind');
  });

  it('wires the bar buttons and the rows that open the notes', () => {
    const src = read('boot/shot-detail.ts');
    expect(src).toContain('onShotCompareClick(compareBtn)');
    expect(src).not.toContain('openShotShare');
    expect(src).not.toContain("getElementById('shotMore')");
    expect(src).toContain("if (row) openShotNotes(row.dataset.shotNotesOpen || undefined);");
    expect(src).not.toContain('cardFmtMenu');
  });
});

describe('shot page classes only lay out (#2152)', () => {
  it('sets no colour, background, border, radius, padding or font on a shot page class', () => {
    const LAYOUT = /^(?:--[\w-]+|display|flex(?:-[a-z]+)?|grid(?:-[a-z]+)*|gap|row-gap|column-gap|align-[a-z]+|justify-[a-z]+|place-[a-z]+|order|margin(?:-[a-z]+)*|(?:min-|max-)?(?:width|height)|position|top|right|bottom|left|inset|z-index|overflow(?:-[xy])?|white-space|text-overflow|text-align|cursor|container-type|list-style|transform)$/;
    const found: string[] = [];
    postcss.parse(read('style.css')).walkRules(rule => {
      if (!/\.shot-(?:bar|layout|grid|verdict|figures|chart|side|similar|rating|taste|more)\b/.test(rule.selector)) return;
      rule.walkDecls(decl => {
        if (!LAYOUT.test(decl.prop)) found.push(`${rule.selector} { ${decl.prop} }`);
      });
    });
    expect(found).toEqual([]);
  });
});
