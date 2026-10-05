import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ui-prefs.ts seeds itself from localStorage at *module load time*, so the
// store has to be in place before the module is imported in each test. Each
// test gets a fresh module instance through vi.resetModules() so the queue and
// timer state never leak between tests. The window/document fakes let the
// module's pagehide/visibilitychange listeners register in the node test env.
type Listener = (...args: unknown[]) => unknown;
const g = globalThis as unknown as Record<string, unknown>;
const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => (_store.has(k) ? _store.get(k) ?? null : null),
  setItem: (k: string, v: string) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };
const winListeners = new Map<string, Listener>();
const docListeners = new Map<string, Listener>();
g.window = {
  addEventListener: (type: string, cb: Listener) => { winListeners.set(type, cb); },
};
g.document = {
  visibilityState: 'visible',
  addEventListener: (type: string, cb: Listener) => { docListeners.set(type, cb); },
};

function pendingKeys(): string[] {
  return JSON.parse(_store.get('glp_ui_prefs_pending') ?? '[]') as string[];
}

type FetchFn = (url: string, opts?: RequestInit) => Promise<Response>;

function okJson(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

function cachedPrefs(): Record<string, unknown> {
  return JSON.parse(_store.get('glp_ui_prefs') ?? '{}') as Record<string, unknown>;
}

function sentBody(call: readonly unknown[] | undefined): Record<string, unknown> {
  const opts = call?.[1] as RequestInit | undefined;
  const body = opts?.body;
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>;
}

async function loadModule() {
  vi.resetModules();
  return await import('../public-src/ui-prefs.js');
}

beforeEach(() => {
  _store.clear();
  winListeners.clear();
  docListeners.clear();
  (g.document as { visibilityState: string }).visibilityState = 'visible';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mergeUiPrefs (#1375, #1403)', () => {
  it('the server wins and local-only keys are dropped once it has preferences', async () => {
    const { mergeUiPrefs } = await loadModule();
    expect(mergeUiPrefs({ a: 1, b: 2 }, { a: 9, c: 3 })).toEqual({
      merged: { a: 9, c: 3 },
      pushUp: [],
    });
  });

  it('an empty server keeps everything local and pushes it all up (migration)', async () => {
    const { mergeUiPrefs } = await loadModule();
    expect(mergeUiPrefs({ a: 1, b: 2 }, {})).toEqual({
      merged: { a: 1, b: 2 },
      pushUp: ['a', 'b'],
    });
  });

  it('keys only present locally are pushed up only when the server is empty', async () => {
    const { mergeUiPrefs } = await loadModule();
    expect(mergeUiPrefs({ 'lib.shelf': { filter: 'all' } }, {})).toEqual({
      merged: { 'lib.shelf': { filter: 'all' } },
      pushUp: ['lib.shelf'],
    });
  });

  it('a local write still queued beats the server value (finding 3)', async () => {
    const { mergeUiPrefs } = await loadModule();
    expect(mergeUiPrefs({ a: 1, b: 2 }, { a: 9, c: 3 }, new Set(['a']))).toEqual({
      merged: { a: 1, c: 3 },
      pushUp: [],
    });
  });

  it('a pending local-only key survives a non-empty server', async () => {
    const { mergeUiPrefs } = await loadModule();
    expect(mergeUiPrefs({ a: 1 }, { c: 3 }, new Set(['a']))).toEqual({
      merged: { a: 1, c: 3 },
      pushUp: [],
    });
  });

  it('a queued local-only key is not pushed up twice', async () => {
    const { mergeUiPrefs } = await loadModule();
    expect(mergeUiPrefs({ a: 1 }, {}, new Set(['a']))).toEqual({
      merged: { a: 1 },
      pushUp: [],
    });
  });
});

describe('setUiPref (#1375)', () => {
  it('writes localStorage immediately and debounces several calls into one PUT', async () => {
    const mod = await loadModule();
    const fetchMock = vi.fn<FetchFn>(() => Promise.resolve(okJson({})));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    mod.setUiPref('lib.shelf', { filter: 'all' });
    mod.setUiPref('machine.active', 2);

    expect(cachedPrefs()).toEqual({ 'lib.shelf': { filter: 'all' }, 'machine.active': 2 });
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('api/ui-prefs');
    expect(call?.[1]?.method).toBe('PUT');
    expect(sentBody(call)).toEqual({ 'lib.shelf': { filter: 'all' }, 'machine.active': 2 });
  });

  it('keeps a key queued after a failed PUT and re-sends it with the next change', async () => {
    const mod = await loadModule();
    const fetchMock = vi.fn<FetchFn>(() => Promise.resolve({ ok: false } as Response));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    mod.setUiPref('lib.shelf', { filter: 'espresso' });
    await vi.advanceTimersByTimeAsync(600);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mod.setUiPref('machine.active', 7);
    await vi.advanceTimersByTimeAsync(600);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock.mock.calls[1])).toEqual({
      'lib.shelf': { filter: 'espresso' },
      'machine.active': 7,
    });
  });

  it('does not drop a change made while a PUT is in flight (finding 2)', async () => {
    const mod = await loadModule();
    const resolvers: Array<(r: Response) => void> = [];
    const fetchMock = vi.fn<FetchFn>(() => new Promise<Response>(res => { resolvers.push(res); }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    mod.setUiPref('lib.shelf', { filter: 'v1' });
    await vi.advanceTimersByTimeAsync(600);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchMock.mock.calls[0])).toEqual({ 'lib.shelf': { filter: 'v1' } });

    // The user changes the same key before the first PUT has settled.
    mod.setUiPref('lib.shelf', { filter: 'v2' });

    const resolveFirst = resolvers[0];
    resolveFirst?.(okJson({}));
    // Run the follow-up flush whichever microtask ordering settles the in-flight
    // PUT first (the version check must keep the key queued either way).
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock.mock.calls[1])).toEqual({ 'lib.shelf': { filter: 'v2' } });
  });

  it('persists the pending set and retries it after a reload (#1403)', async () => {
    const mod = await loadModule();
    vi.stubGlobal('fetch', vi.fn<FetchFn>(() => Promise.resolve({ ok: false } as Response)));
    vi.useFakeTimers();

    mod.setUiPref('lib.shelf', { filter: 'all' });
    expect(pendingKeys()).toEqual(['lib.shelf']);
    await vi.advanceTimersByTimeAsync(600); // the PUT fails, the key stays pending
    expect(pendingKeys()).toEqual(['lib.shelf']);

    // Simulated reload: a fresh module instance reads the pending set back and
    // re-sends it together with the next change.
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const mod2 = await loadModule();
    const okFetch = vi.fn<FetchFn>(() => Promise.resolve(okJson({})));
    vi.stubGlobal('fetch', okFetch);
    vi.useFakeTimers();

    mod2.setUiPref('machine.active', 2);
    await vi.advanceTimersByTimeAsync(600);

    expect(okFetch).toHaveBeenCalledTimes(1);
    expect(sentBody(okFetch.mock.calls[0])).toEqual({
      'lib.shelf': { filter: 'all' },
      'machine.active': 2,
    });
  });

  it('drops the keys a 400 names but keeps the rest queued (#1403)', async () => {
    const mod = await loadModule();
    const bad = {
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Validation failed', issues: ['invalid value for key "a"'] }),
    } as unknown as Response;
    const fetchMock = vi.fn<FetchFn>(() => Promise.resolve(bad));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    mod.setUiPref('a', { nested: { deep: 1 } });
    mod.setUiPref('b', 'ok');
    await vi.advanceTimersByTimeAsync(600);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(fetchMock.mock.calls[0])).toEqual({ a: { nested: { deep: 1 } }, b: 'ok' });
    expect(pendingKeys()).toEqual(['b']);

    // A later change flushes the remaining key without the rejected one.
    mod.setUiPref('c', 3);
    await vi.advanceTimersByTimeAsync(600);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock.mock.calls[1])).toEqual({ b: 'ok', c: 3 });
    // The rejected key's local value is deliberately kept.
    expect(mod.getUiPref('a')).toEqual({ nested: { deep: 1 } });
  });

  it('flushes the pending set with keepalive on pagehide (#1403)', async () => {
    _store.set('glp_ui_prefs', JSON.stringify({ 'lib.shelf': { filter: 'all' } }));
    _store.set('glp_ui_prefs_pending', JSON.stringify(['lib.shelf']));
    await loadModule();
    const fetchMock = vi.fn<FetchFn>(() => Promise.resolve(okJson({})));
    vi.stubGlobal('fetch', fetchMock);

    winListeners.get('pagehide')?.();

    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('api/ui-prefs');
    expect(call?.[1]?.method).toBe('PUT');
    expect(call?.[1]?.keepalive).toBe(true);
    expect(sentBody(call)).toEqual({ 'lib.shelf': { filter: 'all' } });
    await vi.waitFor(() => { expect(pendingKeys()).toEqual([]); });
  });

  it('flushes with keepalive when the tab becomes hidden (#1403)', async () => {
    _store.set('glp_ui_prefs', JSON.stringify({ 'lib.shelf': { filter: 'all' } }));
    _store.set('glp_ui_prefs_pending', JSON.stringify(['lib.shelf']));
    await loadModule();
    const fetchMock = vi.fn<FetchFn>(() => Promise.resolve(okJson({})));
    vi.stubGlobal('fetch', fetchMock);
    (g.document as { visibilityState: string }).visibilityState = 'hidden';

    docListeners.get('visibilitychange')?.();

    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1); });
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
  });
});

describe('loadUiPrefsFromServer (#1375, #1403)', () => {
  it('lets the server win and drops local-only keys once it has preferences', async () => {
    _store.set('glp_ui_prefs', JSON.stringify({ 'lib.shelf': { filter: 'espresso' }, localOnly: 1 }));
    const mod = await loadModule();

    const calls: [string, RequestInit | undefined][] = [];
    const fetchMock = vi.fn<FetchFn>((url, opts) => {
      calls.push([url, opts]);
      return Promise.resolve(okJson({ 'lib.shelf': { filter: 'decaf' }, fromServer: 2 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const changed = await mod.loadUiPrefsFromServer();

    expect(changed).toBe(true);
    expect(mod.getUiPref('lib.shelf')).toEqual({ filter: 'decaf' });
    expect(mod.getUiPref('fromServer')).toBe(2);
    expect(mod.getUiPref('localOnly')).toBeUndefined();
    expect(cachedPrefs()).toEqual({ 'lib.shelf': { filter: 'decaf' }, fromServer: 2 });

    expect(calls.some(([, o]) => o?.method === 'PUT')).toBe(false);
  });

  it('migrates every local key up when the server is empty (first sync)', async () => {
    _store.set('glp_ui_prefs', JSON.stringify({ 'lib.shelf': { filter: 'espresso' }, localOnly: 1 }));
    const mod = await loadModule();

    const calls: [string, RequestInit | undefined][] = [];
    const fetchMock = vi.fn<FetchFn>((url, opts) => {
      calls.push([url, opts]);
      return Promise.resolve(okJson({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    await mod.loadUiPrefsFromServer();

    expect(mod.getUiPref('lib.shelf')).toEqual({ filter: 'espresso' });
    expect(mod.getUiPref('localOnly')).toBe(1);

    const put = calls.find(([, o]) => o?.method === 'PUT');
    expect(put).toBeTruthy();
    expect(sentBody(put)).toEqual({ 'lib.shelf': { filter: 'espresso' }, localOnly: 1 });
  });

  it('leaves the local cache untouched when the request fails', async () => {
    _store.set('glp_ui_prefs', JSON.stringify({ 'lib.shelf': { filter: 'espresso' } }));
    const mod = await loadModule();
    vi.stubGlobal('fetch', vi.fn<FetchFn>(() => Promise.resolve({ ok: false } as Response)));

    expect(await mod.loadUiPrefsFromServer()).toBe(false);
    expect(mod.getUiPref('lib.shelf')).toEqual({ filter: 'espresso' });
  });

  it('a local write still queued is not overwritten by the server (finding 3)', async () => {
    const mod = await loadModule();
    const calls: [string, RequestInit | undefined][] = [];
    const fetchMock = vi.fn<FetchFn>((url, opts) => {
      calls.push([url, opts]);
      if (opts?.method === 'PUT') return Promise.resolve(okJson({}));
      return Promise.resolve(okJson({ 'machine.active': 99 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    // A local choice (e.g. the #1323 fallback to 'all') is queued but not sent.
    mod.setUiPref('machine.active', 'all');

    const changed = await mod.loadUiPrefsFromServer();

    expect(mod.getUiPref('machine.active')).toBe('all'); // server's 99 is skipped
    expect(changed).toBe(false);
    await vi.runAllTimersAsync(); // the queued local write still reaches the server
    const put = calls.find(([, o]) => o?.method === 'PUT');
    expect(put).toBeTruthy();
    expect(sentBody(put)).toEqual({ 'machine.active': 'all' });
  });
});
