// #807: surfacing the "expose_api_port is off and this session isn't
// Ingress" state where it is actually noticed (in-view notice + app-wide
// banner), instead of only in the Settings API-token card (#803).
//
// The module graph under test touches localStorage/navigator at import time
// (state.js) and document/sessionStorage at call time, so the browser
// globals are stubbed the same way test/api-token-client-storage.test.js and
// test/dev-banner.test.js already do under vitest's node environment.
import { describe, it, expect, beforeEach } from 'vitest';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };

const _session = new Map();
globalThis.sessionStorage = {
  getItem: k => (_session.has(k) ? _session.get(k) : null),
  setItem: (k, v) => _session.set(k, String(v)),
  removeItem: k => _session.delete(k),
};

const { S } = await import('../public-src/state.js');
const { isApiPortBlocked } = await import('../public-src/api.js');
const { apiPortClosedHtml, updateApiPortClosedBanner } =
  await import('../public-src/components/api-port-notice.js');

function makeFakeDocument() {
  const registry = new Map();
  const body = {
    style: {},
    insertAdjacentElement: (_pos, el) => { registry.set(el.id, el); },
  };
  return {
    body,
    getElementById: id => registry.get(id),
    createElement: () => {
      const el = {
        style: {}, textContent: '', dataset: {}, offsetHeight: 34, children: [],
        _listeners: {},
        append: (...kids) => el.children.push(...kids),
        addEventListener: (ev, fn) => { el._listeners[ev] = fn; },
        remove: () => registry.delete(el.id),
      };
      return el;
    },
  };
}

let doc;

beforeEach(() => {
  _session.clear();
  doc = makeFakeDocument();
  globalThis.document = doc;
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
    expect(banner.children.some(c => c.dataset.action === 'goto-settings')).toBe(true);
    expect(banner.children[0].textContent).toContain('expose_api_port');
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
    const closeBtn = banner.children[banner.children.length - 1];
    closeBtn._listeners.click();

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
