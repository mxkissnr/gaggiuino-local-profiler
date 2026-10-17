import { describe, it, expect, vi } from 'vitest';

// #1615: with storage blocked by the browser (cookies/site data off, Safari
// private mode, sandboxed iframe) merely reading the `localStorage` global
// throws a SecurityError. state/index.ts used to read it at import time and
// initToken() at the head of the boot chain, so the whole SPA failed to
// start. This boots the real main.ts with both storage getters throwing and
// checks the import, the DOMContentLoaded wiring and the data boot chain all
// still run. An error thrown or rejected anywhere along the way surfaces as
// an unhandled error, which fails the vitest run on its own.
//
// There is no DOM library in this repo, so the document is a catch-all stub:
// every property is another stub, every call/construct returns one, and
// elements fetched by id are cached with a real EventTarget behind them so a
// listener main.ts wires can be fired from the test. Tree-walking properties
// return null so no `while (el.parentElement)` loop can spin forever.

const NULL_PROPS = new Set<PropertyKey>([
  'parentElement', 'parentNode', 'offsetParent', 'nextElementSibling', 'previousElementSibling',
  'nextSibling', 'previousSibling', 'firstChild', 'lastChild', 'firstElementChild', 'lastElementChild',
  'then',
]);

function stub(overrides: Record<PropertyKey, unknown> = {}): unknown {
  const events = new EventTarget();
  const props = new Map<PropertyKey, unknown>(Object.entries(overrides));
  const eventMethods: Record<PropertyKey, unknown> = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  return new Proxy(function stubFn() { /* callable */ }, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return (hint: string) => (hint === 'number' ? 0 : '');
      if (prop === Symbol.iterator) return function* empty() { /* no children */ };
      if (props.has(prop)) return props.get(prop);
      if (prop in eventMethods) return eventMethods[prop];
      if (NULL_PROPS.has(prop)) return undefined;
      if (prop === 'closest') return () => null;
      if (prop === 'length') return 0;
      const child = stub();
      props.set(prop, child);
      return child;
    },
    set(_target, prop, value) { props.set(prop, value); return true; },
    has: () => false,
    apply: () => stub(),
    construct: () => stub() as object,
  });
}

// The stub document plus typed access to the elements main.ts looked up by id.
function stubDocument(): { doc: EventTarget; element: (id: string) => EventTarget } {
  const byId = new Map<string, EventTarget>();
  const element = (id: string): EventTarget => {
    if (!byId.has(id)) byId.set(id, stub() as EventTarget);
    return byId.get(id) as EventTarget;
  };
  return { doc: stub({ getElementById: element, readyState: 'loading' }) as EventTarget, element };
}

// Response bodies for the endpoints whose callers need a specific shape;
// everything else answers `{}`.
const BODIES: Record<string, unknown> = {
  'api/token': { token: 'test-token' },
  'api/machines': [],
  'api/menu': [],
  'api/library/milks': [],
  'api/library': { beans: [], grinders: [], recipes: [], milks: [], baskets: [], puckScreens: [] },
  'api/shots': [],
};

function throwingStorage(): never {
  throw new DOMException('The operation is insecure.', 'SecurityError');
}

describe('boot with blocked storage (#1615)', () => {
  it('imports main.ts, wires the DOM and runs the data boot chain while localStorage/sessionStorage throw', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const windowEvents = new EventTarget();
    g.window = g;
    g.addEventListener = windowEvents.addEventListener.bind(windowEvents);
    g.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
    g.dispatchEvent = windowEvents.dispatchEvent.bind(windowEvents);
    g.innerWidth = 1400;
    g.innerHeight = 900;
    g.location = { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost',
      hostname: 'localhost', pathname: '/', search: '', hash: '', reload: () => {} };
    g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    for (const name of ['EventSource', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'Image']) g[name] = stub();
    g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
    g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
    g.getComputedStyle = () => stub();
    const { doc, element } = stubDocument();
    g.document = doc;
    Object.defineProperty(g, 'localStorage', { get: throwingStorage, configurable: true });
    Object.defineProperty(g, 'sessionStorage', { get: throwingStorage, configurable: true });

    const requested: string[] = [];
    g.fetch = vi.fn((url: string) => {
      const path = String(url).split('?')[0] ?? '';
      requested.push(path);
      const body = path in BODIES ? BODIES[path] : {};
      return Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)),
      });
    });

    await import('../public-src/main.js');
    doc.dispatchEvent(new Event('DOMContentLoaded'));

    // The data boot chain ran to its end: token first, then the
    // settings/library/shots sequence, then the awaited status poll, after
    // which the update check (api/version) is the chain's last request.
    await vi.waitFor(() => {
      expect(requested).toContain('api/library');
      expect(requested).toContain('api/shots');
      expect(requested).toContain('api/version');
    }, { timeout: 4000 });
    expect(requested[0]).toBe('api/token');

    // The DOM wiring ran too: a nav button main.ts wired switches the mode.
    const { S } = await import('../public-src/state/index.js');
    element('btnLibrary').dispatchEvent(new Event('click'));
    expect(S.currentMode).toBe('library');
    // Reads fell back to defaults instead of throwing.
    expect(S.currentLang).toBe('en');
  });
});
