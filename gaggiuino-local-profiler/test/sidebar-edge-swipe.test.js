// #682: swipe-from-left-edge to open the mobile burger drawer -- the mirror
// gesture to the existing swipe-left-to-close pair (handleDrawerTouchStart/
// End). Bound to `document` rather than #sidebar, since the sidebar is
// transformed off-screen (untouchable) while closed. Fake DOM mirrors
// test/machine-accent-theme.test.js's FakeClassList pattern.
import { describe, it, expect, beforeEach } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };
globalThis.window ??= globalThis;
globalThis.requestAnimationFrame ??= cb => cb();

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(c) { this._set.add(c); }
  remove(c) { this._set.delete(c); }
  contains(c) { return this._set.has(c); }
}
class FakeEl {
  constructor() { this.style = {}; this.classList = new FakeClassList(); }
  setAttribute() {}
}

const { S } = await import('../public-src/state.js');
const { handleEdgeSwipeStart, handleEdgeSwipeEnd } = await import('../public-src/components/sidebar.js');

function touch(x) { return { touches: [{ clientX: x }] }; }
function touchEnd(x) { return { changedTouches: [{ clientX: x }] }; }

describe('edge-swipe-to-open the mobile drawer (#682)', () => {
  let sidebarEl;

  beforeEach(() => {
    sidebarEl = new FakeEl();
    globalThis.document = {
      getElementById: id => (id === 'sidebar' ? sidebarEl : new FakeEl()),
    };
    globalThis.innerWidth = 400; // mobile width
    S.shots = [];
  });

  it('opens the drawer on a swipe starting at the left edge and dragging right past the threshold', () => {
    handleEdgeSwipeStart(touch(10));
    handleEdgeSwipeEnd(touchEnd(90)); // deltaX = 80 > 60
    expect(sidebarEl.classList.contains('sidebar-drawer-mode')).toBe(true);
  });

  it('does not open when the swipe does not start within the edge zone', () => {
    handleEdgeSwipeStart(touch(100)); // well past EDGE_SWIPE_ZONE_PX
    handleEdgeSwipeEnd(touchEnd(200));
    expect(sidebarEl.classList.contains('sidebar-drawer-mode')).toBe(false);
  });

  it('does not open on a short drag that does not clear the threshold', () => {
    handleEdgeSwipeStart(touch(5));
    handleEdgeSwipeEnd(touchEnd(30)); // deltaX = 25 < 60
    expect(sidebarEl.classList.contains('sidebar-drawer-mode')).toBe(false);
  });

  it('ignores the gesture on desktop widths', () => {
    globalThis.innerWidth = 1200;
    handleEdgeSwipeStart(touch(10));
    handleEdgeSwipeEnd(touchEnd(90));
    expect(sidebarEl.classList.contains('sidebar-drawer-mode')).toBe(false);
  });

  it('does not re-trigger while the drawer is already open', () => {
    sidebarEl.classList.add('sidebar-drawer-open');
    handleEdgeSwipeStart(touch(10));
    // _edgeSwipeStartX should never have been armed -- confirmed by the
    // drawer-mode class staying exactly as it already was (already open,
    // nothing new added by this gesture).
    handleEdgeSwipeEnd(touchEnd(90));
    expect(sidebarEl.classList.contains('sidebar-drawer-open')).toBe(true);
  });
});
