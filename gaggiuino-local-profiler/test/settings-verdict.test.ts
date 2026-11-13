// #2038: the Settings verdict is the second host of the topbar machine icon,
// and the What's New row carries a roast dot that is independent of the popup
// switches. Same fake-DOM style as the topbar icon test; the ui-prefs cache is
// seeded through localStorage before the modules load, like the popups flow
// test does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;

const storage = new Map<string, string>();

function seedCache(cache: Record<string, unknown>): void {
  storage.clear();
  storage.set('glp_ui_prefs', JSON.stringify(cache));
}

seedCache({});

g.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
};
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;
(g.window as Record<string, unknown>).matchMedia = () => ({ matches: false });

const { S } = await import('../public-src/state/index.js');
const {
  renderTopbarMachineIcon, syncTopbarMachineIconFallback, settingsVerdictTitle,
} = await import('../public-src/components/topbar-machine-icon.js');
const popups = await import('../public-src/boot/popups.js');
const { READ_WHATS_NEW_PREF, SEEN_WHATS_NEW_PREF } =
  await import('../public-src/ui-prefs.js');
const { getWhatsNewEntries } = await import('../public-src/shared/whats-new.js');

const newestCode = (): number => popups.versionCode(getWhatsNewEntries()[0]!.version);

S.currentLang = 'en';

function makeHost() {
  const cls = new Set<string>();
  return {
    set className(v: string) {
      cls.clear();
      v.split(/\s+/).filter(Boolean).forEach(x => cls.add(x));
    },
    get className(): string { return [...cls].join(' '); },
    firstChild: null as unknown,
    classList: {
      add: (...c: string[]) => c.forEach(x => cls.add(x)),
      remove: (...c: string[]) => c.forEach(x => cls.delete(x)),
    },
    querySelector: () => null,
    set innerHTML(_v: string) { this.firstChild = {}; },
    has: (c: string) => cls.has(c),
  };
}

type Host = ReturnType<typeof makeHost>;

function makeTextEl() {
  return { textContent: '' };
}

interface Page {
  hidden: boolean;
  dataset: Record<string, string>;
}

interface FakeView {
  dataset: Record<string, string>;
  scrollTop: number;
  querySelector: (sel: string) => unknown;
  querySelectorAll: () => unknown[];
}

function fakeView(page: Page): FakeView {
  return {
    dataset: {},
    scrollTop: 320,
    querySelector: (sel: string) => (sel.includes('data-settings-page="whats-new"') ? page : null),
    querySelectorAll: () => [],
  };
}

let topbar: Host;
let settingsIcon: Host;
let title: ReturnType<typeof makeTextEl>;
let count: ReturnType<typeof makeTextEl>;
let countLbl: ReturnType<typeof makeTextEl>;
let dot: { hidden: boolean };

function installTopbarDom(): void {
  topbar = makeHost();
  settingsIcon = makeHost();
  title = makeTextEl();
  count = makeTextEl();
  countLbl = makeTextEl();
  const byId: Record<string, unknown> = {
    topbarMachineIcon: topbar,
    settingsMachineIcon: settingsIcon,
    settingsVerdictTitle: title,
    settingsMachineCount: count,
    settingsMachineCountLbl: countLbl,
  };
  g.document = { getElementById: (id: string) => byId[id] ?? null };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', () => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve({}),
  }));
  const state = S as unknown as Record<string, unknown>;
  state.machines = [
    { id: 1, name: 'Kitchen', host: '10.0.0.10', isDefault: true },
    { id: 2, name: 'Office', host: '10.0.0.11', isDefault: false },
  ];
  state.activeMachineId = 1;
  state.sseActive = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('settingsVerdictTitle() (#2038)', () => {
  it('asks for setup without a machine or without a host', () => {
    expect(settingsVerdictTitle(undefined, 'hot')).toBe('No machine set up yet');
    expect(settingsVerdictTitle({ name: 'Kitchen', host: '' }, 'hot')).toBe('No machine set up yet');
    expect(settingsVerdictTitle({ name: 'Kitchen', host: null }, 'hot')).toBe('No machine set up yet');
  });

  it('names the machine and whether it is reachable', () => {
    const machine = { name: 'Kitchen', host: '10.0.0.10' };
    expect(settingsVerdictTitle(machine, 'off')).toBe('Kitchen is off or not reachable');
    expect(settingsVerdictTitle(machine, 'hot')).toBe('Connected to Kitchen');
    expect(settingsVerdictTitle(machine, 'heating')).toBe('Connected to Kitchen');
  });
});

describe('the verdict is a second host of the machine icon (#2038)', () => {
  it('fills both hosts and writes the machine count', () => {
    installTopbarDom();
    renderTopbarMachineIcon();
    expect(topbar.firstChild).toBeTruthy();
    expect(settingsIcon.firstChild).toBeTruthy();
    expect(settingsIcon.className).toContain('settings-verdict-icon');
    expect(count.textContent).toBe('2');
    expect(countLbl.textContent).toBe('machines');
  });

  it('singularises the count label for one machine', () => {
    installTopbarDom();
    (S as unknown as Record<string, unknown>).machines = [
      { id: 1, name: 'Kitchen', host: '10.0.0.10', isDefault: true },
    ];
    renderTopbarMachineIcon();
    expect(count.textContent).toBe('1');
    expect(countLbl.textContent).toBe('machine');
  });

  it('follows the fallback reachability in the sentence', () => {
    installTopbarDom();
    renderTopbarMachineIcon();
    syncTopbarMachineIconFallback(false);
    expect(title.textContent).toBe('Kitchen is off or not reachable');
    syncTopbarMachineIconFallback(true);
    expect(title.textContent).toBe('Connected to Kitchen');
  });
});

describe('the What\'s New roast dot (#2038)', () => {
  it('shows while the newest release is unread, even with the popup off', async () => {
    seedCache({
      popups: { enabled: true, whats_new: false },
      [SEEN_WHATS_NEW_PREF]: newestCode(),
      [READ_WHATS_NEW_PREF]: 1,
    });
    vi.resetModules();
    const fresh = await import('../public-src/boot/popups.js');
    dot = { hidden: true };
    g.document = { getElementById: (id: string) => (id === 'settingsWhatsNewDot' ? dot : null) };

    expect(fresh.whatsNewUnread()).toBe(true);
    fresh.syncWhatsNewDot();
    expect(dot.hidden).toBe(false);
  });

  it('is cleared by opening the sub-page, without touching the seen marker', async () => {
    seedCache({
      popups: { enabled: true, whats_new: false },
      [SEEN_WHATS_NEW_PREF]: newestCode(),
      [READ_WHATS_NEW_PREF]: 1,
    });
    vi.resetModules();
    const freshPopups = await import('../public-src/boot/popups.js');
    const freshPrefs = await import('../public-src/ui-prefs.js');
    const freshSettings = await import('../public-src/boot/settings-page.js');
    dot = { hidden: false };
    const page: Page = { hidden: false, dataset: { settingsPage: 'whats-new' } };
    const view = fakeView(page);
    const pageTitle = { textContent: '', dataset: {} as Record<string, string> };
    g.document = {
      getElementById: (id: string) => (id === 'settingsWhatsNewDot' ? dot
        : id === 'settings-view' ? view
        : id === 'settingsPageTitle' ? pageTitle
        : null),
    };

    freshSettings.openSettingsPage('whats-new');

    expect(dot.hidden).toBe(true);
    expect(freshPrefs.getUiPref(READ_WHATS_NEW_PREF)).toBe(newestCode());
    expect(freshPrefs.getUiPref(SEEN_WHATS_NEW_PREF)).toBe(newestCode());
    expect(freshPopups.whatsNewUnread()).toBe(false);
  });

  it('does not throw without a dot element', async () => {
    seedCache({ [READ_WHATS_NEW_PREF]: 1 });
    vi.resetModules();
    const fresh = await import('../public-src/boot/popups.js');
    const freshPrefs = await import('../public-src/ui-prefs.js');
    g.document = { getElementById: () => null };

    expect(() => fresh.syncWhatsNewDot()).not.toThrow();
    expect(() => fresh.markWhatsNewRead()).not.toThrow();
    expect(freshPrefs.getUiPref(READ_WHATS_NEW_PREF)).toBe(newestCode());
  });
});
