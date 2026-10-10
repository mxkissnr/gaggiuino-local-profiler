import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// #1539 slice 3: the live-sync core, its transport identity header, the image
// cache invalidation it drives, and the boot wiring it plugs into. The module
// keeps its state (seen revisions, dirty kinds, listeners) at module scope, so
// every test loads a fresh instance through vi.resetModules(). The minimum
// browser globals the import chain (state.js/ui-prefs.js) needs are stubbed
// first, same convention as the other frontend tests.

const g = globalThis as unknown as Record<string, unknown>;
const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => (_store.has(k) ? _store.get(k) ?? null : null),
  setItem: (k: string, v: string) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };

// A constructible stand-in for the browser's URL: bean-image needs
// URL.createObjectURL (absent in Node), while vitest's own internals still need
// `new URL(...)` to keep working during a test that stubs it.
class URLStub extends URL {
  static createObjectURL = vi.fn(() => 'blob:x');
}

// The bean/grinder API is mocked so the "library handler preserves an open
// sheet form" test can drive the real library render path without the network;
// the other exports stay real (sticker-cutout/library-sheet test pattern).
const mocks = vi.hoisted(() => ({ getLibrary: vi.fn() }));
vi.mock('../public-src/api/library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/library.js')>();
  return { ...actual, getLibrary: mocks.getLibrary };
});

type Listener = (e?: unknown) => void;

interface FakeClassList {
  add(name: string): void;
  remove(name: string): void;
  contains(name: string): boolean;
}

interface FakeOverlay {
  style: { display: string };
}

interface FakeDoc {
  visibilityState: string;
  activeElement: unknown;
  body: { classList: FakeClassList };
  addEventListener(type: string, cb: Listener): void;
  dispatch(type: string): void;
  querySelector(sel: string): unknown;
  querySelectorAll(sel: string): FakeOverlay[];
}

function makeDoc(): FakeDoc {
  const listeners = new Map<string, Listener[]>();
  const classes = new Set<string>();
  return {
    visibilityState: 'visible',
    activeElement: null,
    body: {
      classList: {
        add: (name) => { classes.add(name); },
        remove: (name) => { classes.delete(name); },
        contains: (name) => classes.has(name),
      },
    },
    addEventListener(type, cb) {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
    dispatch(type) {
      for (const cb of listeners.get(type) ?? []) cb();
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

// A focused text field (no type counts as text) blocks a background refetch; a
// checkbox, select or other non-text control does not.
function inputEl(): unknown {
  return { tagName: 'INPUT', type: 'text', isContentEditable: false };
}

function checkboxEl(): unknown {
  return { tagName: 'INPUT', type: 'checkbox', isContentEditable: false };
}

function selectEl(): unknown {
  return { tagName: 'SELECT', isContentEditable: false };
}

function bodyEl(): unknown {
  return { tagName: 'BODY', isContentEditable: false };
}

// Loads a fresh live-sync (plus the transport it imports) so no revision,
// dirty-kind or listener state leaks between tests. CLIENT_ID comes from the
// same module instance live-sync compared against.
async function loadLive() {
  vi.resetModules();
  const transport = await import('../public-src/api/transport.js');
  const live = await import('../public-src/live-sync.js');
  return { live, transport, CLIENT_ID: transport.CLIENT_ID };
}

let doc: FakeDoc;

beforeEach(() => {
  _store.clear();
  doc = makeDoc();
  g.document = doc;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live-sync handleDataChanged', () => {
  it('skips an own echo once its baseline revision is recorded', async () => {
    const { live, CLIENT_ID } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    live.noteServerRevs('e1', { library: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();

    live.handleDataChanged({ kind: 'library', rev: 2, epoch: 'e1', src: CLIENT_ID });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('marks the kind dirty on an own echo with no baseline', async () => {
    const { live, CLIENT_ID } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1', src: CLIENT_ID });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('ignores equal and lower revisions and reacts to a higher one', async () => {
    const { live } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    live.handleDataChanged({ kind: 'library', rev: 2, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);

    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1' });
    live.handleDataChanged({ kind: 'library', rev: 2, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);

    live.handleDataChanged({ kind: 'library', rev: 3, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst of events into a single run', async () => {
    const { live } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(50);
    live.handleDataChanged({ kind: 'library', rev: 2, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(50);
    live.handleDataChanged({ kind: 'library', rev: 3, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(null);
  });

  it('passes the dirtied ids and collects several from a burst', async () => {
    const { live } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1', id: '7' });
    live.handleDataChanged({ kind: 'library', rev: 2, epoch: 'e1', id: '9' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.arrayContaining(['7', '9']));
  });

  it('reruns exactly once when dirtied during a run', async () => {
    const { live } = await loadLive();
    let resolveRun: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((res) => { resolveRun = res; }));
    live.initLiveSync({ library: { run } });

    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);

    live.handleDataChanged({ kind: 'library', rev: 2, epoch: 'e1' });
    live.handleDataChanged({ kind: 'library', rev: 3, epoch: 'e1' });
    resolveRun();
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(2);

    resolveRun();
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('defers while an input is focused and retries on focusout', async () => {
    const { live } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    doc.activeElement = inputEl();
    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();

    doc.activeElement = bodyEl();
    doc.dispatch('focusout');
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('defers while the tab is hidden and flushes when visible', async () => {
    const { live } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    doc.visibilityState = 'hidden';
    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();

    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reloads once on a remote all event, not per kind', async () => {
    const { live } = await loadLive();
    const reload = vi.fn();
    const library = vi.fn();
    live.initLiveSync({ library: { run: library }, all: { run: reload } });

    live.handleDataChanged({ kind: 'all', epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(library).not.toHaveBeenCalled();
  });

  it('defers the all reload while an input is focused and retries on focusout', async () => {
    const { live } = await loadLive();
    const reload = vi.fn();
    live.initLiveSync({ all: { run: reload } });

    doc.activeElement = inputEl();
    live.handleDataChanged({ kind: 'all', epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).not.toHaveBeenCalled();

    doc.activeElement = bodyEl();
    doc.dispatch('focusout');
    await vi.advanceTimersByTimeAsync(10);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('records but does not refetch an unregistered kind', async () => {
    const { live } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    live.handleDataChanged({ kind: 'settings', rev: 1, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();

    live.noteServerRevs('e1', { settings: 2 });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('live-sync revisions and epochs', () => {
  it('treats the first status snapshot as a baseline, later higher revisions as changes', async () => {
    const { live } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    live.noteServerRevs('e1', { library: 5 });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();

    live.noteServerRevs('e1', { library: 5 });
    live.noteServerRevs('e1', { library: 4 });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();

    live.noteServerRevs('e1', { library: 6 });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('resets and refetches every registered kind on an epoch change, except photos', async () => {
    const { live } = await loadLive();
    const library = vi.fn();
    const orders = vi.fn();
    const image = vi.fn();
    live.initLiveSync({ library: { run: library }, orders: { run: orders }, 'library-image': { run: image } });

    live.handleDataChanged({ kind: 'library', rev: 5, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(library).toHaveBeenCalledTimes(1);
    expect(image).not.toHaveBeenCalled();

    library.mockClear();
    orders.mockClear();
    image.mockClear();
    live.handleDataChanged({ kind: 'orders', rev: 1, epoch: 'e2' });
    await vi.advanceTimersByTimeAsync(400);
    expect(library).toHaveBeenCalledTimes(1);
    expect(orders).toHaveBeenCalledTimes(1);
    // The epoch change refetches the resync kinds but not the photo cache.
    expect(image).not.toHaveBeenCalled();
  });
});

describe('live-sync review fixes (#1539)', () => {
  it('resyncAll marks every resync kind dirty but leaves photos alone', async () => {
    const { live } = await loadLive();
    const library = vi.fn();
    const orders = vi.fn();
    const image = vi.fn();
    live.initLiveSync({ library: { run: library }, orders: { run: orders }, 'library-image': { run: image } });

    live.resyncAll();
    await vi.advanceTimersByTimeAsync(400);
    expect(library).toHaveBeenCalledTimes(1);
    expect(orders).toHaveBeenCalledTimes(1);
    expect(library).toHaveBeenCalledWith(null);
    // A reconnect must not evict and re-download the whole photo cache.
    expect(image).not.toHaveBeenCalled();
  });

  it('still refetches a photo change from its own event and the status revision check', async () => {
    const { live } = await loadLive();
    const image = vi.fn();
    live.initLiveSync({ 'library-image': { run: image } });

    live.handleDataChanged({ kind: 'library-image', rev: 1, epoch: 'e1', id: 'bean:1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(image).toHaveBeenCalledTimes(1);
    expect(image).toHaveBeenCalledWith(['bean:1']);

    live.noteServerRevs('e1', { 'library-image': 2 }); // baseline, no change
    await vi.advanceTimersByTimeAsync(400);
    expect(image).toHaveBeenCalledTimes(1);

    live.noteServerRevs('e1', { 'library-image': 3 }); // a missed write catches up
    await vi.advanceTimersByTimeAsync(400);
    expect(image).toHaveBeenCalledTimes(2);
  });

  it('defers the all reload while a sheet is open and runs after it closes', async () => {
    const { live } = await loadLive();
    const reload = vi.fn();
    live.initLiveSync({ all: { run: reload, canRun: () => !live.reloadBlocked() } });

    doc.body.classList.add('lib-sheet-open');
    live.handleDataChanged({ kind: 'all', epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).not.toHaveBeenCalled();

    doc.body.classList.remove('lib-sheet-open');
    await vi.advanceTimersByTimeAsync(2000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('defers the all reload while a modal overlay is visible, even with no text focus', async () => {
    const { live } = await loadLive();
    const reload = vi.fn();
    live.initLiveSync({ all: { run: reload, canRun: () => !live.reloadBlocked() } });

    // E.g. the profile editor: a .guided-maint-overlay shown via inline display,
    // while a select/checkbox (which no longer blocks on its own) has focus.
    doc.activeElement = selectEl();
    doc.querySelectorAll = () => [{ style: { display: 'flex' } }];
    live.handleDataChanged({ kind: 'all', epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).not.toHaveBeenCalled();

    // The hidden default (display:none) does not block.
    doc.querySelectorAll = () => [{ style: { display: 'none' } }];
    await vi.advanceTimersByTimeAsync(2000);
    expect(reload).toHaveBeenCalledTimes(1);
    doc.activeElement = null;
  });

  it('defers the all reload while a native dialog is open', async () => {
    const { live } = await loadLive();
    const reload = vi.fn();
    live.initLiveSync({ all: { run: reload, canRun: () => !live.reloadBlocked() } });

    doc.querySelector = (sel: string) => (sel === 'dialog[open]' ? { tagName: 'DIALOG' } : null);
    live.handleDataChanged({ kind: 'all', epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).not.toHaveBeenCalled();

    doc.querySelector = () => null;
    await vi.advanceTimersByTimeAsync(2000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('blocks a run on text entry but not on a checkbox or select', async () => {
    const { live } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    doc.activeElement = checkboxEl();
    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);

    doc.activeElement = selectEl();
    live.handleDataChanged({ kind: 'library', rev: 2, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(2);

    doc.activeElement = inputEl();
    live.handleDataChanged({ kind: 'library', rev: 3, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('marks the kind dirty when an own echo skipped a revision', async () => {
    const { live, CLIENT_ID } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    run.mockClear();

    // Our own write is rev 3 but rev 2 was never seen: a remote change slipped
    // in, so the echo must not hide it.
    live.handleDataChanged({ kind: 'library', rev: 3, epoch: 'e1', src: CLIENT_ID });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never lowers lastSeen on a stale own echo', async () => {
    const { live, CLIENT_ID } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    live.handleDataChanged({ kind: 'library', rev: 5, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    run.mockClear();

    // A stale own echo (4) must not lower the 5 watermark, so a later remote 5
    // is still recognised as already seen.
    live.handleDataChanged({ kind: 'library', rev: 4, epoch: 'e1', src: CLIENT_ID });
    live.handleDataChanged({ kind: 'library', rev: 5, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('records the revs of an all event so a later status poll is quiet', async () => {
    const { live } = await loadLive();
    const reload = vi.fn();
    const library = vi.fn();
    live.initLiveSync({ library: { run: library }, all: { run: reload } });

    live.noteServerRevs('e1', { library: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(library).not.toHaveBeenCalled();

    live.handleDataChanged({ kind: 'all', epoch: 'e1', revs: { library: 7, orders: 4 } });
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).toHaveBeenCalledTimes(1);

    live.noteServerRevs('e1', { library: 7, orders: 4 });
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(library).not.toHaveBeenCalled();
  });

  it('records but does not reload on an own all echo', async () => {
    const { live, CLIENT_ID } = await loadLive();
    const reload = vi.fn();
    const library = vi.fn();
    live.initLiveSync({ library: { run: library }, all: { run: reload } });

    live.noteServerRevs('e1', { library: 2 });
    await vi.advanceTimersByTimeAsync(400);
    expect(library).not.toHaveBeenCalled();

    live.handleDataChanged({ kind: 'all', epoch: 'e1', revs: { library: 9 }, src: CLIENT_ID });
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).not.toHaveBeenCalled();
    expect(library).not.toHaveBeenCalled();

    // The echo's revs were recorded, so the status poll at the same revs is quiet.
    live.noteServerRevs('e1', { library: 9 });
    await vi.advanceTimersByTimeAsync(400);
    expect(reload).not.toHaveBeenCalled();
    expect(library).not.toHaveBeenCalled();
  });

  it('retries a canRun-deferred kind by timer and runs it once allowed', async () => {
    const { live } = await loadLive();
    const run = vi.fn();
    let allowed = false;
    live.initLiveSync({ library: { run, canRun: () => allowed } });

    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();

    // Still blocked: the 2 s poll fires but stays deferred.
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).not.toHaveBeenCalled();

    allowed = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(1);

    // Once it ran it is not rescheduled.
    await vi.advanceTimersByTimeAsync(4000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('live-sync own-write and resync dedup (#1539)', () => {
  it('does not refetch a status rev bump within 5 s of an own write', async () => {
    const { live, transport } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)));

    live.noteServerRevs('e1', { library: 1 }); // baseline
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();

    // This page writes; the server's next status snapshot reports the bump
    // before that write's SSE echo has arrived.
    await transport.apiFetch('api/x', { method: 'POST' });
    live.noteServerRevs('e1', { library: 2 });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('refetches a status rev bump more than 5 s after an own write', async () => {
    const { live, transport } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)));

    live.noteServerRevs('e1', { library: 1 }); // baseline
    await vi.advanceTimersByTimeAsync(400);
    await transport.apiFetch('api/x', { method: 'POST' });

    // Past the grace window the higher revision is no longer assumed to be ours.
    await vi.advanceTimersByTimeAsync(5100);
    live.noteServerRevs('e1', { library: 2 });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('collapses two resyncAll calls within 2 s into one round', async () => {
    const { live } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    live.resyncAll();
    live.resyncAll();
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(1);

    // A later call, past the throttle, resyncs again.
    await vi.advanceTimersByTimeAsync(2000);
    live.resyncAll();
    await vi.advanceTimersByTimeAsync(400);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('client identity header (#1539)', () => {
  it('sends X-GLP-Client on a write but not on a read', async () => {
    vi.resetModules();
    const { S } = (await import('../public-src/state/index.js')) as unknown as {
      S: { glpToken: string };
    };
    S.glpToken = '';
    const transport = await import('../public-src/api/transport.js');
    const fetchMock = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(
      () => Promise.resolve({ ok: true } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    await transport.apiFetch('api/x', { method: 'POST' });
    await transport.apiFetch('api/x');

    const postCall = fetchMock.mock.calls[0] as [string, RequestInit?] | undefined;
    expect(postCall?.[1]?.headers).toEqual({ 'X-GLP-Client': transport.CLIENT_ID });
    const getCall = fetchMock.mock.calls[1] as [string, RequestInit?] | undefined;
    expect(getCall?.[1]?.headers).toBeUndefined();
  });
});

describe('bean-image invalidation (#1539)', () => {
  function imageResponse(): Response {
    return { ok: true, blob: () => Promise.resolve(new Blob(['x'])) } as unknown as Response;
  }

  it('invalidateImageKeys drops exactly the given keys', async () => {
    vi.resetModules();
    const { S } = (await import('../public-src/state/index.js')) as unknown as {
      S: { glpToken: string };
    };
    S.glpToken = '';
    const beanImage = await import('../public-src/bean-image.js');
    const fetchMock = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(imageResponse()),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', URLStub);

    await beanImage.loadBeanImageBlobUrl(1);
    await beanImage.loadBeanImageBlobUrl(2);
    await beanImage.loadShotImageBlobUrl(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    beanImage.invalidateImageKeys(['bean:1', 'shot:3']);
    await Promise.resolve();

    // Only the named entries were dropped.
    await beanImage.loadBeanImageBlobUrl(1); // dropped -> refetch
    await beanImage.loadBeanImageBlobUrl(2); // kept -> no request
    await beanImage.loadShotImageBlobUrl(3); // dropped -> refetch
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[3]?.[0]).toBe('api/library/bean/1/image');
    expect(fetchMock.mock.calls[4]?.[0]).toBe('api/shots/3/image');
  });

  it('invalidateImageKeys(null) drops every library photo key but not shot photos', async () => {
    vi.resetModules();
    const { S } = (await import('../public-src/state/index.js')) as unknown as {
      S: { glpToken: string };
    };
    S.glpToken = '';
    const beanImage = await import('../public-src/bean-image.js');
    const fetchMock = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(imageResponse()),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', URLStub);

    await beanImage.loadBeanImageBlobUrl(1);
    await beanImage.loadGrinderImageBlobUrl(2);
    await beanImage.loadBasketImageBlobUrl(3);
    await beanImage.loadPuckScreenImageBlobUrl(4);
    await beanImage.loadShotImageBlobUrl(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    beanImage.invalidateImageKeys(null);
    await Promise.resolve();

    await beanImage.loadBeanImageBlobUrl(1); // dropped -> refetch
    await beanImage.loadGrinderImageBlobUrl(2); // dropped -> refetch
    await beanImage.loadBasketImageBlobUrl(3); // dropped -> refetch
    await beanImage.loadPuckScreenImageBlobUrl(4); // dropped -> refetch
    await beanImage.loadShotImageBlobUrl(5); // kept -> no request
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it('invalidateImageKeys() with no keys drops every library photo key', async () => {
    vi.resetModules();
    const { S } = (await import('../public-src/state/index.js')) as unknown as {
      S: { glpToken: string };
    };
    S.glpToken = '';
    const beanImage = await import('../public-src/bean-image.js');
    const fetchMock = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(imageResponse()),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', URLStub);

    await beanImage.loadBeanImageBlobUrl(1);
    beanImage.invalidateImageKeys();
    await Promise.resolve();
    await beanImage.loadBeanImageBlobUrl(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateShotImage drops the shot and its thumbnail', async () => {
    vi.resetModules();
    const { S } = (await import('../public-src/state/index.js')) as unknown as {
      S: { glpToken: string };
    };
    S.glpToken = '';
    const beanImage = await import('../public-src/bean-image.js');
    const fetchMock = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(imageResponse()),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', URLStub);

    await beanImage.loadShotImageBlobUrl(2);
    await beanImage.loadShotThumbBlobUrl(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await beanImage.loadShotImageBlobUrl(2);
    await beanImage.loadShotThumbBlobUrl(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    beanImage.invalidateShotImage(2);
    await Promise.resolve();
    await beanImage.loadShotImageBlobUrl(2);
    await beanImage.loadShotThumbBlobUrl(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]?.[0]).toBe('api/shots/2/image?thumb=1');
  });
});

describe('boot wiring (#1539)', () => {
  it('applies live ui-prefs only on a change and keeps the shelf query', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    // The live ui-prefs handler reloads the server prefs, applies them only when
    // the merge reported a change, excludes the machine selection (each device
    // keeps its own) and keeps the session's shelf search.
    expect(src).toMatch(/'ui-prefs':\s*\{[\s\S]*?const changed = await loadUiPrefsFromServer\(\);\s*\n\s*if \(changed\) applyServerUiPrefs\(false, true\)/);
    expect(src).toMatch(/function applyServerUiPrefs\(includeMachine = true, keepShelfQuery = false\)/);
    expect(src).toMatch(/resetShelfPrefs\(keepShelfQuery\)/);
    expect(src).toMatch(/if \(!includeMachine\) return;/);

    const libSrc = readFileSync(new URL('../public-src/views/library.ts', import.meta.url), 'utf8');
    expect(libSrc).toMatch(/export function resetShelfPrefs\(keepQuery = false\): void/);
    expect(libSrc).toMatch(/keepQuery \? \(_shelfPrefsLazy\?\.query \?\? ''\) : ''/);
  });

  it('does not touch the photo cache on a library change but drops keys on library-image', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    // A plain library change is usually a shot-derived stock change, which does
    // not touch the photos, so the handler only reloads the library...
    expect(src).toMatch(/library:\s*\{[\s\S]*?run: async \(\) => \{ await loadLibrary\(\); \}/);
    // ...while library-image drops the cache keys the server sent (null = all
    // library photos) and reloads the library.
    expect(src).toMatch(/'library-image':\s*\{[\s\S]*?invalidateImageKeys\(ids\)/);
    // A remote whole-database change reloads the page through the all handler.
    expect(src).toMatch(/all:\s*\{[\s\S]*?location\.reload\(\)/);
    // There is no longer a whole-cache wipe.
    expect(src).not.toContain('invalidateAllImages');
    expect(src).not.toContain('invalidateLibraryImages');
  });

  it('gates the maintenance refetch only inside the maintenance view', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/canRun: \(\) => _maintenanceCanRefetch\(\)/);
    expect(src).toMatch(/if \(S\.currentMode !== 'maintenance'\) return true;/);
    expect(src).toMatch(/getElementById\('maintLogForm'\)/);
    // An expanded card is restored by the run, not used to block it.
    expect(src).not.toContain("querySelector('.maint-card.expanded')");
    expect(src).toMatch(/await refreshMaintenanceView\(\)/);
    // The "disabled tasks" details are no longer a guard.
    expect(src).not.toMatch(/querySelector\('details\[open\]'\)/);

    const maintSrc = readFileSync(new URL('../public-src/views/maintenance.ts', import.meta.url), 'utf8');
    expect(maintSrc).toMatch(/export async function refreshMaintenanceView\(\): Promise<void>/);
    expect(maintSrc).toMatch(/\.maint-card\.expanded \.maint-detail-toggle/);
  });

  it('holds the all reload back when a sheet or dialog is open', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/import \{[^}]*reloadBlocked[^}]*\} from '\.\/live-sync\.js'/);
    expect(src).toMatch(/canRun: \(\) => !reloadBlocked\(\)/);
  });

  it('checks the app modal overlays, not just bottom sheets, before a reload', () => {
    const src = readFileSync(new URL('../public-src/live-sync.ts', import.meta.url), 'utf8');
    // The modals index.html defines: .guided-maint-overlay (profile/dial-in
    // editors, guided maintenance, flavor wheel, brew confirm) plus the
    // backup/scan dialogs opened through their .open class.
    expect(src).toMatch(/const OVERLAY_SELECTOR = '\.guided-maint-overlay, #backupModal\.open, #scanModal\.open'/);
    expect(src).toMatch(/querySelectorAll\(OVERLAY_SELECTOR\)/);
  });

  it('awaits both order fetches inside one run', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/await Promise\.all\(\[loadDrinkMenu\(\), S\.currentMode === 'orders' \? loadOrdersView\(\) : undefined\]\)/);
  });

  it('registers the data-changed handler before opening the SSE stream', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    const on = src.indexOf('onEvent(EVENTS.DATA_CHANGED, handleDataChanged)');
    const connect = src.indexOf('connectEvents(() => {}, resyncAll)');
    expect(on).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(-1);
    expect(on).toBeLessThan(connect);
  });

  it('resyncs after coming online and after an SSE reconnect', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/addEventListener\('online', resyncAll\)/);
    expect(src).toMatch(/connectEvents\(\(\) => \{\}, resyncAll\)/);
  });
});

// ── Library handler integration: an open bean-sheet inline form survives the
// refetch (reusing the #1412 capture/restore helpers through the real render
// path, exactly as the live library handler drives it).

interface FakeEl {
  id: string;
  className: string;
  innerHTML: string;
  value: string;
  style: Record<string, string>;
  querySelector: () => null;
  querySelectorAll: (sel: string) => FakeEl[];
  classList: { add: () => void; remove: () => void };
  focus: () => void;
}

function makeNode(): FakeEl {
  return {
    id: '', className: '', innerHTML: '', value: '', style: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add: () => {}, remove: () => {} },
    focus: () => {},
  };
}

function fakeSheetDocument() {
  const elements: Record<string, FakeEl> = { beanListUI: makeNode(), grinderListUI: makeNode() };
  const body = {
    classList: { add: () => {}, remove: () => {} },
    appendChild: (el: FakeEl) => { elements[el.id] = el; },
  };
  const document = {
    getElementById: (id: string): FakeEl | null => elements[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeNode(),
    body,
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    contains: () => true,
  };
  return { elements, document };
}

function el(over: Partial<FakeEl>): FakeEl {
  return { ...makeNode(), ...over };
}

describe('library handler keeps an open bean-sheet form (#1539)', () => {
  it('preserves an inline form and its typed value through a live library refetch', async () => {
    vi.resetModules();
    const { S } = (await import('../public-src/state/index.js')) as unknown as {
      S: { shots: unknown[]; currentLang: string; coffeeLibrary: unknown };
    };
    const live = await import('../public-src/live-sync.js');
    const library = (await import('../public-src/views/library.js')) as unknown as {
      openBeanSheet: (id: number) => void;
      loadLibrary: () => Promise<void>;
    };

    const made = fakeSheetDocument();
    g.document = made.document;
    S.shots = [];
    S.currentLang = 'en';
    const bean = {
      id: 1, name: 'Bean',
      bags: [{ id: 1, stock_g: 250, consumedG: 100, remainingG: 150, current: true, roastDate: '2026-01-01' }],
    };
    S.coffeeLibrary = { beans: [bean], grinders: [] };
    mocks.getLibrary.mockResolvedValue({ beans: [bean], grinders: [] });

    library.openBeanSheet(1);
    // The open form the capture reads; the refetch replaces the markup with a
    // fresh, closed copy, which the restore then has to reopen and refill.
    const typed = el({
      id: 'newBagForm1', style: { display: '' },
      querySelectorAll: () => [el({ id: 'newBagStock1', value: '250' })],
    });
    made.elements.beanSheet!.querySelectorAll = (sel: string) => (sel === '.lib-new-bag-form' ? [typed] : []);
    made.elements.newBagForm1 = el({ id: 'newBagForm1', style: { display: 'none' } });
    made.elements.newBagStock1 = el({ id: 'newBagStock1', value: '' });

    live.initLiveSync({
      library: { run: async () => { await library.loadLibrary(); } },
    });
    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);

    expect(mocks.getLibrary).toHaveBeenCalled();
    expect(made.elements.newBagForm1.style.display).toBe('');
    expect(made.elements.newBagStock1.value).toBe('250');
  });
});
