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
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const {
  _renderTasteTagPills,
  selectTasteTag,
  scheduleAutoSave,
  flushAutoSave,
} = await import('../public-src/views/shots/annotation.js');

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
  const response = { ok: true, json: async () => ({ annotation, score: 50 }) } as unknown as Response;
  fetchSpy.mockResolvedValueOnce(response);
  scheduleAutoSave();
  flushAutoSave();
  return drain();
}

beforeEach(() => {
  vi.useFakeTimers();
  delete (g.window as { updateView?: () => void }).updateView;
  fetchSpy.mockReset();
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
    expect(markup.match(/class="drink-pill active"/g)).toHaveLength(1);
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
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
    const response = { ok: true, json: async () => ({ annotation: { tasteTag: 'sour' }, score: 50 }) } as unknown as Response;
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

  it('keeps the 44 px touch target on mobile', () => {
    expect(read('../public-src/style.css')).toMatch(/\.drink-pill\s*\{\s*min-height: 44px/);
  });
});
