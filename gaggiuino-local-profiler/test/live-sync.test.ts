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

interface FakeDoc {
  visibilityState: string;
  activeElement: unknown;
  addEventListener(type: string, cb: Listener): void;
  dispatch(type: string): void;
}

function makeDoc(): FakeDoc {
  const listeners = new Map<string, Listener[]>();
  return {
    visibilityState: 'visible',
    activeElement: null,
    addEventListener(type, cb) {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
    dispatch(type) {
      for (const cb of listeners.get(type) ?? []) cb();
    },
  };
}

function inputEl(): unknown {
  return { tagName: 'INPUT', isContentEditable: false };
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
  return { live, CLIENT_ID: transport.CLIENT_ID };
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
  it('skips the event its own write produced', async () => {
    const { live, CLIENT_ID } = await loadLive();
    const run = vi.fn();
    live.initLiveSync({ library: { run } });

    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1', src: CLIENT_ID });
    await vi.advanceTimersByTimeAsync(400);
    expect(run).not.toHaveBeenCalled();
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

  it('refetches every registered kind on an all event', async () => {
    const { live } = await loadLive();
    const library = vi.fn();
    const orders = vi.fn();
    live.initLiveSync({ library: { run: library }, orders: { run: orders } });

    live.handleDataChanged({ kind: 'all', epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(library).toHaveBeenCalledTimes(1);
    expect(orders).toHaveBeenCalledTimes(1);
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

  it('resets and refetches every registered kind when the epoch changes', async () => {
    const { live } = await loadLive();
    const library = vi.fn();
    const orders = vi.fn();
    live.initLiveSync({ library: { run: library }, orders: { run: orders } });

    live.handleDataChanged({ kind: 'library', rev: 5, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);
    expect(library).toHaveBeenCalledTimes(1);

    library.mockClear();
    orders.mockClear();
    live.handleDataChanged({ kind: 'orders', rev: 1, epoch: 'e2' });
    await vi.advanceTimersByTimeAsync(400);
    expect(library).toHaveBeenCalledTimes(1);
    expect(orders).toHaveBeenCalledTimes(1);
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

  it('invalidateLibraryImages drops only the library keys', async () => {
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
    await beanImage.loadShotImageBlobUrl(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Both are cached, so repeated loads add no requests.
    await beanImage.loadBeanImageBlobUrl(1);
    await beanImage.loadShotImageBlobUrl(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    beanImage.invalidateLibraryImages();
    await beanImage.loadBeanImageBlobUrl(1); // library key dropped -> refetch
    await beanImage.loadShotImageBlobUrl(2); // shot key kept -> no request
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('api/library/bean/1/image');
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
    await beanImage.loadShotImageBlobUrl(2);
    await beanImage.loadShotThumbBlobUrl(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3]?.[0]).toBe('api/shots/2/image?thumb=1');
  });
});

describe('boot wiring (#1539)', () => {
  it('applies live ui-prefs without the machine selection', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    // The live ui-prefs handler reloads the server prefs and applies them with
    // the machine selection excluded, so each device keeps its own choice.
    expect(src).toMatch(/'ui-prefs':\s*\{[\s\S]*?applyServerUiPrefs\(false\)/);
    expect(src).toMatch(/function applyServerUiPrefs\(includeMachine = true\)/);
    expect(src).toMatch(/if \(!includeMachine\) return;/);
  });

  it('registers the data-changed handler before opening the SSE stream', () => {
    const src = readFileSync(new URL('../public-src/main.ts', import.meta.url), 'utf8');
    const on = src.indexOf('onEvent(EVENTS.DATA_CHANGED, handleDataChanged)');
    const connect = src.indexOf('connectEvents(() => {})');
    expect(on).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(-1);
    expect(on).toBeLessThan(connect);
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
    const { invalidateLibraryImages } = await import('../public-src/bean-image.js');
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
      library: { run: async () => { invalidateLibraryImages(); await library.loadLibrary(); } },
    });
    live.handleDataChanged({ kind: 'library', rev: 1, epoch: 'e1' });
    await vi.advanceTimersByTimeAsync(400);

    expect(mocks.getLibrary).toHaveBeenCalled();
    expect(made.elements.newBagForm1.style.display).toBe('');
    expect(made.elements.newBagStock1.value).toBe('250');
  });
});
