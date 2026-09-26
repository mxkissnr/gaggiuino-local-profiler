// Pure flavor-matching logic — no DOM/state imports so it can be unit-tested
// directly under Node (see flavor-wheel.js for the rendering/modal side).
import { FLAVOR_WHEEL, FLAVOR_ALIASES } from './flavor-data.js';
import type { FlavorNode } from './flavor-data.js';
import { SCA_FLAVOR_COLORS } from './sca-flavor-colors.js';

export function normalizeFlavor(s: unknown): string {
  const value: string = (s || '') as string;
  return String(value)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .trim();
}

// A bean's flavor tags could have been entered in any of the 6 UI languages,
// so every node label gets indexed regardless of the wheel's current display
// language — matching must work independently of that.
const LANGS = ['de', 'en', 'it', 'fr', 'es', 'nl'];

interface IndexEntry {
  id: string;
  norms: string[];
}

let _index: IndexEntry[] | null = null; // [{ id, norms: string[] }]
let _byId: Map<string, FlavorNode> | null = null; // id -> node

function buildIndex(): void {
  if (_index) return;
  const index: IndexEntry[] = [];
  const byId = new Map<string, FlavorNode>();
  const walk = (node: FlavorNode): void => {
    byId.set(node.id, node);
    const norms = LANGS.map(l => normalizeFlavor(node[l as keyof FlavorNode])).filter(Boolean);
    index.push({ id: node.id, norms });
    (node.children || []).forEach(walk);
  };
  FLAVOR_WHEEL.forEach(walk);
  _index = index;
  _byId = byId;
}

// isBoundaryMatch: `needle` occurs in `haystack` with non-letter chars (or
// string edges) on both sides — avoids "tea" matching inside "steamed".
function boundaryContains(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const isLetter = (c: string | undefined): boolean => /[a-zäöüßàâçéèêëîïôùûü]/i.test(c || '');
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
export function matchFlavors(flavors: unknown): { matched: Set<string>; unmatched: string[] } {
  buildIndex();
  const matched   = new Set<string>();
  const unmatched: string[] = [];
  for (const raw of ((flavors || []) as string[])) {
    const norm = normalizeFlavor(raw);
    if (!norm) continue;

    const exact = _index!.find(e => e.norms.includes(norm));
    if (exact) { matched.add(exact.id); continue; }

    const aliasId = FLAVOR_ALIASES[norm];
    if (aliasId && _byId!.has(aliasId)) { matched.add(aliasId); continue; }

    const contained = _index!.find(e => e.norms.some(n => boundaryContains(norm, n)));
    if (contained) { matched.add(contained.id); continue; }

    unmatched.push(raw);
  }
  return { matched, unmatched };
}

// Marks node._lit = true when the node or any descendant is in `matched`.
export function markLit(node: FlavorNode, matched: Set<string>): boolean {
  const childLit = (node.children || []).map(c => markLit(c, matched)).some(Boolean);
  node._lit = matched.has(node.id) || childLit;
  return node._lit;
}

// ── Zoom navigation helpers ──────────────────────────────────────────────
// Pure tree-walking helpers backing the wheel's click-to-zoom + breadcrumb
// navigation (see flavor-wheel.js) — kept here so they stay unit-testable
// under vitest, same reasoning as the color helpers above.

let _parentOf: Map<string, string | null> | null = null; // id -> parent id, or null for a top-level category
function buildParentMap(): Map<string, string | null> {
  if (_parentOf) return _parentOf;
  buildIndex(); // ensures FLAVOR_WHEEL is available; _parentOf built from the same tree
  const parentOf = new Map<string, string | null>();
  const walk = (node: FlavorNode, parent: string | null): void => {
    parentOf.set(node.id, parent);
    (node.children || []).forEach(c => walk(c, node.id));
  };
  FLAVOR_WHEEL.forEach(cat => walk(cat, null));
  _parentOf = parentOf;
  return _parentOf;
}

export function parentIdOf(nodeId: string): string | null {
  return buildParentMap().get(nodeId) ?? null;
}

export function nodeById(nodeId: string): FlavorNode | null {
  buildIndex();
  return _byId!.get(nodeId) || null;
}

// Root-to-node id path (inclusive of nodeId), e.g. ['fruity', 'berry', 'blackberry'].
export function pathToNode(nodeId: string): string[] {
  const path: string[] = [];
  for (let id: string | null = nodeId; id != null; id = parentIdOf(id)) path.unshift(id);
  return path;
}

// Finds the deepest node (that still has children of its own — a sunburst
// zoomed into a childless leaf has nothing to draw) which contains every
// matched flavor, so the wheel can open already zoomed into the relevant
// branch instead of the full 9-category overview. `categories` must already
// have `_lit` set (markLit). Returns null when matches span more than one
// top-level category — zooming to any single one would hide the others.
export function findAutoZoomTarget(categories: FlavorNode[]): string | null {
  const litTop = categories.filter(c => c._lit);
  if (litTop.length !== 1) return null;
  let current = litTop[0];
  let target: string | null = null;
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
// imports state/index.ts, which touches localStorage at module scope and can't be
// imported under vitest's node test environment.

const NEUTRAL_FALLBACK = '#71717a'; // gray-500, only hit if a node id is somehow missing from SCA_FLAVOR_COLORS

// The real per-node SCA/WCR wheel color for a node's fill (see
// sca-flavor-colors.js) — falls back to a neutral gray for any node id that
// somehow isn't in the map (should not happen; all 111 FLAVOR_WHEEL nodes
// are covered).
export function colorForNode(id: string): string {
  return SCA_FLAVOR_COLORS[id] || NEUTRAL_FALLBACK;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex) || [];
  return { r: parseInt(m[1] || '00', 16), g: parseInt(m[2] || '00', 16), b: parseInt(m[3] || '00', 16) };
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number): string => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// Blends `hex` toward `bgHex` by `alpha` (0 = fully bg, 1 = fully hex) —
// used to mute unmatched segments toward the modal's dark background while
// still hinting at the node's real hue, instead of the old flat-desaturated
// gray look.
export function muteHex(hex: string, bgHex: string, alpha = 0.35): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(bgHex);
  return rgbToHex(
    b.r + (a.r - b.r) * alpha,
    b.g + (a.g - b.g) * alpha,
    b.b + (a.b - b.b) * alpha,
  );
}

// Contrast-safe label color for text sitting directly on `hex` — YIQ luma
// threshold (standard formula, simpler than full WCAG relative luminance,
// same practical result at the extremes that matter here). Use this instead
// of a fixed text color for any label/text drawn on a data-driven background.
export function contrastTextColor(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? '#000000' : '#ffffff';
}
