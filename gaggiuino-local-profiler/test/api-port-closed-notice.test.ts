// #807: surfacing the "expose_api_port is off and this session isn't
// Ingress" state where it is actually noticed (in-view notice + app-wide
// banner), instead of only in the Settings API-token card (#803).
//
// The module graph under test touches localStorage/navigator at import time
// (state.js) and document/sessionStorage at call time, so the browser
// globals are stubbed the same way test/api-token-client-storage.test.js and
// test/dev-banner.test.js already do under vitest's node environment.
import { describe, it, expect, beforeEach } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge test/helpers/fake-option-dom.ts uses).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const _session = new Map<string, string>();
g.sessionStorage = {
  getItem: (k: string) => (_session.has(k) ? _session.get(k) : null),
  setItem: (k: string, v: string) => _session.set(k, String(v)),
  removeItem: (k: string) => _session.delete(k),
};

const { S } = await import('../public-src/state/index.js');
const { isApiPortBlocked } = await import('../public-src/api/transport.js');
const { apiPortClosedHtml, updateApiPortClosedBanner } =
  await import('../public-src/components/api-port-notice.js');

// The DOM stand-in the banner component builds against: only the members the
// component and these tests touch.
interface FakeNode {
  id?: string;
  style: Record<string, unknown>;
  textContent: string;
  dataset: Record<string, unknown>;
  offsetHeight: number;
  children: FakeNode[];
  _listeners: Record<string, () => void>;
  append: (...kids: FakeNode[]) => void;
  addEventListener: (ev: string, fn: () => void) => void;
  remove: () => void;
}

interface FakeDocument {
  body: { style: Record<string, unknown>; insertAdjacentElement: (position: string, el: FakeNode) => void };
  getElementById: (id: string) => FakeNode | undefined;
  createElement: () => FakeNode;
}

function makeFakeDocument(): FakeDocument {
  const registry = new Map<string, FakeNode>();
  const body = {
    style: {},
    insertAdjacentElement: (_pos: string, el: FakeNode) => { registry.set(el.id as string, el); },
  };
  return {
    body,
    getElementById: id => registry.get(id),
    createElement: () => {
      const el: FakeNode = {
        style: {}, textContent: '', dataset: {}, offsetHeight: 34, children: [],
        _listeners: {},
        append: (...kids) => { el.children.push(...kids); },
        addEventListener: (ev, fn) => { el._listeners[ev] = fn; },
        remove: () => { registry.delete(el.id as string); },
      };
      return el;
    },
  };
}

let doc: FakeDocument;

beforeEach(() => {
  _session.clear();
  doc = makeFakeDocument();
  g.document = doc;
  S.glpToken = '';
  S.apiPortExposed = true;
});

describe('isApiPortBlocked() (#807)', () => {
  it('is true for a 401 when the port is closed and the session has no token', () => {
    S.apiPortExposed = false;
    expect(isApiPortBlocked(401)).toBe(true);
    expect(isApiPortBlocked(403)).toBe(true);
  });

  it('is false while expose_api_port is on — the default, so a real 401 stays a real 401', () => {
    expect(isApiPortBlocked(401)).toBe(false);
  });

  it('is false for an Ingress session, which holds a token even with the port closed', () => {
    S.apiPortExposed = false;
    S.glpToken = 'ingress-session-token';
    expect(isApiPortBlocked(401)).toBe(false);
  });

  it('does not claim unrelated failures (500, 404) as port-closed', () => {
    S.apiPortExposed = false;
    expect(isApiPortBlocked(500)).toBe(false);
    expect(isApiPortBlocked(404)).toBe(false);
  });

  it('answers the plain session question when no status is passed', () => {
    S.apiPortExposed = false;
    expect(isApiPortBlocked()).toBe(true);
    S.apiPortExposed = true;
    expect(isApiPortBlocked()).toBe(false);
  });
});

describe('in-view notice (#807)', () => {
  it('explains the state and offers a jump to Settings instead of a bare status code', () => {
    const html = apiPortClosedHtml();
    expect(html).toContain('expose_api_port');
    expect(html).toContain('Ingress');
    expect(html).toContain('data-action="goto-settings"');
    expect(html).not.toContain('HTTP 401');
  });
});

describe('app-wide banner (#807)', () => {
  it('appears once the status poll reports the port closed for a token-less session', () => {
    S.apiPortExposed = false;
    updateApiPortClosedBanner();
    const banner = doc.getElementById('glpApiPortClosedBanner');
    expect(banner).toBeDefined();
    expect(banner?.children.some(c => c.dataset.action === 'goto-settings')).toBe(true);
    expect(banner?.children[0].textContent).toContain('expose_api_port');
  });

  it('is not shown in the default (port exposed) state', () => {
    updateApiPortClosedBanner();
    expect(doc.getElementById('glpApiPortClosedBanner')).toBeUndefined();
  });

  it('removes itself again once the option is turned back on and a token arrives', () => {
    S.apiPortExposed = false;
    updateApiPortClosedBanner();
    expect(doc.getElementById('glpApiPortClosedBanner')).toBeDefined();

    S.apiPortExposed = true;
    S.glpToken = 'token-after-reenable';
    updateApiPortClosedBanner();
    expect(doc.getElementById('glpApiPortClosedBanner')).toBeUndefined();
  });

  it('stays dismissed for the rest of the session, across further status polls', () => {
    S.apiPortExposed = false;
    updateApiPortClosedBanner();
    const banner = doc.getElementById('glpApiPortClosedBanner');
    const closeBtn = banner?.children[banner.children.length - 1];
    closeBtn?._listeners.click();

    expect(doc.getElementById('glpApiPortClosedBanner')).toBeUndefined();
    updateApiPortClosedBanner();
    expect(doc.getElementById('glpApiPortClosedBanner')).toBeUndefined();
  });

  it('does not stack duplicates across repeated polls', () => {
    S.apiPortExposed = false;
    updateApiPortClosedBanner();
    const first = doc.getElementById('glpApiPortClosedBanner');
    updateApiPortClosedBanner();
    expect(doc.getElementById('glpApiPortClosedBanner')).toBe(first);
  });
});
