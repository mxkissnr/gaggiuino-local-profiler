// Pure flavor-matching logic — no DOM/state imports so it can be unit-tested
// directly under Node (see flavor-wheel.js for the rendering/modal side).
import { FLAVOR_WHEEL, FLAVOR_ALIASES } from './flavor-data.js';
import { SCA_FLAVOR_COLORS } from './sca-flavor-colors.js';

export function normalizeFlavor(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .trim();
}

// A bean's flavor tags could have been entered in any of the 6 UI languages,
// so every node label gets indexed regardless of the wheel's current display
// language — matching must work independently of that.
const LANGS = ['de', 'en', 'it', 'fr', 'es', 'nl'];

let _index = null; // [{ id, norms: string[] }]
let _byId  = null; // id -> node

function buildIndex() {
  if (_index) return;
  _index = [];
  _byId  = new Map();
  const walk = (node) => {
    _byId.set(node.id, node);
    const norms = LANGS.map(l => normalizeFlavor(node[l])).filter(Boolean);
    _index.push({ id: node.id, norms });
    (node.children || []).forEach(walk);
  };
  FLAVOR_WHEEL.forEach(walk);
}

// isBoundaryMatch: `needle` occurs in `haystack` with non-letter chars (or
// string edges) on both sides — avoids "tea" matching inside "steamed".
function boundaryContains(haystack, needle) {
  if (!needle) return false;
  const isLetter = c => /[a-zäöüßàâçéèêëîïôùûü]/i.test(c || '');
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    if (!isLetter(haystack[idx - 1]) && !isLetter(haystack[idx + needle.length])) return true;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return false;
}

// Matches a bean's flavor tags against the wheel: exact label/alias match,
// then word-boundary containment (e.g. "getrocknete Aprikose" → apricot).
// Returns { matched: Set<nodeId>, unmatched: string[] }.
export function matchFlavors(flavors) {
  buildIndex();
  const matched   = new Set();
  const unmatched = [];
  for (const raw of (flavors || [])) {
    const norm = normalizeFlavor(raw);
    if (!norm) continue;

    const exact = _index.find(e => e.norms.includes(norm));
    if (exact) { matched.add(exact.id); continue; }

    const aliasId = FLAVOR_ALIASES[norm];
    if (aliasId && _byId.has(aliasId)) { matched.add(aliasId); continue; }

    const contained = _index.find(e => e.norms.some(n => boundaryContains(norm, n)));
    if (contained) { matched.add(contained.id); continue; }

    unmatched.push(raw);
  }
  return { matched, unmatched };
}

// Marks node._lit = true when the node or any descendant is in `matched`.
export function markLit(node, matched) {
  const childLit = (node.children || []).map(c => markLit(c, matched)).some(Boolean);
  node._lit = matched.has(node.id) || childLit;
  return node._lit;
}

// ── Zoom navigation helpers ──────────────────────────────────────────────
// Pure tree-walking helpers backing the wheel's click-to-zoom + breadcrumb
// navigation (see flavor-wheel.js) — kept here so they stay unit-testable
// under vitest, same reasoning as the color helpers above.

let _parentOf = null; // id -> parent id, or null for a top-level category
function buildParentMap() {
  if (_parentOf) return _parentOf;
  buildIndex(); // ensures FLAVOR_WHEEL is available; _parentOf built from the same tree
  _parentOf = new Map();
  const walk = (node, parent) => {
    _parentOf.set(node.id, parent);
    (node.children || []).forEach(c => walk(c, node.id));
  };
  FLAVOR_WHEEL.forEach(cat => walk(cat, null));
  return _parentOf;
}

export function parentIdOf(nodeId) {
  return buildParentMap().get(nodeId) ?? null;
}

export function nodeById(nodeId) {
  buildIndex();
  return _byId.get(nodeId) || null;
}

// Root-to-node id path (inclusive of nodeId), e.g. ['fruity', 'berry', 'blackberry'].
export function pathToNode(nodeId) {
  const path = [];
  for (let id = nodeId; id != null; id = parentIdOf(id)) path.unshift(id);
  return path;
}

// Finds the deepest node (that still has children of its own — a sunburst
// zoomed into a childless leaf has nothing to draw) which contains every
// matched flavor, so the wheel can open already zoomed into the relevant
// branch instead of the full 9-category overview. `categories` must already
// have `_lit` set (markLit). Returns null when matches span more than one
// top-level category — zooming to any single one would hide the others.
export function findAutoZoomTarget(categories) {
  const litTop = categories.filter(c => c._lit);
  if (litTop.length !== 1) return null;
  let current = litTop[0];
  let target = null;
  while (true) {
    if (current.children?.length) target = current.id;
    const litChildren = (current.children || []).filter(c => c._lit);
    if (litChildren.length !== 1) break;
    current = litChildren[0];
  }
  return target;
}

// ── Sunburst color helpers ───────────────────────────────────────────────
// Pure (no DOM/ECharts dependency), kept here alongside the other
// wheel-adjacent pure logic so they stay unit-testable — flavor-wheel.js
// imports state.js, which touches localStorage at module scope and can't be
// imported under vitest's node test environment.

// Label text was hardcoded white regardless of the segment's own background
// (up to 72% lightness at depth 3 — white-on-light-pastel is low contrast).
// Pick dark text once the background gets light enough for it to read.
export function labelColorFor(depth) {
  const lightness = Math.min(42 + depth * 10, 72);
  return lightness >= 60 ? '#18181b' : '#fff';
}

const NEUTRAL_FALLBACK = '#71717a'; // gray-500, only hit if a node id is somehow missing from SCA_FLAVOR_COLORS

// The real per-node SCA/WCR wheel color for a node's fill (see
// sca-flavor-colors.js) — falls back to a neutral gray for any node id that
// somehow isn't in the map (should not happen; all 111 FLAVOR_WHEEL nodes
// are covered).
export function colorForNode(id) {
  return SCA_FLAVOR_COLORS[id] || NEUTRAL_FALLBACK;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex) || [];
  return { r: parseInt(m[1] || '00', 16), g: parseInt(m[2] || '00', 16), b: parseInt(m[3] || '00', 16) };
}

function rgbToHex(r, g, b) {
  const c = n => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// Blends `hex` toward `bgHex` by `alpha` (0 = fully bg, 1 = fully hex) —
// used to mute unmatched segments toward the modal's dark background while
// still hinting at the node's real hue, instead of the old flat-desaturated
// gray look.
export function muteHex(hex, bgHex, alpha = 0.35) {
  const a = hexToRgb(hex);
  const b = hexToRgb(bgHex);
  return rgbToHex(
    b.r + (a.r - b.r) * alpha,
    b.g + (a.g - b.g) * alpha,
    b.b + (a.b - b.b) * alpha,
  );
}

// Perceived lightness (0-1), simple weighted average — good enough for a
// legibility threshold, not color-accurate work.
function perceivedLightness(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// Depth-3 (outermost ring) labels sit outside their wedge on the modal's
// dark background, colored to match their own node — but some real SCA
// colors (e.g. blackberry, molasses, rubber) are near-black and unreadable
// there. Lighten only the ones that are actually too dark; leave everything
// else at its true color.
export function labelHexFor(hex) {
  if (perceivedLightness(hex) >= 0.35) return hex;
  return muteHex('#ffffff', hex, 0.55); // blend 55% white into the dark color
}
