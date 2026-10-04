import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ui-prefs.ts seeds itself from localStorage at *module load time*, so the
// store has to be in place before the module is imported in each test. Each
// test gets a fresh module instance through vi.resetModules() so the queue and
// timer state never leak between tests.
const g = globalThis as unknown as Record<string, unknown>;
const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => (_store.has(k) ? _store.get(k) ?? null : null),
  setItem: (k: string, v: string) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };

type FetchFn = (url: string, opts?: RequestInit) => Promise<Response>;

function okJson(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

function cachedPrefs(): Record<string, unknown> {
  return JSON.parse(_store.get('glp_ui_prefs') ?? '{}') as Record<string, unknown>;
}

function sentBody(call: [string, RequestInit | undefined] | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

async function loadModule() {
  vi.resetModules();
  return await import('../public-src/ui-prefs.js');
}

beforeEach(() => {
  _store.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('mergeUiPrefs (#1375)', () => {
  it('the server wins for every key it has', async () => {
    const { mergeUiPrefs } = await loadModule();
    expect(mergeUiPrefs({ a: 1, b: 2 }, { a: 9, c: 3 })).toEqual({
      merged: { a: 9, b: 2, c: 3 },
      pushUp: ['b'],
    });
  });

  it('keys only present locally are pushed up', async () => {
    const { mergeUiPrefs } = await loadModule();
    expect(mergeUiPrefs({ 'lib.shelf': { filter: 'all' } }, {})).toEqual({
      merged: { 'lib.shelf': { filter: 'all' } },
      pushUp: ['lib.shelf'],
    });
  });

  it('an empty server keeps everything local and pushes it all up', async () => {
    const { mergeUiPrefs } = await loadModule();
    expect(mergeUiPrefs({ a: 1, b: 2 }, {})).toEqual({
      merged: { a: 1, b: 2 },
      pushUp: ['a', 'b'],
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
});

describe('loadUiPrefsFromServer (#1375)', () => {
  it('lets the server win, pushes local-only keys up once, and caches the merge', async () => {
    _store.set('glp_ui_prefs', JSON.stringify({ 'lib.shelf': { filter: 'espresso' }, localOnly: 1 }));
    const mod = await loadModule();

    const calls: [string, RequestInit | undefined][] = [];
    const fetchMock = vi.fn<FetchFn>((url, opts) => {
      calls.push([url, opts]);
      if (opts?.method === 'PUT') return Promise.resolve(okJson({}));
      return Promise.resolve(okJson({ 'lib.shelf': { filter: 'decaf' }, fromServer: 2 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const changed = await mod.loadUiPrefsFromServer();

    expect(changed).toBe(true);
    expect(mod.getUiPref('lib.shelf')).toEqual({ filter: 'decaf' });
    expect(mod.getUiPref('fromServer')).toBe(2);
    expect(mod.getUiPref('localOnly')).toBe(1);
    expect(cachedPrefs()).toEqual({
      'lib.shelf': { filter: 'decaf' },
      localOnly: 1,
      fromServer: 2,
    });

    const put = calls.find(([, o]) => o?.method === 'PUT');
    expect(put).toBeTruthy();
    expect(sentBody(put)).toEqual({ localOnly: 1 });
  });

  it('leaves the local cache untouched when the request fails', async () => {
    _store.set('glp_ui_prefs', JSON.stringify({ 'lib.shelf': { filter: 'espresso' } }));
    const mod = await loadModule();
    vi.stubGlobal('fetch', vi.fn<FetchFn>(() => Promise.resolve({ ok: false } as Response)));

    expect(await mod.loadUiPrefsFromServer()).toBe(false);
    expect(mod.getUiPref('lib.shelf')).toEqual({ filter: 'espresso' });
  });
});
