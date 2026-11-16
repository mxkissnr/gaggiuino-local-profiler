// #1958 slice 3: the empty-bean offer decides, from state alone, whether a
// stock-tracked bean that has run out should be offered once, and pushes that
// offer through the real popup queue (#1956) so it never collides with a
// What's New or achievement popup. Every path that can change stock feeds the
// same check, so nothing here listens for events.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// shelf.ts's import chain reads localStorage/navigator at module load — stub
// the browser globals the shelf-classification test already stubs.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

interface FakePortion {
  id: number;
  portionCount?: number | undefined;
  remainingCount?: number | undefined;
  thawedAt?: number | null | undefined;
}

interface FakeBag {
  id: number;
  remainingG?: number | undefined;
  consumedG?: number | undefined;
  frozenPortions?: FakePortion[] | undefined;
}

interface FakeBean {
  id: number;
  name: string;
  enabled?: boolean | undefined;
  remainingG?: number | null | undefined;
  consumedG?: number | undefined;
  emptyOfferBagId?: number | undefined;
  bags?: FakeBag[] | undefined;
}

interface ToastOpts {
  duration?: number | undefined;
  action?: { label: string; onClick: () => void } | undefined;
  onHide?: ((how: string) => void) | undefined;
}

interface RecordedToast {
  msg: string;
  opts: ToastOpts;
}

interface SaveCall {
  id: number | null;
  payload: unknown;
}

const mocks = vi.hoisted(() => ({
  prefs: new Map<string, unknown>(),
  inSync: true,
  setCalls: [] as { key: string; value: unknown }[],
  saveCalls: [] as SaveCall[],
  toggles: [] as number[],
  toasts: [] as RecordedToast[],
  renderCalls: 0,
  saveImpl: null as ((id: number | null, payload: Record<string, unknown>) => unknown) | null,
}));

vi.mock('../public-src/ui-prefs.js', () => ({
  getUiPref: <T>(key: string): T | undefined => mocks.prefs.get(key) as T | undefined,
  setUiPref: (key: string, value: unknown): void => {
    mocks.setCalls.push({ key, value });
    mocks.prefs.set(key, value);
  },
  uiPrefsInSync: (): boolean => mocks.inSync,
}));

vi.mock('../public-src/components/toast.js', () => ({
  showToast: (msg: string, opts?: ToastOpts): void => {
    mocks.toasts.push({ msg, opts: opts ?? {} });
  },
}));

// Spreading the real module keeps every other API binding intact: bags.ts
// imports the whole namespace and reads the functions it needs at call time.
vi.mock('../public-src/api/library.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/library.js')>()),
  saveBean: (id: number | null, payload: unknown): Promise<unknown> => {
    mocks.saveCalls.push({ id, payload });
    const impl = mocks.saveImpl;
    if (!impl) return Promise.reject(new Error('saveBean was not configured'));
    return Promise.resolve(impl(id, payload as Record<string, unknown>));
  },
  toggleBeanActive: (id: number): Promise<null> => {
    mocks.toggles.push(id);
    return Promise.resolve(null);
  },
}));

// Only the repaint is stubbed, so the module keeps its real shape.
vi.mock('../public-src/views/library.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/views/library.js')>()),
  renderBeanList: (): void => { mocks.renderCalls += 1; },
}));

type OfferModule = typeof import('../public-src/views/library/empty-offer.js');
type QueueModule = typeof import('../public-src/components/popup-queue.js');
type ShelfModule = typeof import('../public-src/views/library/shelf.js');
type AppState = typeof import('../public-src/state/index.js').S;

const ARMED = 'bean_empty_offer.armed';

let beans: FakeBean[] = [];

function makeBean(
  id: number,
  remainingG: number | null | undefined,
  extra: Partial<FakeBean> = {},
): FakeBean {
  // A real bag's remainingG is absent, never null, for an unweighed bag.
  const bagRemaining = remainingG ?? undefined;
  return { id, name: `Bean ${id}`, remainingG, bags: [{ id: id * 100, remainingG: bagRemaining }], ...extra };
}

function row(id: number): FakeBean {
  const found = beans.find(b => b.id === id);
  if (!found) throw new Error(`no bean ${id} in the fixture`);
  return found;
}

function newestBag(id: number): FakeBag | undefined {
  return (row(id).bags ?? []).reduce<FakeBag | undefined>(
    (acc, bg) => (acc === undefined || bg.id > acc.id ? bg : acc),
    undefined,
  );
}

/** Moves a bean (and its newest bag) to a new stock level. */
function setStock(id: number, grams: number): void {
  const b = row(id);
  b.remainingG = grams;
  const bag = newestBag(id);
  if (bag) bag.remainingG = grams;
  else b.bags = [{ id: id * 100, remainingG: grams }];
}

function mergeSave(id: number | null, payload: Record<string, unknown>): unknown {
  const b = beans.find(candidate => candidate.id === id);
  if (!b) throw new Error(`saveBean for unknown bean ${String(id)}`);
  Object.assign(b, payload);
  return b;
}

function arm(): void {
  mocks.prefs.set(ARMED, true);
}

function stubNavigator(controllerUrl: string | null): void {
  const nav: Record<string, unknown> = { language: 'en-US', userAgent: 'node' };
  if (controllerUrl !== null) nav.serviceWorker = { controller: { scriptURL: controllerUrl } };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
}

interface Harness {
  offer: OfferModule;
  queue: QueueModule;
  S: AppState;
  canShow: { value: boolean };
}

async function load(canShow = true): Promise<Harness> {
  vi.resetModules();
  const state = await import('../public-src/state/index.js');
  state.S.currentLang = 'en';
  state.S.isDemo = false;
  state.S.coffeeLibrary = { beans } as unknown as AppState['coffeeLibrary'];
  const queue = await import('../public-src/components/popup-queue.js');
  const h: Harness = {
    offer: await import('../public-src/views/library/empty-offer.js'),
    queue,
    S: state.S,
    canShow: { value: canShow },
  };
  queue.initPopupQueue({ canShow: () => h.canShow.value, refresh: () => Promise.resolve(true) });
  return h;
}

/** Lets the module's promise chains settle and the queue's timers fire. */
async function settle(ms = 1): Promise<void> {
  // The baseline writes one bean at a time, so the chain needs a turn per
  // bean plus the save round trip; drain generously rather than guess.
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
}

function toastAt(index: number): RecordedToast {
  const toast = mocks.toasts[index];
  if (!toast) throw new Error(`no toast at ${index}`);
  return toast;
}

function payloads(): Record<string, unknown>[] {
  return mocks.saveCalls.map(call => call.payload as Record<string, unknown>);
}

// _record() logs the failure it is designed to swallow, so the failing-baseline
// cases would otherwise print an expected error.
vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.prefs.clear();
  mocks.setCalls.length = 0;
  mocks.saveCalls.length = 0;
  mocks.toggles.length = 0;
  mocks.toasts.length = 0;
  mocks.renderCalls = 0;
  mocks.inSync = true;
  mocks.saveImpl = mergeSave;
  beans = [];
  stubNavigator(null);
});

describe('empty-bean offer (#1958)', () => {
  it('offers once when a bean reaches 0 g, and does not stack further offers', async () => {
    beans = [makeBean(1, 20)];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle();
    expect(mocks.toasts).toHaveLength(0);

    setStock(1, 0);
    h.offer.checkEmptyBeanOffer();
    await settle();
    expect(mocks.toasts).toHaveLength(1);
    expect(toastAt(0).msg).toBe('Bean 1 is empty');
    expect(toastAt(0).opts.action?.label).toBe('Archive');
    expect(toastAt(0).opts.duration).toBe(10000);

    h.offer.checkEmptyBeanOffer();
    h.offer.checkEmptyBeanOffer();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(1);
  });

  it('writes the marker when the toast runs out and does not offer again', async () => {
    beans = [makeBean(1, 0)];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle();
    expect(mocks.toasts).toHaveLength(1);

    toastAt(0).opts.onHide?.('timeout');
    await settle();

    expect(mocks.saveCalls).toHaveLength(1);
    expect(mocks.saveCalls[0]?.id).toBe(1);
    expect(payloads()[0]).toEqual({ emptyOfferBagId: 100 });

    h.offer.checkEmptyBeanOffer();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(1);
  });

  it('keeps the dismissal across a reload', async () => {
    beans = [makeBean(1, 0)];
    const first = await load();
    arm();
    first.offer.startEmptyBeanOffers();
    await settle();
    toastAt(0).opts.onHide?.('timeout');
    await settle();

    const second = await load();
    second.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(1);
    expect(mocks.saveCalls).toHaveLength(1);
  });

  it('archives on the action and leaves the row empty with its weights untouched', async () => {
    beans = [makeBean(1, 0, { consumedG: 250 })];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle();
    toastAt(0).opts.action?.onClick();
    await settle();

    expect(mocks.toggles).toEqual([]);
    const archiveCalls = mocks.saveCalls.filter(call => 'enabled' in (call.payload as Record<string, unknown>));
    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.payload).toEqual({ enabled: false, emptyOfferBagId: 100 });
    expect(mocks.toasts).toHaveLength(2);
    expect(toastAt(1).msg).toBe('Bag folded and put away.');
    expect(mocks.renderCalls).toBeGreaterThan(0);

    const shelf: ShelfModule = await import('../public-src/views/library/shelf.js');
    const buckets = shelf.classifyBeanShelf(beans as unknown as Parameters<ShelfModule['classifyBeanShelf']>[0]);
    const archived = buckets.emptyArchive[0];
    expect(archived?.id).toBe(1);
    expect(archived?.consumedG).toBe(250);
    expect(archived?.remainingG).toBe(0);
  });

  it('never writes `enabled` unless the action was clicked', async () => {
    beans = [makeBean(1, 0), makeBean(2, 0)];
    const h = await load();

    h.offer.startEmptyBeanOffers();
    await settle(2500);
    h.offer.checkEmptyBeanOffer();
    await settle(2500);

    expect(mocks.saveCalls.length).toBeGreaterThan(0);
    for (const payload of payloads()) expect('enabled' in payload).toBe(false);
    expect(mocks.toggles).toEqual([]);
  });

  it('never offers a bean without stock tracking', async () => {
    beans = [
      makeBean(1, undefined),
      makeBean(2, null),
      makeBean(3, 0, { bags: [{ id: 300, consumedG: 5 }] }),
    ];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);
    expect(mocks.saveCalls).toHaveLength(0);
  });

  it('counts a bean as empty only once its frozen portions are gone', async () => {
    beans = [
      makeBean(1, 0, {
        bags: [{ id: 100, remainingG: 0, frozenPortions: [{ id: 1, remainingCount: 1 }] }],
      }),
    ];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);

    beans = [
      makeBean(2, 0, {
        bags: [{ id: 200, remainingG: 0, frozenPortions: [{ id: 2, remainingCount: 1, thawedAt: 1 }] }],
      }),
      makeBean(3, 0, {
        bags: [{ id: 300, remainingG: 0, frozenPortions: [{ id: 3, remainingCount: 0, portionCount: 0 }] }],
      }),
    ];
    h.S.coffeeLibrary = { beans } as unknown as AppState['coffeeLibrary'];
    h.offer.checkEmptyBeanOffer();
    await settle();
    expect(mocks.toasts).toHaveLength(1);
    expect(toastAt(0).msg).toBe('Bean 2 is empty');

    toastAt(0).opts.onHide?.('timeout');
    await settle();
    h.offer.checkEmptyBeanOffer();
    await settle(500);
    expect(toastAt(1).msg).toBe('Bean 3 is empty');
  });

  it('records the beans that were already empty before offering anything', async () => {
    beans = [];
    for (let id = 1; id <= 11; id += 1) beans.push(makeBean(id, id <= 6 ? 0 : 250));
    const h = await load();

    h.offer.startEmptyBeanOffers();
    await settle(2500);

    expect(mocks.toasts).toHaveLength(0);
    expect(mocks.saveCalls.map(call => call.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(mocks.prefs.get(ARMED)).toBe(true);

    setStock(7, 0);
    h.offer.checkEmptyBeanOffer();
    await settle();
    expect(mocks.toasts).toHaveLength(1);
    expect(toastAt(0).msg).toBe('Bean 7 is empty');
  });

  it('stays unarmed when the baseline fails and retries at the next check', async () => {
    beans = [makeBean(1, 0)];
    const h = await load();
    mocks.saveImpl = () => Promise.reject(new Error('offline'));

    h.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);
    expect(mocks.prefs.get(ARMED)).toBeUndefined();

    mocks.saveImpl = mergeSave;
    h.offer.checkEmptyBeanOffer();
    await settle();
    expect(mocks.prefs.get(ARMED)).toBe(true);
    expect(payloads().at(-1)).toEqual({ emptyOfferBagId: 100 });
  });

  it('does not arm on an empty library', async () => {
    beans = [];
    const h = await load();

    h.offer.startEmptyBeanOffers();
    await settle();

    expect(mocks.saveCalls).toHaveLength(0);
    expect(mocks.setCalls).toHaveLength(0);
    expect(mocks.prefs.get(ARMED)).toBeUndefined();
  });

  it('does nothing when the shared preferences are not trusted', async () => {
    beans = [makeBean(1, 0)];
    const h = await load();
    arm();
    mocks.inSync = false;

    h.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);
    expect(mocks.saveCalls).toHaveLength(0);
    expect(mocks.setCalls).toHaveLength(0);
  });

  it('does nothing in the demo instance', async () => {
    beans = [makeBean(1, 0)];
    const h = await load();
    arm();
    h.S.isDemo = true;

    h.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);
    expect(mocks.saveCalls).toHaveLength(0);
  });

  it('writes nothing on the page the public demo service worker controls', async () => {
    stubNavigator('https://example.test/demo/demo-sw.js');
    beans = [makeBean(1, 0), makeBean(2, 0)];
    const h = await load();

    h.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);
    expect(mocks.saveCalls).toHaveLength(0);
    expect(mocks.setCalls).toHaveLength(0);

    arm();
    h.offer.checkEmptyBeanOffer();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);
    expect(mocks.saveCalls).toHaveLength(0);
    expect(mocks.setCalls).toHaveLength(0);
  });

  it('treats another service worker as normal', async () => {
    stubNavigator('https://example.test/sw.js');
    beans = [makeBean(1, 0)];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle();
    expect(mocks.toasts).toHaveLength(1);
  });

  it('writes nothing when a newer toast replaces the offer, and offers again', async () => {
    beans = [makeBean(1, 0)];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle();
    toastAt(0).opts.onHide?.('replaced');
    await settle();

    expect(mocks.saveCalls).toHaveLength(0);

    h.offer.checkEmptyBeanOffer();
    await settle(500);
    expect(mocks.toasts).toHaveLength(2);
    expect(toastAt(1).msg).toBe('Bean 1 is empty');
  });

  it('re-arms for a new bag but not for a deleted newer bag', async () => {
    beans = [
      makeBean(1, 0, {
        emptyOfferBagId: 100,
        bags: [{ id: 100, remainingG: 0 }, { id: 200, remainingG: 0 }],
      }),
      makeBean(2, 0, { emptyOfferBagId: 200, bags: [{ id: 200, remainingG: 0 }] }),
    ];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle();

    expect(mocks.toasts).toHaveLength(1);
    expect(toastAt(0).msg).toBe('Bean 1 is empty');
    toastAt(0).opts.action?.onClick();
    toastAt(0).opts.onHide?.('action');
    await settle();
    expect(mocks.toasts.map(toast => toast.msg)).toEqual(['Bean 1 is empty', 'Bag folded and put away.']);
    expect(payloads()[0]).toEqual({ enabled: false, emptyOfferBagId: 200 });

    // The newest bag was deleted, so the bean's existing marker still covers it
    // and the deleted bag id never becomes an offer of its own.
    beans = [makeBean(3, 0, { emptyOfferBagId: 200, bags: [{ id: 100, remainingG: 0 }] })];
    h.S.coffeeLibrary = { beans } as unknown as AppState['coffeeLibrary'];
    h.offer.checkEmptyBeanOffer();
    await settle(500);
    expect(mocks.toasts.map(toast => toast.msg)).toEqual(['Bean 1 is empty', 'Bag folded and put away.']);
  });

  it('offers two empty beans one after the other', async () => {
    beans = [makeBean(1, 0), makeBean(2, 0)];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle();
    expect(mocks.toasts).toHaveLength(1);
    expect(toastAt(0).msg).toBe('Bean 1 is empty');

    toastAt(0).opts.onHide?.('timeout');
    await settle();
    h.offer.checkEmptyBeanOffer();
    await settle(500);
    expect(mocks.toasts).toHaveLength(2);
    expect(toastAt(1).msg).toBe('Bean 2 is empty');
  });

  it('waits while the app cannot show a popup, then shows the offer', async () => {
    beans = [makeBean(1, 0)];
    const h = await load(false);
    arm();

    h.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);

    h.canShow.value = true;
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(mocks.toasts).toHaveLength(1);
  });

  it('holds another popup until the offer has been dealt with', async () => {
    beans = [makeBean(1, 0)];
    const h = await load();
    arm();
    const otherShown: string[] = [];

    h.offer.startEmptyBeanOffers();
    h.queue.enqueuePopup({ id: 'other', isDue: () => true, show: (done) => { otherShown.push('other'); done(); } });
    await settle();
    expect(mocks.toasts).toHaveLength(1);
    expect(otherShown).toEqual([]);

    toastAt(0).opts.onHide?.('timeout');
    await settle(400);
    expect(otherShown).toEqual(['other']);
  });

  it('skips an offer whose bean was restocked while it waited', async () => {
    beans = [makeBean(1, 0)];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    setStock(1, 250);
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);
  });

  it('records an archived empty bean without offering it', async () => {
    beans = [makeBean(1, 0, { enabled: false })];
    const first = await load();

    first.offer.startEmptyBeanOffers();
    await settle();
    expect(mocks.toasts).toHaveLength(0);
    expect(payloads()).toEqual([{ emptyOfferBagId: 100 }]);
    expect(mocks.prefs.get(ARMED)).toBe(true);

    beans = [makeBean(2, 0, { enabled: false })];
    const second = await load();
    second.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);
    expect(payloads()[1]).toEqual({ emptyOfferBagId: 200 });

    beans = [makeBean(2, 0, { enabled: true, emptyOfferBagId: 200 })];
    second.S.coffeeLibrary = { beans } as unknown as AppState['coffeeLibrary'];
    second.offer.checkEmptyBeanOffer();
    await settle();
    expect(mocks.toasts).toHaveLength(0);
  });

  it('offers nothing while an archived bean still has stock, then once when it runs out', async () => {
    beans = [makeBean(1, 250, { enabled: false })];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);
    expect(mocks.saveCalls).toHaveLength(0);

    const restored = row(1);
    restored.enabled = true;
    setStock(1, 0);
    h.offer.checkEmptyBeanOffer();
    await settle();
    expect(mocks.toasts).toHaveLength(1);
    expect(toastAt(0).msg).toBe('Bean 1 is empty');

    toastAt(0).opts.onHide?.('timeout');
    await settle();
    h.offer.checkEmptyBeanOffer();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(1);
  });

  it('offers again for a new bag at 0 g after the bean was reactivated', async () => {
    beans = [
      makeBean(1, 250, {
        emptyOfferBagId: 100,
        bags: [{ id: 100, remainingG: 0 }, { id: 200, remainingG: 250 }],
      }),
    ];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);

    setStock(1, 0);
    h.offer.checkEmptyBeanOffer();
    await settle();
    expect(mocks.toasts).toHaveLength(1);

    toastAt(0).opts.onHide?.('timeout');
    await settle();
    expect(payloads()[0]).toEqual({ emptyOfferBagId: 200 });

    h.offer.checkEmptyBeanOffer();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(1);
  });

  it('shortens a long bean name and leaves a short one alone', async () => {
    beans = [makeBean(1, 0, { name: 'A'.repeat(30) })];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle();
    expect(toastAt(0).msg).toBe(`${'A'.repeat(24)}… is empty`);

    toastAt(0).opts.onHide?.('timeout');
    await settle();
    beans = [makeBean(2, 0, { name: 'Geisha' })];
    h.S.coffeeLibrary = { beans } as unknown as AppState['coffeeLibrary'];
    h.offer.checkEmptyBeanOffer();
    await settle(500);
    expect(toastAt(1).msg).toBe('Geisha is empty');
  });

  it('never offers an archived bean, and offers again when dismissal fails', async () => {
    beans = [makeBean(1, 0, { enabled: false })];
    const h = await load();
    arm();

    h.offer.startEmptyBeanOffers();
    await settle(2500);
    expect(mocks.toasts).toHaveLength(0);
    expect(payloads()).toEqual([{ emptyOfferBagId: 100 }]);

    beans = [makeBean(2, 0)];
    h.S.coffeeLibrary = { beans } as unknown as AppState['coffeeLibrary'];
    h.offer.checkEmptyBeanOffer();
    await settle();
    expect(mocks.toasts).toHaveLength(1);

    mocks.saveImpl = () => Promise.reject(new Error('offline'));
    toastAt(0).opts.onHide?.('timeout');
    await settle();
    expect(mocks.saveCalls).toHaveLength(2);
    expect(mocks.saveCalls[1]?.payload).toEqual({ emptyOfferBagId: 200 });

    mocks.saveImpl = mergeSave;
    h.offer.checkEmptyBeanOffer();
    await settle(500);
    expect(mocks.toasts).toHaveLength(2);
    expect(toastAt(1).msg).toBe('Bean 2 is empty');
  });
});
