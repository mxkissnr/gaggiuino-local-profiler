import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// annotation.ts imports state/index.ts, which reads localStorage/navigator at
// module load time — same stubbing approach as annotation-milk-field-visibility.test.ts.
// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge test/helpers/fake-option-dom.ts uses).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };
g.window       ??= {};

// The post-save sidebar re-render has no DOM here; the save path itself is what
// these tests cover (same reason the basket test answers with ok:false).
vi.mock('../public-src/components/sidebar.js', () => ({
  renderSidebar: () => {},
  updateSidebarHighlighting: () => {},
}));

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue({ ok: false } as Response);
const {
  _renderDrinkPills,
  _renderMilkPills,
  _renderTasteTagPills,
  selectTasteTag,
  scheduleAutoSave,
  flushAutoSave,
  quickRateShot,
} = await import('../public-src/views/shots/annotation.js');
const { quickRatingHtml, quickRatingValue, newestUnratedShotId } =
  await import('../public-src/components/quick-rating.js');

interface FakeEl {
  value?: string;
  innerHTML?: string;
  style: { display?: string };
  classList?: { add: () => void; remove: () => void };
}

let els: Record<string, FakeEl>;

function el(id: string): FakeEl {
  const node = els[id];
  if (!node) throw new Error(`no fake element: ${id}`);
  return node;
}

// Every field _buildAnnotationPayload() reads; the taste tag itself is added
// per test through `hiddenTag`.
function fakeAnnotationDom(hiddenTag?: string): void {
  els = {
    autoSaveStatus:         { value: '', innerHTML: '', style: {}, classList: { add: () => {}, remove: () => {} } },
    tasteTagPillsContainer: { value: '', innerHTML: '', style: {} },
    annTasteTag:            { value: hiddenTag ?? '', innerHTML: '', style: {} },
    drinkPillsContainer:    { value: '', innerHTML: '', style: {} },
    annDrinkType:           { value: '', innerHTML: '', style: {} },
    milkPillsContainer:     { value: '', innerHTML: '', style: {} },
    annMilkType:            { value: '', innerHTML: '', style: {} },
    annCoffee:              { value: '', innerHTML: '', style: {} },
    annGrinder:             { value: '', innerHTML: '', style: {} },
    annGrindSetting:        { value: '', innerHTML: '', style: {} },
    annDose:                { value: '', innerHTML: '', style: {} },
    annTds:                 { value: '', innerHTML: '', style: {} },
    annNotes:               { value: '', innerHTML: '', style: {} },
  };
  (el('annCoffee') as unknown as { selectedOptions: unknown[] }).selectedOptions = [{ dataset: {} }];
  g.document = { getElementById: (id: string) => els[id] ?? null };
}

interface SavedPayload { tasteTag: string | null }

function savedPayload(): SavedPayload {
  const call = fetchSpy.mock.calls[0];
  if (!call) throw new Error('no save request was sent');
  return JSON.parse(call[1]?.body as string) as SavedPayload;
}

// _performAnnotationSave() is fired without being awaited (as in the app), so
// the assertions drain the promise chain it left behind.
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function saveWith(annotation: Record<string, unknown> | null): Promise<void> {
  const response = { ok: true, json: () => Promise.resolve({ annotation, score: 50 }) } as unknown as Response;
  fetchSpy.mockResolvedValueOnce(response);
  scheduleAutoSave();
  flushAutoSave();
  return drain();
}

beforeEach(() => {
  vi.useFakeTimers();
  delete (g.window as { updateView?: () => void }).updateView;
  fetchSpy.mockClear();
  fetchSpy.mockResolvedValue({ ok: false } as Response);
  S.shots = [{ id: 1, timestamp: 1700000000, annotation: {} }];
  S.primaryShotId = 1;
  S.coffeeLibrary = { beans: [] } as unknown as typeof S.coffeeLibrary;
  fakeAnnotationDom();
});

describe('taste-tag chips (#1957)', () => {
  it('renders one chip per tag and marks only the selected one', () => {
    _renderTasteTagPills('bitter');
    const markup = el('tasteTagPillsContainer').innerHTML ?? '';
    expect(markup.match(/data-action="select-taste-tag"/g)).toHaveLength(4);
    expect(markup.match(/class="chip" aria-pressed="true"/g)).toHaveLength(1);
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(markup).not.toMatch(/drink-pill|class="[^"]*\bactive\b/);
    expect(markup).toContain('data-id="bitter"');
    expect(el('annTasteTag').value).toBe('bitter');
  });

  it('selects, replaces and clears the tag through the chip', () => {
    selectTasteTag('sour');
    expect(el('annTasteTag').value).toBe('sour');
    selectTasteTag('thin');
    expect(el('annTasteTag').value).toBe('thin');
    // Tapping the active chip clears it.
    selectTasteTag('thin');
    expect(el('annTasteTag').value).toBe('');
    // Selecting schedules a save; flush it so the debounce does not outlive the
    // test and leak into the next one's `_autoSaveTimer` check.
    flushAutoSave();
  });
});

describe('drink and milk chips (#2093)', () => {
  const DRINKS = [
    { id: 'latte', name: 'Latte', emoji: 'L', milkMl: 150 },
    { id: 'flat',  name: 'Flat White', emoji: 'F', milkMl: 0 },
  ] as unknown as typeof S.drinkMenu;
  const MILKS = [
    { id: 1, name: 'Whole' },
    { id: 2, name: 'Oat' },
  ] as unknown as typeof S.milkTypes;

  function withMenu(fn: () => void): void {
    const prevDrinks = S.drinkMenu;
    const prevMilks  = S.milkTypes;
    S.drinkMenu = DRINKS;
    S.milkTypes = MILKS;
    try { fn(); } finally { S.drinkMenu = prevDrinks; S.milkTypes = prevMilks; }
  }

  it('renders one chip per drink and presses only the selected one', () => {
    withMenu(() => {
      _renderDrinkPills('flat');
      const markup = el('drinkPillsContainer').innerHTML ?? '';
      expect(markup.match(/class="chip"/g)).toHaveLength(2);
      expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
      expect(markup).toMatch(/class="chip" aria-pressed="true"\s+data-action="select-drink" data-id="flat"/);
      expect(markup).not.toMatch(/class="[^"]*\bactive\b/);
    });
  });

  it('renders one chip per milk and presses only the selected one', () => {
    withMenu(() => {
      _renderMilkPills('2');
      const markup = el('milkPillsContainer').innerHTML ?? '';
      expect(markup.match(/class="chip"/g)).toHaveLength(2);
      expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
      expect(markup).toMatch(/class="chip" aria-pressed="true"\s+data-action="select-milk" data-id="2"/);
      expect(markup).not.toMatch(/class="[^"]*\bactive\b/);
    });
  });
});

describe('taste tag in the annotation payload (#1957)', () => {
  it('posts the selected tag', () => {
    selectTasteTag('sour');
    flushAutoSave();
    expect(savedPayload().tasteTag).toBe('sour');
  });

  it('posts null after the tag is cleared again', () => {
    selectTasteTag('sour');
    selectTasteTag('sour');
    flushAutoSave();
    expect(savedPayload().tasteTag).toBeNull();
  });

  it('posts null for a shot that never had a tag', () => {
    scheduleAutoSave();
    flushAutoSave();
    expect(savedPayload().tasteTag).toBeNull();
  });

  it('posts null for a stored value this version does not know', () => {
    fakeAnnotationDom('astringent');
    scheduleAutoSave();
    flushAutoSave();
    expect(savedPayload().tasteTag).toBeNull();
  });
});

describe('taste tag refresh (#1957)', () => {
  it('reruns updateView when the saved tag differs from the previous one', async () => {
    const updateView = vi.fn();
    (g.window as { updateView?: () => void }).updateView = updateView;
    selectTasteTag('sour');
    await saveWith({ tasteTag: 'sour' });
    expect(updateView).toHaveBeenCalledTimes(1);
  });

  it('leaves updateView alone when the tag did not change', async () => {
    const updateView = vi.fn();
    (g.window as { updateView?: () => void }).updateView = updateView;
    S.shots = [{ id: 1, timestamp: 1700000000, annotation: { tasteTag: 'sour' } }];
    fakeAnnotationDom('sour');
    await saveWith({ tasteTag: 'sour' });
    expect(updateView).not.toHaveBeenCalled();
  });

  it('does not rerun updateView while another autosave is pending', async () => {
    const updateView = vi.fn();
    (g.window as { updateView?: () => void }).updateView = updateView;
    const response = { ok: true, json: () => Promise.resolve({ annotation: { tasteTag: 'sour' }, score: 50 }) } as unknown as Response;
    fetchSpy.mockResolvedValueOnce(response);
    selectTasteTag('sour');
    // Starts the save with the debounce already flushed…
    flushAutoSave();
    // …then a fresh edit arrives before the response lands.
    scheduleAutoSave();
    await drain();
    expect(updateView).not.toHaveBeenCalled();
    // Let that debounce fire so its timer does not outlive the test.
    vi.advanceTimersByTime(1000);
    await drain();
  });
});

describe('taste tag wiring sources (#1957)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8');

  it('renders the chips from the saved annotation', () => {
    expect(read('../public-src/views/shots/annotation.ts')).toContain("_renderTasteTagPills(tasteTagOf(ann) ?? '')");
  });

  it('groups the chips under the panel label', () => {
    expect(read('../public-src/index.html')).toMatch(/id="tasteTagPillsContainer"[^>]*aria-labelledby="annTasteTagLabel"/);
  });

  it('routes the chip click through the data-action delegation', () => {
    expect(read('../public-src/boot/delegation.ts')).toContain("case 'select-taste-tag':");
  });

  it('needs no barrel edit: views/shots.ts already re-exports the annotation module', () => {
    expect(read('../public-src/views/shots.ts')).toContain("export * from './shots/annotation.js'");
  });

  it('takes its touch height from the shared chip', () => {
    const css = read('../public-src/style.css');
    expect(css).not.toMatch(/\.drink-pill(?![\w-])/);
    expect(css).toMatch(/\.chip\s*\{[^}]*min-height: var\(--ctl-height\)/);
  });
});

describe('quick rating strip markup (#2226)', () => {
  beforeEach(() => {
    S.currentLang = 'en';
  });

  it('marks the stored rating and taste tag', () => {
    const markup = quickRatingHtml({ id: 7, timestamp: 1, annotation: { rating: 3, tasteTag: 'bitter' } }, true);
    expect(markup.match(/class="star active"/g)).toHaveLength(3);
    expect(markup).toContain('data-action="quick-rate" data-id="7" data-val="3" aria-label="3 of 5 stars" aria-pressed="true"');
    expect(markup).toContain('aria-pressed="true" data-action="quick-taste" data-id="7" data-val="bitter"');
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(markup.match(/class="star(?: active)?"/g)).toHaveLength(5);
    expect(markup.match(/class="chip"/g)).toHaveLength(4);
  });

  it('labels every star for screen readers', () => {
    const markup = quickRatingHtml({ id: 1, timestamp: 1 }, true);
    for (let n = 1; n <= 5; n++) expect(markup).toContain(`aria-label="${n} of 5 stars"`);
    expect(markup).toContain('role="group" aria-label="Rating"');
    expect(markup).toContain('aria-label="How did the shot taste?"');
  });

  it('shows the star meaning hint', () => {
    expect(quickRatingHtml({ id: 1, timestamp: 1 }, false)).toContain('1 undrinkable · 3 fine · 5 the best I can make');
  });

  it('offers Later before a rating and Done after', () => {
    expect(quickRatingHtml({ id: 1, timestamp: 1 }, true)).toContain('data-action="quick-rate-dismiss">Later<');
    expect(quickRatingHtml({ id: 1, timestamp: 1, annotation: { rating: 4 } }, true)).toContain('>Done<');
    expect(quickRatingHtml({ id: 1, timestamp: 1 }, false)).not.toContain('quick-rate-dismiss');
  });

  it('ignores stored values it does not know', () => {
    const markup = quickRatingHtml({ id: 1, timestamp: 1, annotation: { rating: 7, tasteTag: 'astringent' } }, true);
    expect(markup).not.toContain('star active');
    expect(markup).not.toContain('aria-pressed="true"');
    expect(quickRatingValue({ rating: 2.5 })).toBe(0);
    expect(quickRatingValue({ rating: 4 })).toBe(4);
    expect(quickRatingValue(null)).toBe(0);
  });

  it('picks the newest shot only while it is unrated', () => {
    expect(newestUnratedShotId([{ id: 1, timestamp: 100 }, { id: 2, timestamp: 200, annotation: {} }])).toBe(2);
    // shot 1 is older, so a rated newest shot leaves the list without a strip
    // instead of falling back to it.
    expect(newestUnratedShotId([{ id: 1, timestamp: 100 }, { id: 2, timestamp: 200, annotation: { rating: 4 } }])).not.toBe(1);
    expect(newestUnratedShotId([{ id: 1, timestamp: 100 }, { id: 2, timestamp: 200, annotation: { rating: 4 } }])).toBeNull();
    expect(newestUnratedShotId([])).toBeNull();
    expect(newestUnratedShotId([{ id: 3, timestamp: 100 }, { id: 5, timestamp: 100 }])).toBe(5);
  });
});

// #2226: one tap in the strip writes exactly the tapped field through the same
// merge endpoint the panel autosave uses.
describe('quick rating save (#2226)', () => {
  interface SavedBody { [key: string]: unknown }

  function lastBody(): SavedBody {
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error('no save request was sent');
    return JSON.parse(call[1]?.body as string) as SavedBody;
  }

  beforeEach(() => {
    S.currentLang = 'en';
    S.shots = [{ id: 5, timestamp: 1700000100, annotation: {} }, { id: 1, timestamp: 1700000000, annotation: {} }];
    S.primaryShotId = 1;
    (g.window as Record<string, unknown>).showToast = vi.fn();
    fakeAnnotationDom();
    // renderStars() walks the panel's stars; no panel DOM here.
    (g.document as Record<string, unknown>).querySelectorAll = () => [];
  });

  function answerSave(annotation: Record<string, unknown>): void {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ annotation, score: 60 }),
    } as unknown as Response);
  }

  it('posts only the tapped rating', async () => {
    answerSave({ rating: 4 });
    await quickRateShot(5, 'rating', '4');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('api/shots/5/annotate');
    expect(lastBody()).toEqual({ rating: 4 });
    expect(S.shots.find(s => s.id === 5)?.annotation).toEqual({ rating: 4 });
  });

  it('tapping the stored star again clears the rating', async () => {
    S.shots = [{ id: 5, timestamp: 1700000100, annotation: { rating: 4 } }, { id: 1, timestamp: 1700000000, annotation: {} }];
    answerSave({ rating: null });
    await quickRateShot(5, 'rating', '4');
    expect(lastBody()).toEqual({ rating: null });
  });

  it('quick taste tag sets and clears', async () => {
    S.shots = [{ id: 5, timestamp: 1700000100, annotation: { tasteTag: 'sour' } }, { id: 1, timestamp: 1700000000, annotation: {} }];
    answerSave({ tasteTag: 'bitter' });
    await quickRateShot(5, 'tasteTag', 'bitter');
    expect(lastBody()).toEqual({ tasteTag: 'bitter' });

    fetchSpy.mockClear();
    S.shots = [{ id: 5, timestamp: 1700000100, annotation: { tasteTag: 'sour' } }, { id: 1, timestamp: 1700000000, annotation: {} }];
    answerSave({ tasteTag: null });
    await quickRateShot(5, 'tasteTag', 'sour');
    expect(lastBody()).toEqual({ tasteTag: null });
  });

  it('quick rating ignores values it does not know', async () => {
    await quickRateShot(5, 'rating', '9');
    await quickRateShot(5, 'tasteTag', 'astringent');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('quick rating keeps the open panel in step', async () => {
    S.primaryShotId = 5;
    answerSave({ rating: 3 });
    await quickRateShot(5, 'rating', '3');
    expect(S.currentRating).toBe(3);

    answerSave({ tasteTag: 'bitter' });
    await quickRateShot(5, 'tasteTag', 'bitter');
    expect(el('annTasteTag').value).toBe('bitter');
  });

  it('quick rating reports a failed save', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);
    await quickRateShot(5, 'rating', '2');
    expect((g.window as { showToast: unknown }).showToast).toHaveBeenCalledTimes(1);
    expect(S.shots.find(s => s.id === 5)?.annotation).toEqual({});
  });
});
