import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// popup-queue.ts keeps its queue, busy flag and timer in module state, so every
// test loads a fresh instance through vi.resetModules(). Fake timers drive the
// retry and gap delays deterministically.
type PopupQueueModule = typeof import('../public-src/components/popup-queue.js');

async function loadQueue(): Promise<PopupQueueModule> {
  vi.resetModules();
  return await import('../public-src/components/popup-queue.js');
}

interface Harness {
  shown: string[];
  dones: Map<string, () => void>;
  can: boolean;
  refreshCalls: number;
  refreshImpl: () => Promise<boolean>;
}

function makeHarness(mod: PopupQueueModule, refresh: () => Promise<boolean> = () => Promise.resolve(true)): Harness {
  const h: Harness = { shown: [], dones: new Map(), can: true, refreshCalls: 0, refreshImpl: refresh };
  mod.initPopupQueue({
    canShow: () => h.can,
    refresh: () => {
      h.refreshCalls += 1;
      return h.refreshImpl();
    },
  });
  return h;
}

function request(h: Harness, id: string, isDue: () => boolean = () => true, throwing = false) {
  return {
    id,
    isDue,
    show: (done: () => void) => {
      h.shown.push(id);
      h.dones.set(id, done);
      if (throwing) throw new Error('boom');
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('popup queue (#1956)', () => {

  it('shows two queued popups one after the other', async () => {
    const mod = await loadQueue();
    const h = makeHarness(mod);

    mod.enqueuePopup(request(h, 'a'));
    mod.enqueuePopup(request(h, 'b'));

    await vi.advanceTimersByTimeAsync(1);
    expect(h.shown).toEqual(['a']);

    // The second one must not open while the first is still up.
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.shown).toEqual(['a']);

    h.dones.get('a')?.();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.shown).toEqual(['a', 'b']);
  });

  it('waits while canShow is false and does not refresh meanwhile', async () => {
    const mod = await loadQueue();
    const h = makeHarness(mod);
    h.can = false;

    mod.enqueuePopup(request(h, 'a'));

    await vi.advanceTimersByTimeAsync(1);
    expect(h.shown).toEqual([]);
    expect(h.refreshCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(h.shown).toEqual([]);
    expect(h.refreshCalls).toBe(0);

    h.can = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.shown).toEqual(['a']);
    expect(h.refreshCalls).toBe(1);
  });

  it('does not show when canShow turns false during refresh', async () => {
    const mod = await loadQueue();
    let release = (): void => {};
    let calls = 0;
    const h = makeHarness(mod, () => {
      calls += 1;
      if (calls > 1) return Promise.resolve(true);
      return new Promise<boolean>(res => { release = () => { res(true); }; });
    });

    mod.enqueuePopup(request(h, 'a'));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.refreshCalls).toBe(1);

    h.can = false;
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.shown).toEqual([]);

    h.can = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.shown).toEqual(['a']);
  });

  it('empties the queue when refresh resolves false', async () => {
    const mod = await loadQueue();
    const h = makeHarness(mod, () => Promise.resolve(false));

    mod.enqueuePopup(request(h, 'a'));
    mod.enqueuePopup(request(h, 'b'));

    await vi.advanceTimersByTimeAsync(1);
    expect(h.shown).toEqual([]);

    await vi.advanceTimersByTimeAsync(10000);
    expect(h.shown).toEqual([]);
    expect(h.refreshCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('empties the queue when refresh rejects', async () => {
    const mod = await loadQueue();
    const h = makeHarness(mod, () => Promise.reject(new Error('offline')));

    mod.enqueuePopup(request(h, 'a'));

    await vi.advanceTimersByTimeAsync(1);
    expect(h.shown).toEqual([]);

    await vi.advanceTimersByTimeAsync(10000);
    expect(h.shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips a popup that is no longer due and shows the next one', async () => {
    const mod = await loadQueue();
    const h = makeHarness(mod);

    mod.enqueuePopup(request(h, 'a', () => false));
    mod.enqueuePopup(request(h, 'b'));

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.shown).toEqual(['b']);
  });

  it('a second request with the same id replaces the waiting one', async () => {
    const mod = await loadQueue();
    const h = makeHarness(mod);
    h.can = false;

    mod.enqueuePopup({ id: 'a', isDue: () => true, show: () => { h.shown.push('old'); } });
    mod.enqueuePopup({ id: 'a', isDue: () => true, show: () => { h.shown.push('new'); } });

    h.can = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.shown).toEqual(['new']);
  });

  it('a throwing show does not block the next popup', async () => {
    const mod = await loadQueue();
    const h = makeHarness(mod);

    mod.enqueuePopup(request(h, 'a', () => true, true));
    mod.enqueuePopup(request(h, 'b'));

    await vi.advanceTimersByTimeAsync(1);
    expect(h.shown).toEqual(['a']);

    await vi.advanceTimersByTimeAsync(400);
    expect(h.shown).toEqual(['a', 'b']);
  });

  it('schedules only once when done is called twice', async () => {
    const mod = await loadQueue();
    const h = makeHarness(mod);

    mod.enqueuePopup(request(h, 'a'));
    mod.enqueuePopup(request(h, 'b'));

    await vi.advanceTimersByTimeAsync(1);
    const done = h.dones.get('a');
    done?.();
    done?.();

    await vi.advanceTimersByTimeAsync(400);
    expect(h.shown).toEqual(['a', 'b']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
