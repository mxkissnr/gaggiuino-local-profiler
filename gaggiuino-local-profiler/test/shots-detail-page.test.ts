// #2152: the shot detail in the Home Assistant page pattern (design doc,
// "Page anatomy"). Pins what the shot page module builds or opens: the notes
// sheet (the static note fields moved into the shared detail sheet, a pending
// save flushed on close and the page redrawn once a changed note has saved),
// the share and compare sheets, the Process group, the verdict's comparison
// line and the similar-shots title. Fake DOM, no jsdom (same style as the
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

const card = vi.hoisted(() => ({ shareCard: vi.fn<(format?: string) => Promise<void>>(() => Promise.resolve()) }));
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

describe('share sheet (#2152)', () => {
  it('offers the square and the story card next to the share button', () => {
    const anchor = fakeEl('shareCardBtn');
    page.openShotShare(anchor as unknown as HTMLElement);
    const opts = lastSheet();
    expect(opts.title).toBe(t('share_card'));
    expect(opts.anchor).toBe(anchor);
    expect(opts.body).toContain('data-action="share-shot-card" data-format="square"');
    expect(opts.body).toContain('data-action="share-shot-card" data-format="story"');
    expect(opts.body).toContain(t('card_fmt_square'));
    expect(opts.body).toContain(t('card_fmt_story'));
  });

  it('shares the chosen format and closes the sheet', () => {
    page.chooseShareFormat('story');
    expect(sheet.closeDetailSheet).toHaveBeenCalledTimes(1);
    expect(card.shareCard).toHaveBeenCalledWith('story');
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
    expect(bar).toContain('class="lib-sheet-iconbtn" id="shareCardBtn"');
    const more = between('<details class="lib-sheet-more shot-more" id="shotMore">', '</details>');
    for (const id of ['exportShotBtn', 'exportProfileBtn', 'exportAllCsvBtn']) {
      expect(more, id).toContain(`class="lib-sheet-menu-item" id="${id}"`);
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
    expect(src).toContain('openShotShare(shareBtn)');
    expect(src).toContain("closest('[data-shot-notes-open]')) openShotNotes();");
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
