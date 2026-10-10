import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1539 slice 4: the Shots view's live-sync refresh. refreshShots() turns a
// dirtied `shot`/`shots` kind into either an in-place patch of the already
// loaded rows (a single id it still has) or a quiet list reload, and defers the
// annotation panel render while this page has an unsaved edit. The sidebar and
// annotation modules are spied on through their real implementations (the
// importOriginal pattern) so the assertions see calls without pulling in the
// full DOM render path.

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

const spies = vi.hoisted(() => ({
  renderSidebar: vi.fn(),
  updateSidebarHighlighting: vi.fn(),
  renderAnnotationPanel: vi.fn(),
  annotationBusy: vi.fn(),
  invalidateShotImage: vi.fn(),
}));

vi.mock('../public-src/components/sidebar.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/components/sidebar.js')>()),
  renderSidebar: spies.renderSidebar,
  updateSidebarHighlighting: spies.updateSidebarHighlighting,
}));

vi.mock('../public-src/views/shots/annotation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/views/shots/annotation.js')>()),
  renderAnnotationPanel: spies.renderAnnotationPanel,
  annotationBusy: spies.annotationBusy,
}));

vi.mock('../public-src/bean-image.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/bean-image.js')>()),
  invalidateShotImage: spies.invalidateShotImage,
}));

const { S } = await import('../public-src/state/index.js');
const transport = await import('../public-src/api/transport.js');
const apiFetchSpy = vi.spyOn(transport, 'apiFetch');
const { refreshShots } = await import('../public-src/views/shots/index.js');

// The nodes loadData() writes to; it only touches innerHTML/style on each, so
// both stay optional. `shots` starts at a sentinel the quiet path must leave
// untouched (a non-quiet load replaces it with the loading placeholder).
interface FakeEl {
  innerHTML?: string;
  style?: Record<string, string>;
  textContent?: string;
}

function fakeDocument() {
  const elements: Record<string, FakeEl> = {
    shots:         { innerHTML: 'KEEP' },
    'empty-state': { style: {} },
    'chart-area':  { style: {} },
  };
  return {
    elements,
    document: {
      getElementById: (id: string) => elements[id],
      querySelectorAll: () => [],
    },
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function notFound(): Response {
  return { ok: false, status: 404, json: () => Promise.resolve(null) } as unknown as Response;
}

// Routes the real apiFetch: GET /api/shots/{id} serves the registered single
// shot (or 404), the trash fetch fails so loadTrashData() bails before its DOM
// render, and the plain list returns an empty page.
let detailById: Map<number, unknown>;
let docEl: Record<string, FakeEl>;

function installFetch(): void {
  apiFetchSpy.mockImplementation((url: string) => {
    const m = /^api\/shots\/(\d+)$/.exec(url);
    if (m) {
      const id = Number(m[1]);
      return Promise.resolve(detailById.has(id) ? jsonResponse(detailById.get(id)) : notFound());
    }
    if (url.includes('trash=1')) return Promise.resolve({ ok: false, status: 500 } as unknown as Response);
    return Promise.resolve(jsonResponse({ shots: [], nextCursor: null, hasMore: false }));
  });
}

beforeEach(() => {
  apiFetchSpy.mockReset();
  spies.renderSidebar.mockReset();
  spies.updateSidebarHighlighting.mockReset();
  spies.renderAnnotationPanel.mockReset();
  spies.invalidateShotImage.mockReset();
  spies.annotationBusy.mockReset();
  spies.annotationBusy.mockReturnValue(false);
  detailById = new Map();
  installFetch();

  const made = fakeDocument();
  g.document = made.document;
  docEl = made.elements;

  S.allShots = [];
  S.shots = [];
  S.primaryShotId = null;
  // No machine matches, so loadData()'s S.shots stays empty and updateView()
  // (the full chart render path) never runs.
  S.activeMachineId = 999;
});

describe('refreshShots (#1539 slice 4)', () => {
  it('patches the loaded row and re-renders the sidebar', async () => {
    S.allShots = [{ id: 7, timestamp: 1000 }];
    S.primaryShotId = 7;
    detailById.set(7, { id: 7, annotation: { rating: 5, notes: 'remote' }, image: 'jpg', score: 91 });

    await refreshShots(['7']);

    const row = S.allShots[0] as unknown as Record<string, unknown>;
    expect(row.annotation).toEqual({ rating: 5, notes: 'remote' });
    expect(row.image).toBe('jpg');
    expect(row.score).toBe(91);
    expect(spies.renderSidebar).toHaveBeenCalledTimes(1);
    expect(spies.updateSidebarHighlighting).toHaveBeenCalledTimes(1);
    // The cached photo and its thumbnail are dropped for the changed shot.
    expect(spies.invalidateShotImage).toHaveBeenCalledWith(7);
    expect(spies.renderAnnotationPanel).toHaveBeenCalledTimes(1);
  });

  it('does not re-render the annotation panel while a save is pending', async () => {
    spies.annotationBusy.mockReturnValue(true);
    S.allShots = [{ id: 7, timestamp: 1000 }];
    S.primaryShotId = 7;
    detailById.set(7, { id: 7, annotation: { rating: 4 } });

    await refreshShots(['7']);

    expect(spies.renderAnnotationPanel).not.toHaveBeenCalled();
    // The list entry still updates; only the open panel is held back.
    expect((S.allShots[0] as unknown as Record<string, unknown>).annotation).toEqual({ rating: 4 });
    expect(spies.renderSidebar).toHaveBeenCalledTimes(1);
  });

  it('does not re-render the panel when the dirtied shot is not the open one', async () => {
    S.allShots = [{ id: 7, timestamp: 1000 }];
    S.primaryShotId = 9;
    detailById.set(7, { id: 7, annotation: { rating: 4 } });

    await refreshShots(['7']);

    expect(spies.renderAnnotationPanel).not.toHaveBeenCalled();
  });

  it('ignores an id outside the loaded window', async () => {
    S.allShots = [{ id: 1, timestamp: 1000 }];
    detailById.set(7, { id: 7, annotation: { rating: 4 } });

    await refreshShots(['7']);

    expect(spies.renderSidebar).not.toHaveBeenCalled();
    expect(spies.invalidateShotImage).not.toHaveBeenCalled();
  });

  it('reloads the list quietly when ids is null, without the loading placeholder', async () => {
    await refreshShots(null);

    expect(docEl.shots.innerHTML).toBe('KEEP');
    expect(apiFetchSpy).toHaveBeenCalledWith(expect.stringContaining('api/shots?'));
  });

  it('reloads the list quietly when more than five ids are dirtied', async () => {
    await refreshShots(['1', '2', '3', '4', '5', '6']);

    expect(docEl.shots.innerHTML).toBe('KEEP');
    // No per-shot fetch happened; only the list was reloaded.
    expect(apiFetchSpy).not.toHaveBeenCalledWith(expect.stringMatching(/^api\/shots\/\d+$/));
  });

  it('reloads the list quietly when the dirtied shot is gone', async () => {
    S.allShots = [{ id: 7, timestamp: 1000 }];
    S.primaryShotId = 7;

    await refreshShots(['7']);

    expect(docEl.shots.innerHTML).toBe('KEEP');
    expect(spies.renderAnnotationPanel).not.toHaveBeenCalled();
    expect(spies.renderSidebar).toHaveBeenCalledTimes(1);
  });
});
