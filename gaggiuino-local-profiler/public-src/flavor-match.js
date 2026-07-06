// Pure flavor-matching logic — no DOM/state imports so it can be unit-tested
// directly under Node (see flavor-wheel.js for the rendering/modal side).
import { FLAVOR_WHEEL, FLAVOR_ALIASES } from './flavor-data.js';

export function normalizeFlavor(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .trim();
}

let _index = null; // [{ id, deNorm, enNorm }]
let _byId  = null; // id -> node

function buildIndex() {
  if (_index) return;
  _index = [];
  _byId  = new Map();
  const walk = (node) => {
    _byId.set(node.id, node);
    _index.push({ id: node.id, deNorm: normalizeFlavor(node.de), enNorm: normalizeFlavor(node.en) });
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

    const exact = _index.find(e => e.deNorm === norm || e.enNorm === norm);
    if (exact) { matched.add(exact.id); continue; }

    const aliasId = FLAVOR_ALIASES[norm];
    if (aliasId && _byId.has(aliasId)) { matched.add(aliasId); continue; }

    const contained = _index.find(e =>
      (e.deNorm && boundaryContains(norm, e.deNorm)) ||
      (e.enNorm && boundaryContains(norm, e.enNorm)));
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
