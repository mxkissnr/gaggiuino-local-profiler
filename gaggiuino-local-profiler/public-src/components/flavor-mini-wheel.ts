// Inline flavour wheel for the bean detail sheet (#1350). Drawn as plain SVG
// instead of an echarts sunburst so opening a sheet never pulls in the ~370 kB
// echarts chunk that the large wheel lazy-loads — a sheet is opened from a tap
// and must stay instant. The angular layout mirrors the sunburst (every leaf
// weighs 1, a parent spans its leaves), so the same bean reads the same way in
// both views.
//
// Pure segment math lives in miniWheelSegments() so it stays unit-testable
// without a DOM; miniWheelSvg()/flavorChipsHtml() only build markup.
import { FLAVOR_WHEEL } from '../flavor-data.js';
import type { FlavorNode } from '../flavor-data.js';
import { matchFlavors, colorForNode, muteHex, pathToNode } from '../flavor-match.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';

export type MiniWheelDepth = 1 | 2 | 3;

export interface MiniWheelSegment {
  id: string;
  depth: MiniWheelDepth;
  a0: number; // degrees clockwise from 12 o'clock
  a1: number;
  color: string;
  lit: boolean;
}

// Inner → outer radius per tree depth. The wheel is drawn in a
// -100..100 viewBox, so the outer edge sits at 98 with a 2 px margin.
const RINGS: Record<MiniWheelDepth, [number, number]> = {
  1: [22, 48],
  2: [48, 74],
  3: [74, 98],
};

// Neutral the unmatched segments are blended toward, so they read as muted on
// both the light and the dark sheet background. muteHex's third argument is
// the colour's weight (1 = full colour), so 0.6 keeps a hint of the real hue.
const MUTE_BG = '#71717a';
const MUTE_WEIGHT = 0.6;

function leafCount(node: FlavorNode): number {
  if (!node.children?.length) return 1;
  return node.children.reduce((sum, child) => sum + leafCount(child), 0);
}

// Ids of a bean's matched flavours plus every ancestor category, as a Set so
// FLAVOR_WHEEL's own nodes are never mutated with _lit flags (markLit would
// leave those behind and leak into the large wheel's next render).
function litIdsFor(flavors: unknown): Set<string> {
  const { matched } = matchFlavors(flavors);
  const lit = new Set<string>();
  for (const id of matched) for (const pathId of pathToNode(id)) lit.add(pathId);
  return lit;
}

export function miniWheelSegments(flavors: unknown): MiniWheelSegment[] {
  const lit = litIdsFor(flavors);
  const segments: MiniWheelSegment[] = [];
  const totalLeaves = FLAVOR_WHEEL.reduce((sum, cat) => sum + leafCount(cat), 0);

  const walk = (node: FlavorNode, depth: MiniWheelDepth, a0: number, a1: number): void => {
    const segment = (d: MiniWheelDepth): void => {
      segments.push({ id: node.id, depth: d, a0, a1, color: colorForNode(node.id), lit: lit.has(node.id) });
    };
    segment(depth);

    const children = node.children;
    if (children?.length && depth < 3) {
      const childLeaves = children.reduce((sum, child) => sum + leafCount(child), 0);
      let cursor = a0;
      for (const child of children) {
        const span = (a1 - a0) * (leafCount(child) / childLeaves);
        walk(child, (depth + 1) as MiniWheelDepth, cursor, cursor + span);
        cursor += span;
      }
      return;
    }
    // A childless node below the outer ring (e.g. "Pipe Tobacco" hanging
    // straight off a top category) has no deeper branch to fill the rings
    // below it. Repeat it down to the outer edge so each ring band stays
    // fully covered, exactly how a single-depth wedge would look.
    if (!children?.length && depth < 3) {
      for (let d: MiniWheelDepth = (depth + 1) as MiniWheelDepth; d <= 3; d = (d + 1) as MiniWheelDepth) {
        segment(d);
      }
    }
  };

  let cursor = 0;
  for (const cat of FLAVOR_WHEEL) {
    const span = 360 * (leafCount(cat) / totalLeaves);
    walk(cat, 1, cursor, cursor + span);
    cursor += span;
  }
  return segments;
}

// Angle 0 is 12 o'clock; positive angles go clockwise. SVG's y axis points
// down, so the 12 o'clock reference is -90°.
function polar(angleDeg: number, radius: number): string {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return `${(radius * Math.cos(rad)).toFixed(2)} ${(radius * Math.sin(rad)).toFixed(2)}`;
}

function sectorPath(a0: number, a1: number, rIn: number, rOut: number): string {
  const large = a1 - a0 > 180 ? 1 : 0;
  return [
    `M ${polar(a0, rOut)}`,
    `A ${rOut} ${rOut} 0 ${large} 1 ${polar(a1, rOut)}`,
    `L ${polar(a1, rIn)}`,
    `A ${rIn} ${rIn} 0 ${large} 0 ${polar(a0, rIn)}`,
    'Z',
  ].join(' ');
}

export function miniWheelSvg(flavors: unknown, sizePx: number): Html {
  const segments = miniWheelSegments(flavors);
  const paths = segments.map(segment => {
    const [rIn, rOut] = RINGS[segment.depth];
    const fill = segment.lit ? segment.color : muteHex(segment.color, MUTE_BG, MUTE_WEIGHT);
    return html`<path class="lib-aroma-seg${esc(segment.lit ? ' is-lit' : '')}" data-node-id="${esc(segment.id)}" d="${esc(sectorPath(segment.a0, segment.a1, rIn, rOut))}" fill="${esc(fill)}"></path>`;
  });
  const size = Math.round(sizePx);
  return html`<svg class="lib-aroma-svg" viewBox="-100 -100 200 200" width="${esc(size)}" height="${esc(size)}" role="img" aria-hidden="true">${joinHtml(paths)}</svg>`;
}

// One chip per bean flavour. A flavour that resolves to a wheel node becomes a
// button that highlights that node's segment; anything unmatched stays a
// muted static chip so nothing is silently dropped.
export function flavorChipsHtml(flavors: unknown): Html {
  const list = (Array.isArray(flavors) ? flavors : []) as string[];
  const chips = list.map(raw => {
    const { matched } = matchFlavors([raw]);
    const nodeId = matched.size ? [...matched][0] : null;
    if (!nodeId) return html`<span class="flavor-chip flavor-chip-static">${esc(raw)}</span>`;
    return html`<button type="button" class="flavor-chip lib-aroma-chip" data-action="highlight-flavor" data-flavor-node="${esc(nodeId)}" style="--chip-color:${esc(colorForNode(nodeId))}">${esc(raw)}</button>`;
  });
  return joinHtml(chips);
}

// ── Sheet highlight state ────────────────────────────────────────────────
// The open sheet re-renders from scratch on almost every action, so the
// highlighted node is kept here (module state, same pattern as the sheet's
// "more" menu open flag) and re-applied to the fresh SVG after a rebuild.
let _sheetHlNode: string | null = null;

export function currentSheetFlavorHighlight(): string | null {
  return _sheetHlNode;
}

export function resetSheetFlavorHighlight(): void {
  _sheetHlNode = null;
}

export function applySheetFlavorHighlight(root: ParentNode | null): void {
  const el = root as Element | null;
  if (!el || typeof el.querySelector !== 'function') return;
  const svg = el.querySelector('.lib-aroma-svg');
  if (!svg || typeof svg.querySelectorAll !== 'function') return;
  const litPath = _sheetHlNode ? new Set(pathToNode(_sheetHlNode)) : null;
  svg.querySelectorAll<Element>('.lib-aroma-seg').forEach(path => {
    const id = path.getAttribute?.('data-node-id') || '';
    path.classList?.toggle?.('is-hl', !!litPath && litPath.has(id));
  });
  svg.classList?.toggle?.('has-hl', !!litPath);
}

// Toggles the highlight for a chip: tapping the active chip clears it, tapping
// another moves it. `chipEl` locates the sheet (`.lib-sheet`) holding the SVG.
export function highlightSheetFlavor(nodeId: string | null, chipEl?: Element | null): void {
  _sheetHlNode = nodeId && _sheetHlNode !== nodeId ? nodeId : null;
  const root = chipEl && typeof chipEl.closest === 'function' ? chipEl.closest('.lib-sheet') : null;
  applySheetFlavorHighlight(root as ParentNode | null);
}
