import { vi } from 'vitest';

// #1615: a browser just complete enough to import the real main.ts and run
// its DOMContentLoaded boot under vitest's node environment. There is no DOM
// library in this repo, so the document is a catch-all stub: every property
// is another stub, every call/construct returns one, and elements fetched by
// id are cached with a real EventTarget behind them so a listener main.ts
// wires can be fired from a test. Tree-walking properties return null so no
// `while (el.parentElement)` loop can spin forever.

const NULL_PROPS = new Set<PropertyKey>([
  'parentElement', 'parentNode', 'offsetParent', 'nextElementSibling', 'previousElementSibling',
  'nextSibling', 'previousSibling', 'firstChild', 'lastChild', 'firstElementChild', 'lastElementChild',
  'then',
]);

export function stub(overrides: Record<PropertyKey, unknown> = {}): unknown {
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

export interface BootStubOptions {
  // Ids getElementById answers null for (a markup change dropped them).
  missingIds?: string[];
  // Request paths (no query string) whose fetch rejects like a network error.
  failingPaths?: string[];
  // Response bodies overriding the defaults, by request path.
  bodies?: Record<string, unknown>;
}

export interface BootStubs {
  doc: EventTarget;
  element: (id: string) => EventTarget;
  // Request paths in the order they were fetched.
  requested: string[];
}

// Installs the browser globals main.ts needs and returns handles on them.
export function installBootStubs({ missingIds = [], failingPaths = [], bodies = {} }: BootStubOptions = {}): BootStubs {
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

  const byId = new Map<string, EventTarget>();
  const element = (id: string): EventTarget => {
    if (!byId.has(id)) byId.set(id, stub() as EventTarget);
    return byId.get(id) as EventTarget;
  };
  const getElementById = (id: string): EventTarget | null => (missingIds.includes(id) ? null : element(id));
  const doc = stub({ getElementById, readyState: 'loading' }) as EventTarget;
  g.document = doc;

  const requested: string[] = [];
  g.fetch = vi.fn((url: string) => {
    const path = String(url).split('?')[0] ?? '';
    requested.push(path);
    if (failingPaths.includes(path)) return Promise.reject(new TypeError('Failed to fetch'));
    const body = path in bodies ? bodies[path] : path in BODIES ? BODIES[path] : {};
    return Promise.resolve({
      ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)),
    });
  });

  return { doc, element, requested };
}
