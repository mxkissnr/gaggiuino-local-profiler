// #682: swipe-from-left-edge to open the mobile burger drawer -- the mirror
// gesture to the existing swipe-left-to-close pair (handleDrawerTouchStart/
// End). Bound to `document` rather than #sidebar, since the sidebar is
// transformed off-screen (untouchable) while closed. Fake DOM mirrors
// test/machine-accent-theme.test.js's FakeClassList pattern.
import { describe, it, expect, beforeEach } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge test/machine-accent-theme.test.ts uses)
// so the minimal fakes below need not satisfy the full Storage/Navigator/
// Window shapes.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;
// sidebar.js only schedules a frame to add the drawer-mode class; run it
// straight away so the class lands synchronously (the return value is unused).
g.requestAnimationFrame ??= (cb: FrameRequestCallback) => { cb(0); };

class FakeClassList {
  _set: Set<string> = new Set();
  add(c: string): void { this._set.add(c); }
  remove(c: string): void { this._set.delete(c); }
  contains(c: string): boolean { return this._set.has(c); }
}
class FakeEl {
  style: Record<string, string> = {};
  classList: FakeClassList = new FakeClassList();
  setAttribute(): void {}
}

const { S } = await import('../public-src/state/index.js');
const { handleEdgeSwipeStart, handleEdgeSwipeEnd } = await import('../public-src/components/sidebar.js');

function touch(x: number): TouchEvent { return { touches: [{ clientX: x }] } as unknown as TouchEvent; }
function touchEnd(x: number): TouchEvent { return { changedTouches: [{ clientX: x }] } as unknown as TouchEvent; }

describe('edge-swipe-to-open the mobile drawer (#682)', () => {
  let sidebarEl: FakeEl;

  beforeEach(() => {
    sidebarEl = new FakeEl();
    g.document = {
      getElementById: (id: string) => (id === 'sidebar' ? sidebarEl : new FakeEl()),
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
