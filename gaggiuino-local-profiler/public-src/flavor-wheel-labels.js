// Pure collision-avoidance layout for the flavor wheel's leader-line labels
// (depth 2/3 — see flavor-wheel.js) — kept separate from rendering/DOM code
// so it's directly unit-testable under vitest, same reasoning as
// flavor-match.js. Works for any combination of active (lit) flavors, not
// just specific known-colliding pairs: labels are split into a left/right
// hemisphere by their wedge's mid-angle, then relaxed vertically within
// each hemisphere until no two labels in that column are closer than
// `minGap` px apart.
//
// Input items: { id, angle, labelY? } — `angle` is the wedge's mid-angle in
// radians (standard math/canvas convention: 0 = 3 o'clock, increasing =
// clockwise on screen, matching ECharts' sunburst node layout). `labelY` is
// the initial vertical target for the label (typically
// `Math.sin(angle) * targetRadius`, computed by the caller against a single
// shared target radius so labels from different rings land in the same
// column); if omitted it falls back to `Math.sin(angle) * (item.r ?? 0)`.
//
// Output: each input item plus `side` ('left' | 'right') and the final,
// non-overlapping `y`. All other input fields are preserved untouched.

const DEFAULT_MIN_GAP = 20;

// Sorted-group collision resolution: a forward pass pushes each label down
// until it clears the one above it, then a backward pass pushes each label
// up until it clears the one below — two linear passes are enough to
// guarantee `minGap` everywhere (no matter how many labels start at the
// same y, unlike a fixed-iteration pairwise relaxation) while keeping the
// group roughly centered on its original spread.
function resolveGroup(group, minGap) {
  for (let i = 1; i < group.length; i++) {
    if (group[i].y < group[i - 1].y + minGap) group[i].y = group[i - 1].y + minGap;
  }
  for (let i = group.length - 2; i >= 0; i--) {
    if (group[i].y > group[i + 1].y - minGap) group[i].y = group[i + 1].y - minGap;
  }
}

export function layoutLeaderLabels(items, opts = {}) {
  const minGap = opts.minGap ?? DEFAULT_MIN_GAP;

  const placed = (items || []).map(item => ({
    ...item,
    side: Math.cos(item.angle) >= 0 ? 'right' : 'left',
    y: item.labelY ?? Math.sin(item.angle) * (item.r ?? 0),
  }));

  for (const side of ['left', 'right']) {
    const group = placed.filter(it => it.side === side).sort((a, b) => a.y - b.y);
    resolveGroup(group, minGap);
  }

  return placed;
}
