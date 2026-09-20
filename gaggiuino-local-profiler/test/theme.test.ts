// #1018: applyTheme()/resolveTheme()/watchSystemTheme() (public-src/theme.js).
// Split out of main.js specifically so this could be unit tested without
// pulling in main.js's whole side-effecting import chain -- see the fake
// minimal document/window approach test/library-load-render-race.test.js
// already uses for the same reason, rather than pulling in jsdom.
import { describe, it, expect, vi } from 'vitest';
import { resolveTheme, applyTheme, watchSystemTheme, THEME_STORAGE_KEY } from '../public-src/theme.js';

// vitest's node environment has no browser globals; the one global this file
// swaps in and out is reached through a loose view of globalThis, the same
// bridge test/api-port-closed-notice.test.ts uses.
const g = globalThis as unknown as Record<string, unknown>;

type RealWindow = Window & typeof globalThis;

interface FakeButton {
  dataset: { themeVal: string | undefined };
  classList: {
    toggle: (name: string, on: boolean) => void;
    contains: (name: string) => boolean;
  };
}

interface FakeDoc {
  documentElement: { dataset: Record<string, string> };
  querySelectorAll: (sel: string) => FakeButton[];
}

interface FakeMql {
  readonly matches: boolean;
  _win: FakeWin | null;
  addEventListener: (type: string, cb: () => void) => void;
}

interface FakeWin {
  prefersDark: boolean;
  matchMedia: (query: string) => FakeMql;
  fireChange: () => void;
  dispatchEvent: (e: { type: string }) => number;
  CustomEvent: new (type: string) => { type: string };
  events: string[];
}

// applyTheme()/watchSystemTheme() take the real Document/Window/Storage types;
// the fakes below implement only the sliver of each those functions touch, so
// they're cast at the call sites rather than made to look like the whole thing.
const asDoc = (doc: FakeDoc): Document => doc as unknown as Document;
const asWin = (win: FakeWin): RealWindow => win as unknown as RealWindow;
const asStorage = (storage: unknown): Storage => storage as Storage;

// A button as #themeToggleGroup's real markup declares it: class list +
// data-theme-val, nothing else applyTheme() touches.
function fakeButton(themeVal: string | undefined): FakeButton {
  const classes = new Set<string>(['theme-btn']);
  return {
    dataset: { themeVal },
    classList: {
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name),
    },
  };
}

function fakeDoc(buttons: FakeButton[]): FakeDoc {
  return {
    documentElement: { dataset: {} },
    querySelectorAll: sel =>
      sel === '#themeToggleGroup .theme-btn' ? buttons : [],
  };
}

// Stand-in for window.CustomEvent: applyTheme() constructs one and hands it to
// dispatchEvent(), which reads `.type` back off it.
class FakeCustomEvent {
  type: string;
  constructor(type: string) { this.type = type; }
}

// Fake `window`: a matchMedia stub whose `matches` and `change` listener are
// controlled by the test, plus the two globals applyTheme()/watchSystemTheme()
// call on it (dispatchEvent/CustomEvent).
function fakeWin(prefersDark = false): FakeWin {
  const listeners: Array<() => void> = [];
  const events: string[] = [];
  return {
    prefersDark,
    matchMedia: () => ({
      get matches() { return this._win!.prefersDark; },
      _win: null,
      addEventListener: (type, cb) => { if (type === 'change') listeners.push(cb); },
    }),
    fireChange: () => { listeners.forEach(cb => cb()); },
    dispatchEvent: e => events.push(e.type),
    CustomEvent: FakeCustomEvent,
    events,
  };
}
// matchMedia's returned object needs a live reference back to the win to
// read the current `prefersDark` -- wire it up after construction so
// `win.prefersDark = true` later is reflected without re-creating the MQL.
function linkWin(win: FakeWin): FakeWin {
  const realMatchMedia = win.matchMedia;
  win.matchMedia = query => {
    const mql = realMatchMedia(query);
    mql._win = win;
    return mql;
  };
  return win;
}

describe('resolveTheme (#1018)', () => {
  it('passes dark/light through unchanged', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
  it("resolves 'auto' to the OS preference", () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
  });
});

describe('applyTheme active-state class (#1018)', () => {
  it('marks only the dark button active for theme="dark"', () => {
    const dark = fakeButton('dark'), light = fakeButton('light'), auto = fakeButton('auto');
    const doc = fakeDoc([dark, light, auto]);
    const win = linkWin(fakeWin(false));
    applyTheme('dark', { doc: asDoc(doc), win: asWin(win) });
    expect(dark.classList.contains('active')).toBe(true);
    expect(light.classList.contains('active')).toBe(false);
    expect(auto.classList.contains('active')).toBe(false);
    expect(doc.documentElement.dataset.theme).toBe('dark');
  });

  it('marks only the light button active for theme="light"', () => {
    const dark = fakeButton('dark'), light = fakeButton('light'), auto = fakeButton('auto');
    const doc = fakeDoc([dark, light, auto]);
    const win = linkWin(fakeWin(true));
    applyTheme('light', { doc: asDoc(doc), win: asWin(win) });
    expect(light.classList.contains('active')).toBe(true);
    expect(dark.classList.contains('active')).toBe(false);
    expect(auto.classList.contains('active')).toBe(false);
    expect(doc.documentElement.dataset.theme).toBe('light');
  });

  // The user's SELECTION carries .active, not the resolved concrete theme --
  // picking Auto highlights the Auto button even though <html data-theme>
  // resolves to whatever the OS currently reports.
  it('marks only the auto button active for theme="auto", regardless of OS preference', () => {
    const dark = fakeButton('dark'), light = fakeButton('light'), auto = fakeButton('auto');
    const doc = fakeDoc([dark, light, auto]);
    const win = linkWin(fakeWin(true));
    applyTheme('auto', { doc: asDoc(doc), win: asWin(win) });
    expect(auto.classList.contains('active')).toBe(true);
    expect(dark.classList.contains('active')).toBe(false);
    expect(light.classList.contains('active')).toBe(false);
    // resolved concrete theme still lands on <html data-theme>
    expect(doc.documentElement.dataset.theme).toBe('dark');
  });

  // #1018's actual bug: main.js used to query the bare `.theme-btn` class,
  // which #mqttTransportToggle's WebSocket/MQTT buttons also carry (with no
  // data-theme-val) -- an unscoped query wired/matched those too, and
  // clicking one called setTheme(undefined), which matched neither 'dark'
  // nor 'light' and left BOTH real buttons permanently un-highlighted.
  // applyTheme() must never touch anything outside #themeToggleGroup.
  it('never touches buttons outside #themeToggleGroup (e.g. the MQTT transport toggle)', () => {
    const dark = fakeButton('dark'), light = fakeButton('light');
    const mqttBtn = fakeButton(undefined);
    mqttBtn.classList.toggle('active', true); // pre-existing, unrelated .active
    const doc = fakeDoc([dark, light]); // querySelectorAll is scoped -- mqttBtn never returned
    const win = linkWin(fakeWin(false));
    applyTheme('dark', { doc: asDoc(doc), win: asWin(win) });
    expect(dark.classList.contains('active')).toBe(true);
    expect(mqttBtn.classList.contains('active')).toBe(true); // untouched
  });

  it('fires the theme-change event so live charts re-theme', () => {
    const doc = fakeDoc([fakeButton('dark')]);
    const win = linkWin(fakeWin(false));
    applyTheme('dark', { doc: asDoc(doc), win: asWin(win) });
    expect(win.events).toContain('glp-theme-change');
  });
});

describe('watchSystemTheme (#1018 live auto re-resolution)', () => {
  it('re-applies the resolved theme on an OS change while auto is selected', () => {
    const dark = fakeButton('dark'), light = fakeButton('light'), auto = fakeButton('auto');
    const doc = fakeDoc([dark, light, auto]);
    const win = linkWin(fakeWin(false)); // starts light
    const storage = { getItem: vi.fn(() => 'auto'), setItem: () => {} };

    // watchSystemTheme() calls applyTheme() with its own default doc
    // (globalThis.document) unless we stub that too -- give it a global doc
    // stand-in via globalThis for the duration of this test.
    const realDocument = g.document;
    g.document = doc;
    try {
      watchSystemTheme({ win: asWin(win), storage: asStorage(storage) });
      expect(doc.documentElement.dataset.theme).not.toBe('dark'); // not applied yet, just watching

      win.prefersDark = true;
      win.fireChange();

      expect(storage.getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
      expect(doc.documentElement.dataset.theme).toBe('dark');
      expect(auto.classList.contains('active')).toBe(true);
    } finally {
      g.document = realDocument;
    }
  });

  it('does not re-apply on an OS change when auto is not the stored theme', () => {
    const dark = fakeButton('dark'), light = fakeButton('light');
    const doc = fakeDoc([dark, light]);
    doc.documentElement.dataset.theme = 'dark';
    const win = linkWin(fakeWin(false));
    const storage = { getItem: () => 'dark', setItem: () => {} };

    watchSystemTheme({ win: asWin(win), storage: asStorage(storage) });
    win.prefersDark = true;
    win.fireChange();

    // untouched -- no applyTheme() call should have fired
    expect(doc.documentElement.dataset.theme).toBe('dark');
    expect(dark.classList.contains('active')).toBe(false);
  });
});
