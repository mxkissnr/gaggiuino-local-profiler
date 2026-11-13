// #1956 slice 4: the popups driven through the real ui-prefs store, popup
// queue and detail sheet at once, with only fetch and the DOM faked. Slice 2
// covers the What's New decision against a mocked store; these tests are about
// the parts working together — the shared seen markers, the saved switches and
// the sheet that actually opens.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getWhatsNewEntries } from '../public-src/shared/whats-new.js';

const g = globalThis as unknown as Record<string, unknown>;

// ui-prefs seeds itself from localStorage when it loads, so the cache has to be
// in place before each test's fresh module graph is imported.
const storage = new Map<string, string>();
g.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
};
g.navigator ??= { language: 'en-US' };

type Badge = {
  id: string;
  card: string;
  stamp: string;
  secret?: boolean;
  unlocked?: boolean;
  unlockedAt?: number | null;
  name?: string | null;
  description?: string | null;
};

// Fixture ids are neutral on purpose. The badges carry their names the way an
// unlocked secret does, so the popup renders the text the API sent instead of a
// translation key derived from a real badge id.
function unlockedBadge(id: string, name: string, unlockedAt: number): Badge {
  return {
    id, card: 'basics', stamp: 'gear',
    secret: true, unlocked: true, unlockedAt,
    name, description: `${name}, earned`,
  };
}

function lockedBadge(id: string): Badge {
  return { id, card: 'basics', stamp: 'gear', unlocked: false, unlockedAt: null, name: null, description: null };
}

function lockedSecret(id: string): Badge {
  return {
    id, card: 'secret', stamp: 'moon',
    secret: true, unlocked: false, unlockedAt: null, name: null, description: null,
  };
}

interface FakeClassList {
  add: (token: string) => void;
  remove: (token: string) => void;
  contains: (token: string) => boolean;
}

function makeClassList(into: Set<string> = new Set<string>()): FakeClassList {
  return {
    add: token => { into.add(token); },
    remove: token => { into.delete(token); },
    contains: token => into.has(token),
  };
}

interface FakeHost {
  innerHTML: string;
  classList: FakeClassList;
  querySelector: (sel?: string) => unknown;
  querySelectorAll: (sel?: string) => unknown[];
  style: Record<string, string>;
}

function makeHost(): FakeHost {
  return { innerHTML: '', classList: makeClassList(), querySelector: () => null, querySelectorAll: () => [], style: {} };
}

interface FakeCard {
  innerHTML: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
}

interface FakeCheckbox {
  id: string;
  checked: boolean;
  disabled: boolean;
  onchange: (() => void) | null;
}

type KeyHandler = (event: KeyboardEvent) => void;

interface Dom {
  host: FakeHost;
  card: FakeCard;
  checkboxes: Record<string, FakeCheckbox>;
  bodyClasses: Set<string>;
}

const CHECKBOX_IDS = ['popupsEnabled', 'popupsWhatsNew', 'popupsAchievements'] as const;

// The same minimal document fake test/detail-sheet.test.ts uses, extended with
// what boot/popups.ts reads: the visibility state, the Settings card and its
// three checkboxes, and the generic query helpers live-sync's guards call.
//
// That test file is the source of this fake, not a file this slice changes: the
// plan names it for its makeHost/installDom shape, and detail-sheet.ts's own
// onClose behaviour is already covered there (added with the sheet change, see
// "detail sheet onClose (#1956)" in that file).
function installDom(): Dom {
  const host = makeHost();
  const card: FakeCard = { innerHTML: '', dataset: {}, style: {} };
  const checkboxes: Record<string, FakeCheckbox> = {};
  for (const id of CHECKBOX_IDS) checkboxes[id] = { id, checked: false, disabled: false, onchange: null };
  const byId = new Map<string, unknown>();
  byId.set('detailSheet', host);
  byId.set('popupSettingsCard', card);
  for (const id of CHECKBOX_IDS) byId.set(id, checkboxes[id]);
  const bodyClasses = new Set<string>();
  const listeners: Record<string, KeyHandler[]> = {};
  g.window = {
    matchMedia: () => ({ matches: false }),
    innerWidth: 1200,
    innerHeight: 800,
  };
  g.document = {
    visibilityState: 'visible',
    activeElement: null,
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { classList: makeClassList(bodyClasses) },
    contains: () => true,
    addEventListener: (type: string, fn: KeyHandler) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type: string, fn: KeyHandler) => {
      const kept = listeners[type];
      if (kept) listeners[type] = kept.filter(f => f !== fn);
    },
  };
  return { host, card, checkboxes, bodyClasses };
}

interface ServerState {
  prefs: Record<string, unknown>;
  badges: Badge[];
  puts: Record<string, unknown>[];
  urls: string[];
  prefsStatus: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// A tiny in-memory server: the ui-prefs map it holds, the PUT bodies it saw and
// every URL the app asked for (so an ingress-unsafe URL shows up in a test).
function installServer(state: ServerState): void {
  vi.stubGlobal('fetch', (url: string, opts?: RequestInit): Promise<Response> => {
    state.urls.push(url);
    const init = opts ?? {};
    if (url.startsWith('api/ui-prefs')) {
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'PUT') {
        const raw = typeof init.body === 'string' ? init.body : '{}';
        const body = JSON.parse(raw) as Record<string, unknown>;
        state.puts.push(body);
        Object.assign(state.prefs, body);
        return Promise.resolve(jsonResponse(body));
      }
      if (state.prefsStatus !== 200) return Promise.resolve(jsonResponse({ error: 'unavailable' }, state.prefsStatus));
      return Promise.resolve(jsonResponse({ ...state.prefs }));
    }
    if (url.startsWith('api/achievements')) return Promise.resolve(jsonResponse({ badges: state.badges }));
    return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
  });
}

type PopupsModule = typeof import('../public-src/boot/popups.js');
type PrefsModule = typeof import('../public-src/ui-prefs.js');
type SheetsModule = typeof import('../public-src/components/detail-sheet.js');
type I18nModule = typeof import('../public-src/i18n.js');
type StateModule = typeof import('../public-src/state/index.js');

interface Setup {
  cache?: Record<string, unknown>;
  pending?: readonly string[];
  prefs?: Record<string, unknown>;
  badges?: readonly Badge[];
  prefsStatus?: number;
}

interface Ctx {
  popups: PopupsModule;
  prefs: PrefsModule;
  sheets: SheetsModule;
  i18n: I18nModule;
  S: StateModule['S'];
  dom: Dom;
  server: ServerState;
  settle: (spanMs?: number) => Promise<void>;
  boot: (shots?: number) => Promise<void>;
}

const newestVersion = (): string => getWhatsNewEntries()[0]!.version;

// Loads one fresh module graph (module state — the queue, the pref cache and
// the sheet — must never leak between tests) on top of the given cache.
async function harness(setup: Setup = {}): Promise<Ctx> {
  storage.clear();
  if (setup.cache) storage.set('glp_ui_prefs', JSON.stringify(setup.cache));
  if (setup.pending) storage.set('glp_ui_prefs_pending', JSON.stringify(setup.pending));
  const dom = installDom();
  const server: ServerState = {
    prefs: { ...(setup.prefs ?? {}) },
    badges: [...(setup.badges ?? [])],
    puts: [],
    urls: [],
    prefsStatus: setup.prefsStatus ?? 200,
  };
  installServer(server);
  vi.resetModules();
  const popups = await import('../public-src/boot/popups.js');
  const prefs = await import('../public-src/ui-prefs.js');
  const sheets = await import('../public-src/components/detail-sheet.js');
  const i18n = await import('../public-src/i18n.js');
  const { S } = await import('../public-src/state/index.js');

  // Advances the clock in small steps, draining the promise chains the fetch
  // stub and the queue's refresh/retry steps leave behind, and stops before the
  // 2s retry. A test that must observe a held-back popup passes a shorter span.
  const settle = async (spanMs = 100): Promise<void> => {
    const step = 5;
    for (let waited = 0; waited < spanMs; waited += step) {
      await vi.advanceTimersByTimeAsync(step);
      await Promise.resolve();
    }
  };
  const boot = async (shots = 1): Promise<void> => {
    await prefs.loadUiPrefsFromServer();
    S.allShots = Array.from({ length: shots }, (_, i) => ({ id: i + 1, timestamp: 0 }));
    popups.startPopups(() => {});
    await settle();
  };
  popups.renderPopupSettings();
  return { popups, prefs, sheets, i18n, S, dom, server, settle, boot };
}

// The switches are driven through the real checkbox handler, the way the
// Settings card wires them.
function setSwitch(ctx: Ctx, id: string, checked: boolean): void {
  const box = ctx.dom.checkboxes[id];
  if (!box) throw new Error(`no checkbox ${id}`);
  box.checked = checked;
  box.onchange?.();
}

function hideWhatsNew(ctx: Ctx): void {
  ctx.server.prefs[ctx.prefs.SEEN_WHATS_NEW_PREF] = ctx.popups.versionCode(newestVersion());
}

function seen(ctx: Ctx, key: string): unknown {
  return ctx.prefs.getUiPref<unknown>(key);
}

/** The value of `key` in the last PUT body that carried it. */
function sent(ctx: Ctx, key: string): unknown {
  for (let i = ctx.server.puts.length - 1; i >= 0; i--) {
    const body = ctx.server.puts[i];
    if (body && key in body) return body[key];
  }
  return undefined;
}

async function flushWrites(): Promise<void> {
  await vi.advanceTimersByTimeAsync(700);
}

async function closeAndWait(ctx: Ctx): Promise<void> {
  ctx.sheets.closeDetailSheet();
  await vi.advanceTimersByTimeAsync(400);
  await ctx.settle();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a new version and a new achievement', () => {
  const update = { prefs: { 'popups.achievements_seen': 0 }, badges: [unlockedBadge('badge_a', 'First badge', 100)] };

  // The control run: every switch is switched on through its real checkbox
  // handler, the way the Settings card does it.
  function allSwitchesOn(ctx: Ctx): void {
    setSwitch(ctx, 'popupsEnabled', true);
    setSwitch(ctx, 'popupsWhatsNew', true);
    setSwitch(ctx, 'popupsAchievements', true);
  }

  it('shows What\'s New first and the achievement after it', async () => {
    const ctx = await harness(update);
    allSwitchesOn(ctx);
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toContain(`v${newestVersion()}`);
    expect(ctx.dom.host.innerHTML).not.toContain('First badge');

    await closeAndWait(ctx);

    expect(ctx.dom.host.innerHTML).toContain('First badge');
    expect(ctx.dom.host.innerHTML).not.toContain(`v${newestVersion()}`);
  });

  it('never holds both popups at the same time', async () => {
    const ctx = await harness(update);
    allSwitchesOn(ctx);
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toContain(`v${newestVersion()}`);
    expect(ctx.dom.host.innerHTML).not.toContain('First badge');

    ctx.sheets.closeDetailSheet();
    expect(ctx.dom.host.innerHTML).toBe('');
    await vi.advanceTimersByTimeAsync(399);
    expect(ctx.dom.host.innerHTML).toBe('');

    await vi.advanceTimersByTimeAsync(1);
    await ctx.settle();
    expect(ctx.dom.host.innerHTML).toContain('First badge');
    expect(ctx.dom.host.innerHTML).not.toContain(`v${newestVersion()}`);
  });
});

describe('the three Settings switches', () => {
  const fixture = (): Setup => ({
    prefs: { 'popups.achievements_seen': 0 },
    badges: [unlockedBadge('badge_a', 'First badge', 100)],
  });

  it('popupsWhatsNew off shows only the achievement, and its marker still advances', async () => {
    const ctx = await harness(fixture());
    setSwitch(ctx, 'popupsWhatsNew', false);
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toContain('First badge');
    expect(ctx.dom.host.innerHTML).not.toContain(`v${newestVersion()}`);
    expect(seen(ctx, ctx.prefs.SEEN_WHATS_NEW_PREF)).toBe(ctx.popups.versionCode(newestVersion()));

    await flushWrites();
    expect(sent(ctx, ctx.prefs.SEEN_WHATS_NEW_PREF)).toBe(ctx.popups.versionCode(newestVersion()));
  });

  it('popupsAchievements off shows only What\'s New, and its marker still advances', async () => {
    const ctx = await harness(fixture());
    setSwitch(ctx, 'popupsAchievements', false);
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toContain(`v${newestVersion()}`);
    expect(ctx.dom.host.innerHTML).not.toContain('First badge');
    expect(seen(ctx, ctx.prefs.SEEN_ACHIEVEMENTS_PREF)).toBe(100);

    await flushWrites();
    expect(sent(ctx, ctx.prefs.SEEN_ACHIEVEMENTS_PREF)).toBe(100);
  });

  it('popupsEnabled off shows neither, and both markers still advance', async () => {
    const ctx = await harness(fixture());
    setSwitch(ctx, 'popupsEnabled', false);
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toBe('');
    expect(seen(ctx, ctx.prefs.SEEN_WHATS_NEW_PREF)).toBe(ctx.popups.versionCode(newestVersion()));
    expect(seen(ctx, ctx.prefs.SEEN_ACHIEVEMENTS_PREF)).toBe(100);

    await flushWrites();
    expect(sent(ctx, ctx.prefs.SEEN_WHATS_NEW_PREF)).toBe(ctx.popups.versionCode(newestVersion()));
    expect(sent(ctx, ctx.prefs.SEEN_ACHIEVEMENTS_PREF)).toBe(100);
  });

  it('switching back on brings no backlog', async () => {
    const ctx = await harness(fixture());
    setSwitch(ctx, 'popupsEnabled', false);
    await ctx.boot();
    expect(ctx.dom.host.innerHTML).toBe('');

    setSwitch(ctx, 'popupsEnabled', true);
    await ctx.boot();
    expect(ctx.dom.host.innerHTML).toBe('');
  });
});

describe('achievement details', () => {
  it('a first run records the newest unlock instead of opening a backlog', async () => {
    const badges = Array.from({ length: 10 }, (_, i) => (
      unlockedBadge(`badge_${String.fromCharCode(97 + i)}`, `Badge ${i}`, 100 + i)
    ));
    const ctx = await harness({ badges });
    hideWhatsNew(ctx);
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toBe('');
    expect(seen(ctx, ctx.prefs.SEEN_ACHIEVEMENTS_PREF)).toBe(109);

    ctx.server.badges = [...badges, unlockedBadge('badge_new', 'Newest badge', 200)];
    await ctx.popups.checkAchievementPopups();
    await ctx.settle();

    expect(ctx.dom.host.innerHTML).toContain('Newest badge');
    expect(ctx.dom.host.innerHTML).not.toContain('Badge 0');
  });

  it('records 0 with nothing unlocked and opens on the first unlock afterwards', async () => {
    const ctx = await harness({ badges: [] });
    hideWhatsNew(ctx);
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toBe('');
    expect(seen(ctx, ctx.prefs.SEEN_ACHIEVEMENTS_PREF)).toBe(0);

    ctx.server.badges = [unlockedBadge('badge_a', 'First badge', 50)];
    await ctx.popups.checkAchievementPopups();
    await ctx.settle();

    expect(ctx.dom.host.innerHTML).toContain('First badge');
  });

  it('lists three new unlocks in one sheet with the plural title', async () => {
    const ctx = await harness({
      prefs: { 'popups.achievements_seen': 100 },
      badges: [
        unlockedBadge('badge_a', 'First badge', 200),
        unlockedBadge('badge_b', 'Second badge', 201),
        unlockedBadge('badge_c', 'Third badge', 202),
      ],
    });
    hideWhatsNew(ctx);
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toContain('First badge');
    expect(ctx.dom.host.innerHTML).toContain('Second badge');
    expect(ctx.dom.host.innerHTML).toContain('Third badge');
    expect(ctx.dom.host.innerHTML).toContain(ctx.i18n.t('popups_ach_title_many', 3));
  });

  it('uses the singular title for one new unlock', async () => {
    const ctx = await harness({
      prefs: { 'popups.achievements_seen': 100 },
      badges: [unlockedBadge('badge_a', 'First badge', 200)],
    });
    hideWhatsNew(ctx);
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toContain(ctx.i18n.t('popups_ach_title_one'));
    expect(ctx.dom.host.innerHTML).toContain('First badge');
  });

  it('reveals nothing that is still locked', async () => {
    const ctx = await harness({
      prefs: { 'popups.achievements_seen': 100 },
      badges: [
        unlockedBadge('badge_a', 'First badge', 200),
        lockedBadge('locked_badge'),
        lockedSecret('hidden_badge'),
      ],
    });
    hideWhatsNew(ctx);
    await ctx.boot();

    const html = ctx.dom.host.innerHTML;
    expect(html).toContain('First badge');
    expect(html).not.toContain('locked_badge');
    expect(html).not.toContain('hidden_badge');
    // One entry only: the locked badges add nothing to the list.
    expect(html.match(/whats-new-entry/g) ?? []).toHaveLength(1);
  });

  it('escapes the name an unlocked secret badge brought', async () => {
    const ctx = await harness({
      prefs: { 'popups.achievements_seen': 100 },
      badges: [unlockedBadge('badge_a', '<b>x</b>', 200)],
    });
    hideWhatsNew(ctx);
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(ctx.dom.host.innerHTML).not.toContain('<b>x</b>');
  });

  it('never renders an unlocked badge\'s id', async () => {
    const ctx = await harness({
      prefs: { 'popups.achievements_seen': 100 },
      badges: [unlockedBadge('badge_a', 'Plain badge name', 200)],
    });
    hideWhatsNew(ctx);
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toContain('Plain badge name');
    expect(ctx.dom.host.innerHTML).not.toContain('badge_a');
  });
});

describe('the shared seen markers', () => {
  it('leaves an out-of-date cache alone and opens nothing', async () => {
    const ctx = await harness({
      cache: { 'popups.whats_new_seen': 1, 'popups.achievements_seen': 50 },
      prefs: { 'popups.achievements_seen': 200 },
      badges: [unlockedBadge('badge_a', 'First badge', 200)],
    });
    ctx.server.prefs[ctx.prefs.SEEN_WHATS_NEW_PREF] = ctx.popups.versionCode(newestVersion());
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toBe('');
    expect(ctx.server.puts).toEqual([]);
  });

  it('opens nothing and writes nothing when the server cannot be read', async () => {
    const ctx = await harness({ prefsStatus: 500 });
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toBe('');
    expect(ctx.server.puts).toEqual([]);
    expect(seen(ctx, ctx.prefs.SEEN_WHATS_NEW_PREF)).toBeUndefined();
    expect(seen(ctx, ctx.prefs.SEEN_ACHIEVEMENTS_PREF)).toBeUndefined();
  });

  it('keeps a higher marker another device already wrote', async () => {
    const ctx = await harness({
      cache: { 'popups.whats_new_seen': 1 },
      pending: ['popups.whats_new_seen'],
      prefs: { 'popups.achievements_seen': 0 },
    });
    const current = ctx.popups.versionCode(newestVersion());
    ctx.server.prefs[ctx.prefs.SEEN_WHATS_NEW_PREF] = current;
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toBe('');
    expect(seen(ctx, ctx.prefs.SEEN_WHATS_NEW_PREF)).toBe(current);
    expect(ctx.server.prefs[ctx.prefs.SEEN_WHATS_NEW_PREF]).toBe(current);
    await flushWrites();
    expect(sent(ctx, ctx.prefs.SEEN_WHATS_NEW_PREF)).toBe(current);
  });

  it('drops a popup another device dealt with while it waited', async () => {
    // Both markers are current here, so the wait writes nothing at all and the
    // only thing that can open a sheet is the What's New request.
    const ctx = await harness({
      prefs: { 'popups.achievements_seen': 100 },
      badges: [unlockedBadge('badge_a', 'First badge', 100)],
    });
    ctx.dom.bodyClasses.add('lib-sheet-open');
    await ctx.boot();
    await vi.advanceTimersByTimeAsync(4000);

    expect(ctx.dom.host.innerHTML).toBe('');
    expect(ctx.server.puts).toEqual([]);

    ctx.server.prefs[ctx.prefs.SEEN_WHATS_NEW_PREF] = ctx.popups.versionCode(newestVersion());
    ctx.dom.bodyClasses.delete('lib-sheet-open');
    await vi.advanceTimersByTimeAsync(2000);
    await ctx.settle();

    expect(ctx.dom.host.innerHTML).toBe('');
    expect(ctx.server.puts).toEqual([]);
  });

  it('leaves unrelated preferences untouched', async () => {
    const ctx = await harness({
      prefs: { view: 'shots', 'machine.active': 1, 'popups.achievements_seen': 0 },
      badges: [unlockedBadge('badge_a', 'First badge', 100)],
    });
    await ctx.boot();
    await closeAndWait(ctx);
    expect(ctx.dom.host.innerHTML).toContain('First badge');
    ctx.sheets.closeDetailSheet();
    await flushWrites();

    expect(ctx.server.prefs.view).toBe('shots');
    expect(ctx.server.prefs['machine.active']).toBe(1);
    for (const body of ctx.server.puts) {
      expect(body).not.toHaveProperty('view');
      expect(body).not.toHaveProperty('machine.active');
    }
  });
});

describe('when a popup may not open yet', () => {
  it('waits while a shot is running and opens on the retry', async () => {
    const ctx = await harness({
      prefs: { 'popups.achievements_seen': 0 },
      badges: [unlockedBadge('badge_a', 'First badge', 100)],
    });
    ctx.S.liveWasLive = true;
    await ctx.boot();
    await vi.advanceTimersByTimeAsync(4000);

    expect(ctx.dom.host.innerHTML).toBe('');
    expect(ctx.server.puts).toEqual([]);
    expect(seen(ctx, ctx.prefs.SEEN_WHATS_NEW_PREF)).toBeUndefined();
    expect(seen(ctx, ctx.prefs.SEEN_ACHIEVEMENTS_PREF)).toBe(0);

    ctx.S.liveWasLive = false;
    await vi.advanceTimersByTimeAsync(2000);
    await ctx.settle();

    expect(ctx.dom.host.innerHTML).toContain(`v${newestVersion()}`);
  });
});

describe('ingress', () => {
  it('asks the server with relative URLs only', async () => {
    const ctx = await harness({
      prefs: { 'popups.achievements_seen': 0 },
      badges: [unlockedBadge('badge_a', 'First badge', 100)],
    });
    await ctx.boot();
    await closeAndWait(ctx);
    await flushWrites();

    expect(ctx.server.urls.length).toBeGreaterThan(0);
    for (const url of ctx.server.urls) {
      expect(url.startsWith('/')).toBe(false);
      expect(url.startsWith('http')).toBe(false);
    }
  });
});

// #2038: the read marker is independent of the popup switches. A switched-off
// What's New popup still advances the seen marker at start-up (see the seen
// marker cases above), which must not count as "read".
describe('the What\'s New read marker (#2038)', () => {
  it('stays unread while the What\'s New popup is switched off', async () => {
    const ctx = await harness({ prefs: { 'popups.achievements_seen': 0 } });
    setSwitch(ctx, 'popupsWhatsNew', false);
    await ctx.boot();

    expect(seen(ctx, ctx.prefs.SEEN_WHATS_NEW_PREF)).toBe(ctx.popups.versionCode(newestVersion()));
    expect(seen(ctx, ctx.prefs.READ_WHATS_NEW_PREF)).toBeUndefined();
    expect(ctx.popups.whatsNewUnread()).toBe(true);
  });

  it('opening What\'s New in Settings marks it read', async () => {
    const ctx = await harness({ prefs: { 'popups.achievements_seen': 0 } });
    setSwitch(ctx, 'popupsWhatsNew', false);
    await ctx.boot();

    ctx.popups.markWhatsNewRead();

    expect(ctx.popups.whatsNewUnread()).toBe(false);
    await flushWrites();
    expect(sent(ctx, ctx.prefs.READ_WHATS_NEW_PREF)).toBe(ctx.popups.versionCode(newestVersion()));
  });

  it('opening the popup marks it read', async () => {
    const ctx = await harness({ prefs: { 'popups.achievements_seen': 0 } });
    await ctx.boot();

    expect(ctx.dom.host.innerHTML).toContain(`v${newestVersion()}`);
    expect(seen(ctx, ctx.prefs.READ_WHATS_NEW_PREF)).toBe(ctx.popups.versionCode(newestVersion()));
    expect(ctx.popups.whatsNewUnread()).toBe(false);
  });
});
