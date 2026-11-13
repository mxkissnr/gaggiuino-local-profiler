// #1956 slice 2: the What's New popup. The ui-prefs store is mocked with a
// controllable map so the seen marker, the switches and a "another device
// wrote it meanwhile" refresh can be driven directly; the popup queue itself
// is the real one, so the waiting/refresh/defer behaviour is the shipped code.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getWhatsNewEntries } from '../public-src/shared/whats-new.js';
import type { WhatsNewEntry } from '../public-src/shared/whats-new.js';

// A few modules on the import graph read localStorage/navigator at load time
// (ui-prefs' cache, state's saved language); node has neither.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.window ??= globalThis;

const store = vi.hoisted(() => ({
  prefs: new Map<string, unknown>(),
  writes: [] as Array<{ key: string; value: number }>,
  inSync: true,
  loadChanged: false,
  loadCalls: 0,
  onLoad: null as (() => void) | null,
}));

interface SheetOpts {
  body: string;
  onClose?: () => void;
}

const openDetailSheet = vi.hoisted(() => vi.fn<(opts: SheetOpts) => void>());

vi.mock('../public-src/ui-prefs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/ui-prefs.js')>();
  return {
    ...actual,
    getUiPref: (key: string) => store.prefs.get(key),
    advanceSeenMarker: (key: string, value: number) => {
      store.writes.push({ key, value });
      store.prefs.set(key, value);
    },
    loadUiPrefsFromServer: () => {
      store.loadCalls += 1;
      store.onLoad?.();
      return Promise.resolve(store.loadChanged);
    },
    uiPrefsInSync: () => store.inSync,
  };
});

vi.mock('../public-src/components/detail-sheet.js', () => ({
  openDetailSheet: (opts: SheetOpts) => { openDetailSheet(opts); },
}));

type PopupsModule = typeof import('../public-src/boot/popups.js');
type StateModule = typeof import('../public-src/state/index.js');

interface FakeDoc {
  visibilityState: string;
  activeElement: null;
  body: { classList: { contains: () => boolean } };
  querySelector: () => null;
  querySelectorAll: () => unknown[];
}

interface Ctx {
  popups: PopupsModule;
  S: StateModule['S'];
  doc: FakeDoc;
}

// The queue is module state, so every test loads a fresh copy of the whole
// import graph; S therefore comes from the same fresh graph the popup sees.
async function load(): Promise<Ctx> {
  vi.resetModules();
  const doc: FakeDoc = {
    visibilityState: 'visible',
    activeElement: null,
    body: { classList: { contains: () => false } },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  vi.stubGlobal('document', doc);
  const popups = await import('../public-src/boot/popups.js');
  const { S } = await import('../public-src/state/index.js');
  return { popups, S, doc };
}

const entry = (version: string): WhatsNewEntry => ({ version, date: '2026-01-01', highlights: ['x'] });
const newestVersion = (): string => getWhatsNewEntries()[0]!.version;

function withShots(S: StateModule['S'], count = 1): void {
  S.allShots = Array.from({ length: count }, (_, i) => ({ id: i + 1, timestamp: 0 }));
}

// Lets the queue's zero-delay first tick and the nested refresh promise settle.
async function tick(): Promise<void> {
  for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  store.prefs.clear();
  store.writes.length = 0;
  store.inSync = true;
  store.loadChanged = false;
  store.loadCalls = 0;
  store.onLoad = null;
  openDetailSheet.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('versionCode', () => {
  it('compares releases numerically, not as strings', async () => {
    const { popups } = await load();
    expect(popups.versionCode('3.10.2')).toBeGreaterThan(popups.versionCode('3.9.9'));
  });

  it('encodes x.y.z as one number', async () => {
    const { popups } = await load();
    expect(popups.versionCode('3.7.0')).toBe(3007000);
  });

  it('returns 0 for anything that is not x.y.z', async () => {
    const { popups } = await load();
    expect(popups.versionCode('3.7')).toBe(0);
    expect(popups.versionCode('garbage')).toBe(0);
  });
});

describe('planWhatsNew', () => {
  const entries = [entry('3.10.2'), entry('3.9.9'), entry('3.7.0')];

  it('records the marker and shows nothing on a fresh install', async () => {
    const { popups } = await load();
    expect(popups.planWhatsNew(entries, undefined, false)).toEqual({
      marker: popups.versionCode('3.10.2'),
      entries: [],
    });
  });

  it('shows only the newest entry for an existing install without a marker', async () => {
    const { popups } = await load();
    expect(popups.planWhatsNew(entries, undefined, true)).toEqual({
      marker: popups.versionCode('3.10.2'),
      entries: [entries[0]],
    });
  });

  it('returns null when the marker is at the newest entry', async () => {
    const { popups } = await load();
    expect(popups.planWhatsNew(entries, popups.versionCode('3.10.2'), true)).toBeNull();
  });

  it('returns null when the marker is ahead of the newest entry', async () => {
    const { popups } = await load();
    expect(popups.planWhatsNew(entries, popups.versionCode('3.10.2') + 1, true)).toBeNull();
  });

  it('lists every entry newer than the marker after an update across two versions', async () => {
    const { popups } = await load();
    expect(popups.planWhatsNew(entries, popups.versionCode('3.7.0'), true)).toEqual({
      marker: popups.versionCode('3.10.2'),
      entries: [entries[0], entries[1]],
    });
  });

  it('returns null when there are no entries at all', async () => {
    const { popups } = await load();
    expect(popups.planWhatsNew([], undefined, true)).toBeNull();
  });
});

describe('popupSwitches', () => {
  it('is all on when nothing is stored', async () => {
    const { popups } = await load();
    expect(popups.popupSwitches()).toEqual({ enabled: true, whats_new: true, achievements: true });
  });

  it('is all on when the stored value is garbage', async () => {
    const { popups } = await load();
    store.prefs.set('popups', 'nope');
    expect(popups.popupSwitches()).toEqual({ enabled: true, whats_new: true, achievements: true });
  });

  it('only reads an explicit false as off', async () => {
    const { popups } = await load();
    store.prefs.set('popups', { whats_new: false });
    expect(popups.popupSwitches()).toEqual({ enabled: true, whats_new: false, achievements: true });
  });
});

describe('the What\'s New popup', () => {
  it('opens once after an update and advances the seen and read markers', async () => {
    const { popups, S } = await load();
    withShots(S);

    popups.startPopups(() => {});
    await tick();

    const code = popups.versionCode(newestVersion());
    expect(openDetailSheet).toHaveBeenCalledTimes(1);
    // #2038: opening the popup also marks What's New read.
    expect(store.writes).toEqual([
      { key: 'popups.whats_new_seen', value: code },
      { key: 'popups.whats_new_read', value: code },
    ]);
  });

  it('does not open again on the next start once the marker is written', async () => {
    const { popups, S } = await load();
    withShots(S);

    popups.startPopups(() => {});
    await tick();
    openDetailSheet.mock.calls[0]?.[0]?.onClose?.();
    await vi.advanceTimersByTimeAsync(400);

    popups.startPopups(() => {});
    await vi.advanceTimersByTimeAsync(4000);

    expect(openDetailSheet).toHaveBeenCalledTimes(1);
    // Both markers are written by that single open; the second start adds none.
    expect(store.writes.map(w => w.key)).toEqual(['popups.whats_new_seen', 'popups.whats_new_read']);
  });

  it('shows every newer entry in one popup', async () => {
    const { popups, S } = await load();
    withShots(S);
    const newest = getWhatsNewEntries();
    store.prefs.set('popups.whats_new_seen', popups.versionCode(newest[2]!.version));

    popups.startPopups(() => {});
    await tick();

    const body = openDetailSheet.mock.calls[0]?.[0]?.body ?? '';
    expect(body).toContain(`v${newest[0]!.version}`);
    expect(body).toContain(`v${newest[1]!.version}`);
    expect(body).not.toContain(`v${newest[2]!.version}`);
  });

  it('does not open on a suppressed switch but still advances the marker', async () => {
    const { popups, S } = await load();
    withShots(S);
    store.prefs.set('popups', { whats_new: false });

    popups.startPopups(() => {});
    await vi.advanceTimersByTimeAsync(4000);

    expect(openDetailSheet).not.toHaveBeenCalled();
    expect(store.writes).toEqual([{ key: 'popups.whats_new_seen', value: popups.versionCode(newestVersion()) }]);
  });

  it('does not open when popups are turned off entirely, and still advances the marker', async () => {
    const { popups, S } = await load();
    withShots(S);
    store.prefs.set('popups', { enabled: false });

    popups.startPopups(() => {});
    await vi.advanceTimersByTimeAsync(4000);

    expect(openDetailSheet).not.toHaveBeenCalled();
    expect(store.writes).toEqual([{ key: 'popups.whats_new_seen', value: popups.versionCode(newestVersion()) }]);
  });

  it('opens with both switches on', async () => {
    const { popups, S } = await load();
    withShots(S);
    store.prefs.set('popups', { enabled: true, whats_new: true });

    popups.startPopups(() => {});
    await tick();

    expect(openDetailSheet).toHaveBeenCalledTimes(1);
  });

  it('shows nothing and records the marker on a fresh install', async () => {
    const { popups, S } = await load();
    withShots(S, 0);

    popups.startPopups(() => {});
    await vi.advanceTimersByTimeAsync(4000);

    expect(openDetailSheet).not.toHaveBeenCalled();
    expect(store.writes).toEqual([{ key: 'popups.whats_new_seen', value: popups.versionCode(newestVersion()) }]);
  });

  it('does nothing in demo mode', async () => {
    const { popups, S } = await load();
    withShots(S);
    S.isDemo = true;

    popups.startPopups(() => {});
    await vi.advanceTimersByTimeAsync(4000);

    expect(openDetailSheet).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });

  it('does nothing before the shared preferences were read', async () => {
    const { popups, S } = await load();
    withShots(S);
    store.inSync = false;

    popups.startPopups(() => {});
    await vi.advanceTimersByTimeAsync(4000);

    expect(openDetailSheet).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });

  it('waits while a brew is running and opens once it ends', async () => {
    const { popups, S } = await load();
    withShots(S);
    S.liveWasLive = true;

    popups.startPopups(() => {});
    await vi.advanceTimersByTimeAsync(4000);

    expect(openDetailSheet).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);

    S.liveWasLive = false;
    await vi.advanceTimersByTimeAsync(2000);

    expect(openDetailSheet).toHaveBeenCalledTimes(1);
  });

  it('waits while a bottom sheet is open and opens once it closes', async () => {
    const { popups, S, doc } = await load();
    withShots(S);
    doc.body.classList.contains = () => true;

    popups.startPopups(() => {});
    await vi.advanceTimersByTimeAsync(4000);

    expect(openDetailSheet).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);

    doc.body.classList.contains = () => false;
    await vi.advanceTimersByTimeAsync(2000);

    expect(openDetailSheet).toHaveBeenCalledTimes(1);
  });

  it('waits while the tab is hidden and opens once it is visible', async () => {
    const { popups, S, doc } = await load();
    withShots(S);
    doc.visibilityState = 'hidden';

    popups.startPopups(() => {});
    await vi.advanceTimersByTimeAsync(4000);

    expect(openDetailSheet).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);

    doc.visibilityState = 'visible';
    await vi.advanceTimersByTimeAsync(2000);

    expect(openDetailSheet).toHaveBeenCalledTimes(1);
  });

  it('does not open when another device advanced the marker before its turn', async () => {
    const { popups, S } = await load();
    withShots(S);
    store.loadChanged = true;
    store.onLoad = () => {
      store.prefs.set('popups.whats_new_seen', popups.versionCode(newestVersion()));
    };

    popups.startPopups(() => {});
    await tick();

    expect(store.loadCalls).toBe(1);
    expect(openDetailSheet).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });
});
