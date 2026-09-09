import { describe, it, expect, beforeEach } from 'vitest';

// sidebar.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/sidebar-month-toggle.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };
globalThis.window       ??= {};

const { S } = await import('../public-src/state.js');
const { renderSidebar, toggleMonthGroup, filterShots } =
  await import('../public-src/components/sidebar.js');

// #969: renderSidebar()/_buildShotWrapper() build real DOM nodes, so this
// needs a fuller fake document than the other sidebar tests — a node factory
// with classList/style/dataset/children plus sibling links (filterShots()
// walks nextElementSibling), still no jsdom/happy-dom dependency. Only the
// handful of selectors sidebar.js actually queries are implemented.
let shotsEl;

function makeNode(tag) {
  const node = {
    tagName: tag,
    dataset: {},
    style: {},
    children: [],
    _cls: new Set(),
    _html: '',
    textContent: '',
    id: '', title: '', type: '', onclick: null,
    nextElementSibling: null,
    get className() { return [...this._cls].join(' '); },
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); if (v === '') this.children = []; },
    classList: {
      add: (...c) => c.forEach(x => node._cls.add(x)),
      remove: (...c) => c.forEach(x => node._cls.delete(x)),
      contains: x => node._cls.has(x),
    },
    appendChild(c) {
      const prev = this.children[this.children.length - 1];
      if (prev) prev.nextElementSibling = c;
      c.nextElementSibling = null;
      this.children.push(c);
      return c;
    },
  };
  return node;
}

function collect(root, pred, acc = []) {
  for (const ch of root.children) {
    if (pred(ch)) acc.push(ch);
    collect(ch, pred, acc);
  }
  return acc;
}

function installDocument() {
  shotsEl = makeNode('div');
  shotsEl.id = 'shots';
  globalThis.document = {
    createElement: makeNode,
    getElementById: id =>
      (id === 'shots' ? shotsEl : collect(shotsEl, n => n.id === id)[0] || null),
    querySelectorAll: sel => {
      if (sel.includes('.shot-wrapper')) return collect(shotsEl, n => n.classList.contains('shot-wrapper'));
      if (sel.includes('.sidebar-month-body')) return collect(shotsEl, n => n.classList.contains('sidebar-month-body'));
      if (sel.includes('.day-sep')) return collect(shotsEl, n => n.classList.contains('day-sep'));
      return [];
    },
    querySelector: sel => {
      const m = sel.match(/data-id="([^"]+)"/);
      if (!m) return null;
      return collect(shotsEl, n => n.dataset.action === 'toggle-month-group' && n.dataset.id === m[1])[0] || null;
    },
  };
}

const DAY = 86400000;
const monthKeyOf = daysAgo => {
  const d = new Date(Date.now() - daysAgo * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const mkShot = (id, daysAgo) => ({
  id,
  timestamp: Math.floor((Date.now() - daysAgo * DAY) / 1000),
  profile: { name: `Profile ${id}` },
  annotation: {},
});

const countWrappers = () => collect(shotsEl, n => n.classList.contains('shot-wrapper')).length;
const monthBody = key => collect(shotsEl, n => n.id === `monthGroup-${key}`)[0];

// Three fully-distinct older calendar months (well past the 14-day recent
// window) plus three shots in the last few days.
const OLD_A = 110, OLD_B = 75, OLD_C = 40;
const KEY_A = monthKeyOf(OLD_A), KEY_B = monthKeyOf(OLD_B), KEY_C = monthKeyOf(OLD_C);

function seedShots() {
  S.shots = [
    mkShot(1, OLD_A + 2), mkShot(2, OLD_A + 1), mkShot(3, OLD_A),
    mkShot(4, OLD_B + 2), mkShot(5, OLD_B + 1), mkShot(6, OLD_B),
    mkShot(7, OLD_C + 2), mkShot(8, OLD_C + 1), mkShot(9, OLD_C),
    mkShot(10, 2), mkShot(11, 1), mkShot(12, 0),
  ];
}

describe('sidebar lazy month groups (#969)', () => {
  beforeEach(() => {
    installDocument();
    S._expandedMonths = new Set();
    S.currentFilter = '';
    S.beanFilter = null;
    S.machines = [];
    S.currentSort = 'newest';
    S.sortAsc = false;
    seedShots();
  });

  it('builds wrappers only for recent day-groups, not for collapsed months', () => {
    renderSidebar();
    // 3 recent shots rendered; the 9 shots across 3 collapsed months are not.
    expect(countWrappers()).toBe(3);
    // The month bodies still exist (so the accordion headers have a target)
    // but are empty and hidden.
    for (const key of [KEY_A, KEY_B, KEY_C]) {
      const body = monthBody(key);
      expect(body).toBeTruthy();
      expect(body.children.length).toBe(0);
      expect(body.style.display).toBe('none');
    }
  });

  it('toggleMonthGroup builds a collapsed month on first expand, and does not rebuild on later toggles', () => {
    renderSidebar();
    expect(countWrappers()).toBe(3);

    toggleMonthGroup(KEY_C);
    expect(monthBody(KEY_C).children.length).toBe(3);
    expect(monthBody(KEY_C).style.display).toBe('');
    expect(countWrappers()).toBe(6);
    expect(S._expandedMonths.has(KEY_C)).toBe(true);

    toggleMonthGroup(KEY_C); // collapse
    expect(monthBody(KEY_C).style.display).toBe('none');
    expect(countWrappers()).toBe(6); // wrappers kept, just hidden

    toggleMonthGroup(KEY_C); // expand again — already built, no duplicates
    expect(monthBody(KEY_C).children.length).toBe(3);
    expect(countWrappers()).toBe(6);
  });

  it('a month already in S._expandedMonths renders built and visible', () => {
    S._expandedMonths.add(KEY_B);
    renderSidebar();
    expect(monthBody(KEY_B).children.length).toBe(3);
    expect(monthBody(KEY_B).style.display).toBe('');
    // recent (3) + the pre-expanded month (3); the other two months stay lazy.
    expect(countWrappers()).toBe(6);
    expect(monthBody(KEY_A).children.length).toBe(0);
    expect(monthBody(KEY_C).children.length).toBe(0);
  });

  it('filterShots with a query materialises every not-yet-built month body before filtering', () => {
    renderSidebar();
    expect(countWrappers()).toBe(3);

    filterShots('profile'); // matches every shot's profile name

    expect(countWrappers()).toBe(12);
    for (const key of [KEY_A, KEY_B, KEY_C]) {
      expect(monthBody(key).children.length).toBe(3);
    }
    // every wrapper matches the query, so none is hidden
    const hidden = collect(shotsEl, n => n.classList.contains('shot-wrapper'))
      .filter(w => w.style.display === 'none');
    expect(hidden.length).toBe(0);
  });

  it('clearing the query restores the session collapse state (built rows stay, just hidden)', () => {
    renderSidebar();
    filterShots('profile'); // builds all month bodies
    filterShots('');        // query cleared

    // KEY_A was never in S._expandedMonths, so it collapses again even though
    // its wrappers are now built.
    expect(monthBody(KEY_A).children.length).toBe(3);
    expect(monthBody(KEY_A).style.display).toBe('none');
  });

  it('an active text search does not linearly re-scan S.shots per wrapper', () => {
    renderSidebar();
    filterShots('profile');
    // S.shots.find is gone from the per-wrapper loop; a Getter trap on the
    // array proves .find is not called during filtering.
    const orig = S.shots;
    let findCalls = 0;
    S.shots = new Proxy(orig, {
      get(target, prop, recv) {
        if (prop === 'find') { findCalls++; return target.find.bind(target); }
        return Reflect.get(target, prop, recv);
      },
    });
    filterShots('pro');
    S.shots = orig;
    expect(findCalls).toBe(0);
  });
});
