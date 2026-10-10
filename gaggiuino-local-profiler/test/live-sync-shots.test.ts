import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1539 slice 4: the Shots view's live-sync refresh. refreshShots() turns a
// dirtied `shot`/`shots` kind into either an in-place patch of the already
// loaded rows (a single id it still has) or a quiet list reload, and the
// live-sync scheduler's canRun (wired in main.ts) defers a run while this page
// is saving an edit or (re)loading the list. The sidebar and annotation
// modules are spied on through their real implementations (the importOriginal
// pattern) so the assertions see calls without pulling in the full DOM render
// path; annotationBusy() stays real so the save counter is exercised.

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= {};

const spies = vi.hoisted(() => ({
  renderSidebar: vi.fn(),
  updateSidebarHighlighting: vi.fn(),
  renderAnnotationPanel: vi.fn(),
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
}));

vi.mock('../public-src/bean-image.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/bean-image.js')>()),
  invalidateShotImage: spies.invalidateShotImage,
}));

const { S } = await import('../public-src/state/index.js');
const transport = await import('../public-src/api/transport.js');
const apiFetchSpy = vi.spyOn(transport, 'apiFetch');
const { refreshShots, loadData, shotsLoadInProgress } = await import('../public-src/views/shots/index.js');
const { annotationBusy, scheduleAutoSave, flushAutoSave } = await import('../public-src/views/shots/annotation.js');
const { initLiveSync, handleDataChanged, resyncAll } = await import('../public-src/live-sync.js');

// The nodes loadData() writes to and the fields the annotation save reads; a
// generic element is created on first getElementById so both paths are served.
// `shots` starts at a sentinel the quiet path must leave untouched (a non-quiet
// load replaces it with the loading placeholder).
interface FakeEl {
  innerHTML?: string;
  style?: Record<string, string>;
  textContent?: string;
  value?: string;
  selectedOptions?: { dataset: Record<string, unknown> }[];
  classList?: { add: () => void; remove: () => void; contains: () => boolean };
  [key: string]: unknown;
}

function makeEl(): FakeEl {
  return {
    innerHTML: '',
    style: {},
    textContent: '',
    value: '',
    selectedOptions: [{ dataset: {} }],
    classList: { add: () => {}, remove: () => {}, contains: () => false },
  };
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
      getElementById: (id: string) => (elements[id] ??= makeEl()),
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

// Drains the promise continuations a resolved fetch/annotate chains (a few
// microtask hops) without advancing any (possibly faked) timer.
async function flushPromises(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
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
    detailById.set(7, { id: 7, annotation: { rating: 5, notes: 'remote' }, image: 'jpg', score: 91, usedBeanTarget: true });

    await refreshShots(['7']);

    const row = S.allShots[0] as unknown as Record<string, unknown>;
    expect(row.annotation).toEqual({ rating: 5, notes: 'remote' });
    expect(row.image).toBe('jpg');
    expect(row.score).toBe(91);
    expect(row.usedBeanTarget).toBe(true);
    expect(spies.renderSidebar).toHaveBeenCalledTimes(1);
    expect(spies.updateSidebarHighlighting).toHaveBeenCalledTimes(1);
    // The cached photo and its thumbnail are dropped for the changed shot.
    expect(spies.invalidateShotImage).toHaveBeenCalledWith(7);
    expect(spies.renderAnnotationPanel).toHaveBeenCalledTimes(1);
  });

  it('deletes the row image when the detail payload no longer has one', async () => {
    S.allShots = [{ id: 7, timestamp: 1000, image: 'old.jpg' }];
    detailById.set(7, { id: 7, annotation: {}, score: 70, usedBeanTarget: false });

    await refreshShots(['7']);

    const row = S.allShots[0] as unknown as Record<string, unknown>;
    expect('image' in row).toBe(false);
    expect(spies.invalidateShotImage).toHaveBeenCalledWith(7);
  });

  it('re-renders the sidebar once for a batch of dirtied ids', async () => {
    S.allShots = [{ id: 7, timestamp: 1 }, { id: 8, timestamp: 2 }];
    detailById.set(7, { id: 7, annotation: { rating: 1 } });
    detailById.set(8, { id: 8, annotation: { rating: 2 } });

    await refreshShots(['7', '8']);

    expect(spies.renderSidebar).toHaveBeenCalledTimes(1);
    expect(spies.updateSidebarHighlighting).toHaveBeenCalledTimes(1);
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

    expect(docEl.shots?.innerHTML).toBe('KEEP');
    expect(apiFetchSpy).toHaveBeenCalledWith(expect.stringContaining('api/shots?'));
  });

  it('reloads the list quietly when more than five ids are dirtied', async () => {
    await refreshShots(['1', '2', '3', '4', '5', '6']);

    expect(docEl.shots?.innerHTML).toBe('KEEP');
    // No per-shot fetch happened; only the list was reloaded.
    expect(apiFetchSpy).not.toHaveBeenCalledWith(expect.stringMatching(/^api\/shots\/\d+$/));
  });

  it('reloads the list quietly when the dirtied shot is gone', async () => {
    S.allShots = [{ id: 7, timestamp: 1000 }];
    S.primaryShotId = 7;

    await refreshShots(['7']);

    expect(docEl.shots?.innerHTML).toBe('KEEP');
    expect(spies.renderAnnotationPanel).not.toHaveBeenCalled();
    expect(spies.renderSidebar).toHaveBeenCalledTimes(1);
  });
});

describe('quiet reload errors (#1539 slice 4)', () => {
  it('keeps the painted list unchanged on an HTTP error', async () => {
    apiFetchSpy.mockImplementation(() => Promise.resolve({ ok: false, status: 500 } as unknown as Response));

    await loadData({ quiet: true });

    expect(docEl.shots?.innerHTML).toBe('KEEP');
  });

  it('keeps the painted list unchanged on a network error', async () => {
    apiFetchSpy.mockImplementation(() => Promise.reject(new Error('offline')));

    await loadData({ quiet: true });

    expect(docEl.shots?.innerHTML).toBe('KEEP');
  });
});

describe('shotsLoadInProgress (#1539 slice 4)', () => {
  it('is true while a loadData() is in flight and clears afterwards', async () => {
    let releaseList: ((r: Response) => void) | undefined;
    apiFetchSpy.mockImplementation((url: string) => {
      if (url.includes('trash=1')) return Promise.resolve({ ok: false, status: 500 } as unknown as Response);
      if (url.startsWith('api/shots?')) return new Promise<Response>(res => { releaseList = res; });
      return Promise.resolve(jsonResponse({}));
    });

    const pending = loadData();
    expect(shotsLoadInProgress()).toBe(true);

    releaseList?.(jsonResponse({ shots: [], nextCursor: null, hasMore: false }));
    await pending;
    expect(shotsLoadInProgress()).toBe(false);
  });
});

describe('live-sync deferral and resync (#1539 slice 4)', () => {
  it('defers the shot refresh while a save is pending, then runs it', async () => {
    vi.useFakeTimers();
    try {
      S.allShots = [{ id: 7, timestamp: 1000 }];
      S.shots = [{ id: 7, timestamp: 1000 }];
      S.primaryShotId = 7;
      detailById.set(7, { id: 7, annotation: { rating: 4 }, score: 80, usedBeanTarget: true });

      let resolveAnnotate: ((r: Response) => void) | undefined;
      apiFetchSpy.mockImplementation((url: string) => {
        if (url.includes('/annotate')) return new Promise<Response>(res => { resolveAnnotate = res; });
        return Promise.resolve(jsonResponse({}));
      });

      // Mirrors main.ts's `shot` registration.
      initLiveSync({ shot: { canRun: () => !annotationBusy(), run: ids => refreshShots(ids) } });

      scheduleAutoSave();
      expect(annotationBusy()).toBe(true);

      handleDataChanged({ kind: 'shot', id: '7', rev: 1 });
      await vi.advanceTimersByTimeAsync(300); // debounce fires; canRun holds it back
      expect(spies.renderAnnotationPanel).not.toHaveBeenCalled();

      flushAutoSave(); // clears the pending autosave, starts the in-flight save
      expect(annotationBusy()).toBe(true);
      resolveAnnotate?.(jsonResponse({ annotation: {} }));
      await flushPromises();
      await vi.advanceTimersByTimeAsync(0);
      expect(annotationBusy()).toBe(false);

      await vi.advanceTimersByTimeAsync(2000); // the deferred run's retry
      expect(spies.renderAnnotationPanel).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      initLiveSync({});
    }
  });

  it('defers a shots reload while the list is loading, then runs it', async () => {
    vi.useFakeTimers();
    try {
      let releaseList: ((r: Response) => void) | undefined;
      apiFetchSpy.mockImplementation((url: string) => {
        if (url.includes('trash=1')) return Promise.resolve({ ok: false, status: 500 } as unknown as Response);
        if (url.startsWith('api/shots?')) return new Promise<Response>(res => { releaseList = res; });
        return Promise.resolve(jsonResponse({}));
      });

      const reload = vi.fn();
      initLiveSync({ shots: { canRun: () => !shotsLoadInProgress(), run: reload } });

      handleDataChanged({ kind: 'shots', rev: 1 });
      const pending = loadData();
      await vi.advanceTimersByTimeAsync(300); // debounce fires; the load is still in flight
      expect(reload).not.toHaveBeenCalled();

      releaseList?.(jsonResponse({ shots: [], nextCursor: null, hasMore: false }));
      await pending;
      await vi.advanceTimersByTimeAsync(2000); // the deferred run's retry
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      initLiveSync({});
    }
  });

  it('resyncs shots on reconnect but not each individual shot', async () => {
    vi.useFakeTimers();
    try {
      const shotsRun = vi.fn();
      const shotRun = vi.fn();
      initLiveSync({ shots: { run: shotsRun }, shot: { run: shotRun } });

      resyncAll();
      await vi.advanceTimersByTimeAsync(400);

      expect(shotsRun).toHaveBeenCalledTimes(1);
      expect(shotRun).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      initLiveSync({});
    }
  });
});

describe('annotationBusy save counter (#1539 slice 4)', () => {
  it('stays true until overlapping saves both finish', async () => {
    vi.useFakeTimers();
    try {
      S.shots = [{ id: 7, timestamp: 1000 }];
      S.primaryShotId = 7;

      const resolvers: ((r: Response) => void)[] = [];
      apiFetchSpy.mockImplementation((url: string) => {
        if (url.includes('/annotate')) return new Promise<Response>(res => { resolvers.push(res); });
        return Promise.resolve(jsonResponse({}));
      });

      // First save: the debounce fires and its request is still in flight.
      scheduleAutoSave();
      await vi.advanceTimersByTimeAsync(1000);
      expect(resolvers.length).toBe(1);

      // Second save: a flush starts while the first is still running.
      scheduleAutoSave();
      await vi.advanceTimersByTimeAsync(1000);
      expect(resolvers.length).toBe(2);
      expect(annotationBusy()).toBe(true);

      resolvers[0]?.(jsonResponse({ annotation: {} }));
      await flushPromises();
      await vi.advanceTimersByTimeAsync(0);
      // One save is still in flight, so the counter keeps it busy.
      expect(annotationBusy()).toBe(true);

      resolvers[1]?.(jsonResponse({ annotation: {} }));
      await flushPromises();
      await vi.advanceTimersByTimeAsync(0);
      expect(annotationBusy()).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
