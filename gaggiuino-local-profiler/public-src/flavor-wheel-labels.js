// Pure collision-avoidance layout for the flavor wheel's leader-line labels
// (depth 2/3 — see flavor-wheel.js) — kept separate from rendering/DOM code
// so it's directly unit-testable under vitest, same reasoning as
// flavor-match.js. Works for any combination of active (lit) flavors, not
// just specific known-colliding pairs.
//
// Labels are kept near their wedge's original angle around the circle
// (rather than collapsed into a fixed left/right hemisphere column): each
// label claims an angular half-width at a shared target radius, and on
// collision the two neighbors are pushed apart circularly (with wraparound
// at ±π) until every adjacent pair clears. This spreads labels evenly
// around whatever arc they actually cluster in, instead of stacking
// everything into one side when a bean's lit flavors happen to share a
// quadrant.
//
// Input items: { id, angle, halfW? } — `angle` is the wedge's mid-angle in
// radians (standard math/canvas convention: 0 = 3 o'clock, increasing =
// clockwise on screen, matching ECharts' sunburst node layout). `halfW` is
// the label's angular half-width in radians at the shared target radius
// (typically `(textWidthPx / 2 + paddingPx) / targetRadius`, computed by
// the caller since it needs a canvas text measurement); defaults to 0 (a
// point label) if omitted.
//
// Output: each input item with `angle` overwritten by the final,
// collision-free angle (normalized to (-π, π]). All other input fields are
// preserved untouched.

const DEFAULT_MAX_PASSES = 40;

function normAngle(a) {
  while (a < -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}

export function layoutLeaderLabels(items, opts = {}) {
  const maxPasses = opts.maxPasses ?? DEFAULT_MAX_PASSES;

  const arr = (items || []).map(item => ({
    ...item,
    angle: normAngle(item.angle),
    halfW: item.halfW ?? 0,
  }));
  arr.sort((a, b) => a.angle - b.angle);

  const n = arr.length;
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const cur = arr[i];
      const next = arr[(i + 1) % n];
      let gap = next.angle - cur.angle;
      if (i === n - 1) gap += Math.PI * 2; // wraparound back to the first label
      const needed = cur.halfW + next.halfW;
      if (gap < needed) {
        const push = (needed - gap) / 2;
        cur.angle -= push;
        next.angle += push;
        moved = true;
      }
    }
    if (!moved) break;
  }

  return arr;
}
