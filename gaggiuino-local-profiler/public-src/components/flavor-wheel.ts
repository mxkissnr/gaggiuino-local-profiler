import { FLAVOR_WHEEL } from '../flavor-data.js';
import type { FlavorNode } from '../flavor-data.js';
import { matchFlavors, markLit, colorForNode, parentIdOf, nodeById, pathToNode, muteHex } from '../flavor-match.js';
import { S } from '../state/index.js';
import { t, tHtml } from '../i18n.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { loadBeanImageBlobUrl } from '../bean-image.js';

export { matchFlavors, normalizeFlavor } from '../flavor-match.js';

type FlavorLang = 'en' | 'de' | 'it' | 'fr' | 'es' | 'nl';

interface SunburstEntry {
  id: string;
  name: string;
  value?: number;
  children?: SunburstEntry[];
  itemStyle: {
    color: string;
    borderColor: string;
    borderWidth: number;
    shadowBlur?: number;
    shadowColor?: string;
  };
  label: {
    show: boolean | undefined;
    color: string;
    textBorderColor: string;
    textBorderWidth: number;
    fontSize: number;
    fontWeight: string;
  };
}

// ── Sunburst rendering ──────────────────────────────────────────────────────

const WHEEL_ROOT_ID = '__flavor_wheel_root__'; // virtual root name (see SunburstSeries: {name, children: data})

// Modal background the muted/unmatched fills blend toward — read once per
// render from the actual modal box so it tracks the active dark/light theme
// instead of a hardcoded guess.
function _rgbChannels(m: RegExpExecArray | null): [string, string, string] | null {
  if (!m) return null;
  const [, r, g, b] = m;
  return r !== undefined && g !== undefined && b !== undefined ? [r, g, b] : null;
}

function rgbStringToHex(rgbStr: string | null | undefined, fallback: string): string {
  const ch = _rgbChannels(/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgbStr || ''));
  if (!ch) return fallback;
  const hex = (n: string): string => Number(n).toString(16).padStart(2, '0');
  return `#${hex(ch[0])}${hex(ch[1])}${hex(ch[2])}`;
}

function resolveModalBgHex(container: Element | null | undefined): string {
  const modalBox = container?.closest?.('.flavor-wheel-modal');
  const bg = modalBox ? getComputedStyle(modalBox).backgroundColor : null;
  return rgbStringToHex(bg, '#18181b');
}

function toSunburstData(node: FlavorNode, depth: number, lang: FlavorLang, bgHex: string): SunburstEntry {
  const label = node[lang] || node.en;
  const lit   = node._lit;
  const realColor = colorForNode(node.id);
  // Only the bean's own matched flavors (plus their ancestor categories,
  // via markLit) render at full poster saturation — everything else is
  // muted toward the modal background so the handful of segments that
  // actually matter for this bean stand out, instead of competing for
  // attention with ~100 unrelated ones.
  // flavor-match's muteHex takes the colour's weight (1 = full colour), so
  // 0.65 blends 35 % toward the background — the same calm as before.
  const fillColor = lit ? realColor : muteHex(realColor, bgHex, 0.65);
  // #1350: the 9 top categories always carry their label so the overview is
  // readable on its own; the outer two rings only label the bean's own
  // flavours (depth 2/3 use ECharts' native `rotate:'radial'`, see `levels`).
  const labelCfg = {
    show: depth === 1 || lit,
    color: '#fff',
    textBorderColor: 'rgba(0,0,0,.65)',
    textBorderWidth: 2,
    fontSize: (depth === 1 ? 11 : depth === 3 ? 9 : 10) + 1,
    fontWeight: 'bold',
  };
  const itemStyle: SunburstEntry['itemStyle'] = { color: fillColor, borderColor: lit ? '#fff' : '#111113', borderWidth: lit ? 3 : 1 };
  if (lit) { itemStyle.shadowBlur = 12; itemStyle.shadowColor = realColor; }
  const entry: SunburstEntry = {
    id: node.id,
    name: label,
    itemStyle,
    label: labelCfg,
  };
  if (node.children?.length) {
    entry.children = node.children.map(c => toSunburstData(c, depth + 1, lang, bgHex));
  } else {
    entry.value = 1;
  }
  return entry;
}

interface FlavorChartClickParams {
  data?: { id?: string; name?: string };
}

// Minimal structural view of the echarts instance this module drives; the
// dynamic import's own richer type is only needed to call init() (see
// renderFlavorWheel).
interface FlavorChart {
  dispose(): void;
  setOption(option: Record<string, unknown>): void;
  dispatchAction(action: Record<string, unknown>): void;
  off(event: string): void;
  on(event: string, handler: (params: FlavorChartClickParams) => void): void;
}

let _chart: FlavorChart | null = null;
let _rootId: string | null = null; // currently zoomed-to node id, or null for the full overview
let _lang: FlavorLang = 'en';
let _breadcrumbEl: HTMLElement | null = null;
let _hlNode: string | null = null; // node highlighted from the legend, or null

// #797: echarts (~370 kB gzip) only ships once a wheel is actually opened.
// _echartsPromise caches the in-flight import so re-opening while it's
// still loading reuses the same request; _renderReqToken mirrors the
// analytics.js world-map guard (#648) — it invalidates a still-pending
// renderFlavorWheel() call once a newer open (or a close) has taken over,
// so a late-arriving chunk never calls echarts.init() on a stale container.
let _echartsPromise: Promise<typeof import('echarts')> | null = null;
let _renderReqToken = 0;
// #1374: the exact small wheel the open transition grew from. The close only
// runs the reverse transition while that same element is still in the sheet,
// so a sheet re-render (which replaces the node) falls back to a direct close
// instead of naming a detached element.
let _wheelGrowFromEl: HTMLElement | null = null;

// #1350: a short, calm entry animation — skipped entirely when the user has
// asked for reduced motion.
function wheelMotionOk(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    || !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function renderBreadcrumb(): void {
  if (!_breadcrumbEl) return;
  const ids = _rootId ? pathToNode(_rootId) : [];
  const crumbs: Html[] = [html`<button type="button" class="fw-crumb" data-action="zoom-flavor-wheel" data-zoom-id="">${esc(t('flavor_wheel_overview'))}</button>`];
  for (const id of ids) {
    const node = nodeById(id);
    if (!node) continue;
    const label = node[_lang] || node.en;
    crumbs.push(html`<span class="fw-crumb-sep">›</span><button type="button" class="fw-crumb" data-action="zoom-flavor-wheel" data-zoom-id="${esc(id)}">${esc(label)}</button>`);
  }
  _breadcrumbEl.innerHTML = joinHtml(crumbs);
}

function zoomTo(id: string | null): void {
  _rootId = id;
  _chart?.dispatchAction({ type: 'sunburstRootToNode', targetNode: id || WHEEL_ROOT_ID });
  renderBreadcrumb();
}

// Called from the global data-action click delegate (main.js) when a
// breadcrumb crumb is clicked; `id` is '' for the overview crumb.
export function zoomFlavorWheelTo(id: string | null | undefined): void {
  if (!_chart) return;
  zoomTo(id || null);
}

// Legend rows call this (and re-tapping the active row clears it): highlight
// the matching wedge, or downplay everything when `nodeId` is null.
export function highlightFlavorWheelNode(nodeId: string | null | undefined): void {
  if (!_chart) return;
  const next = nodeId && _hlNode !== nodeId ? nodeId : null;
  _hlNode = next;
  _chart.dispatchAction({ type: 'downplay', seriesIndex: 0 });
  if (!next) return;
  const node = nodeById(next);
  if (!node) return;
  // ECharts' generic highlight action targets a data item by name; the label
  // is what the sunburst entry carries (see toSunburstData).
  _chart.dispatchAction({ type: 'highlight', seriesIndex: 0, name: node[_lang] || node.en });
}

export async function renderFlavorWheel(container: HTMLElement, flavors: unknown, lang: FlavorLang, breadcrumbEl: HTMLElement | null): Promise<boolean> {
  const { matched } = matchFlavors(flavors);
  FLAVOR_WHEEL.forEach(cat => markLit(cat, matched));
  const bgHex = resolveModalBgHex(container);
  const data = FLAVOR_WHEEL.map(cat => toSunburstData(cat, 1, lang, bgHex));

  _lang = lang;
  _breadcrumbEl = breadcrumbEl || null;
  _hlNode = null;
  if (_chart) { _chart.dispose(); _chart = null; }

  const token = ++_renderReqToken;
  let echarts: typeof import('echarts');
  try {
    if (!_echartsPromise) _echartsPromise = import('echarts');
    echarts = await _echartsPromise;
  } catch {
    _echartsPromise = null; // don't cache a rejected promise — allow a retry on the next open
    return false;
  }
  // A newer render (reopen with a different bean) or a close raced ahead of
  // this chunk load — do nothing rather than init a chart into a container
  // that no longer belongs to this call.
  if (token !== _renderReqToken) return true;

  container.innerHTML = html``; // clear the loading message before echarts takes over this node
  _chart = echarts.init(container) as unknown as FlavorChart;
  _chart.setOption({
    backgroundColor: 'transparent',
    animation: wheelMotionOk(),
    animationDuration: 400,
    animationEasing: 'cubicOut',
    tooltip: { formatter: (params: { name?: string }) => (params.name === WHEEL_ROOT_ID ? '' : esc(params.name)) },
    series: [{
      type: 'sunburst', name: WHEEL_ROOT_ID, radius: ['22%', '92%'], center: ['50%', '50%'],
      data, sort: null,
      // Zoom is driven entirely by our own click handler below (so the
      // breadcrumb always matches what's on screen, including zoom-out).
      nodeClick: false,
      emphasis: { focus: 'ancestor' },
      itemStyle: { borderColor: '#111113', borderWidth: 1.5 },
      // The top categories always carry a label and the outer rings only the
      // bean's flavours (see toSunburstData), so there's no high-density
      // field to protect against — hideOverlap still guards the rare case
      // where two neighbouring labels collide.
      label: { hideOverlap: true },
      levels: [
        // depth 0 is echarts' own synthetic wrapper node (created internally
        // from `series.name` + our 9-category array) — it has no data of its
        // own, so it gets no itemStyle/label from toSunburstData and falls
        // back to echarts' theme defaults (a visible blue fill + its raw
        // name as a label). Invisible by default (tiny sliver at 0-22%
        // radius) but once zoomed in it's redistributed into a big, very
        // visible ring unless explicitly zeroed out here — same for the
        // emphasis state, since clicking triggers focus:'ancestor' up to it.
        { label: { show: false }, itemStyle: { color: 'transparent' }, emphasis: { label: { show: false }, itemStyle: { color: 'transparent' } } },
        // Depth 1 (the 9 top categories) keeps its label horizontal
        // regardless of wedge position — ECharts' sunburst defaults to
        // `rotate:'radial'` for every level unless overridden, which turns
        // near-vertical for wedges away from 12/6 o'clock and makes longer
        // names (e.g. "Nussig / Kakao") unreadable. `overflow:'break'` with
        // a fixed `width` wraps those long names onto a second line instead
        // of clipping or squeezing them.
        { r0: '22%', r: '38%', label: { rotate: 0, overflow: 'break', width: 64 } },
        // Radial (spoke-pointing) labels on the outer two rings, matching
        // the real SCA/WCR wheel's signature look — you tilt the wheel to
        // read the far side, same as the paper original. `minAngle` keeps a
        // label out of a wedge too thin to hold it, and `truncate` (rather
        // than depth 1's `break`) stops a long descriptor from spilling past
        // its own wedge and reading as glued onto the next one.
        { r0: '38%', r: '68%', label: { rotate: 'radial', minAngle: 8, overflow: 'truncate', ellipsis: '…' } },
        { r0: '68%', r: '92%', label: { rotate: 'radial', minAngle: 8, overflow: 'truncate', ellipsis: '…' } },
      ],
    }],
  });

  _chart.off('click');
  _chart.on('click', (params: FlavorChartClickParams) => {
    const clickedId = params?.data?.id;
    if (!clickedId) {
      // The wrapper ring (see WHEEL_ROOT_ID above) has no `id` — clicking it
      // is the one interaction echarts still drives itself even with
      // nodeClick:false (clicking an already-visible ancestor ring jumps the
      // view straight to it), so mirror that reset into our own state or
      // the breadcrumb would silently drift out of sync with the chart.
      if (params?.data?.name === WHEEL_ROOT_ID) zoomTo(null);
      return;
    }
    // Clicking the wedge that's currently the zoomed-in root steps back up
    // to its parent (or to the full overview); clicking anything else with
    // children drills into it. This mirrors the sunburst's native
    // click-to-zoom, but tracked ourselves so the breadcrumb never drifts
    // out of sync. Childless leaves (e.g. a single flavor like "Cherry")
    // are a no-op — zooming a sunburst into an empty leaf has nothing to draw.
    if (clickedId === _rootId) { zoomTo(parentIdOf(clickedId)); return; }
    if (nodeById(clickedId)?.children?.length) zoomTo(clickedId);
  });

  // #1350: always open on the full overview. Auto-zooming into the single top
  // category a bean's flavours happened to share hid every other category.
  _rootId = null;
  renderBreadcrumb();

  return true;
}

export function disposeFlavorWheel(): void {
  ++_renderReqToken; // invalidate a still-pending renderFlavorWheel() chunk load, if any
  if (_chart) { _chart.dispose(); _chart = null; }
  _rootId = null;
  _breadcrumbEl = null;
  _hlNode = null;
  _wheelGrowFromEl = null;
}

// ── Modal wiring ─────────────────────────────────────────────────────────

// One legend row per matched flavour: its label and ancestor path in the
// current language, a dot in the segment colour, and a button that highlights
// that wedge (re-tapping the active row clears it).
function renderLegend(flavors: unknown, lang: FlavorLang): Html {
  const list = (Array.isArray(flavors) ? flavors : []) as string[];
  const rows: Html[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const { matched } = matchFlavors([raw]);
    const id = matched.size ? [...matched][0] : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const labels = pathToNode(id).map(pid => {
      const node = nodeById(pid);
      return node ? (node[lang] || node.en) : pid;
    });
    const leaf = labels[labels.length - 1] ?? '';
    const ancestors = labels.slice(0, -1);
    const text = ancestors.length ? `${leaf} · ${ancestors.join(' › ')}` : leaf;
    rows.push(html`<button type="button" class="fw-legend-row" data-action="highlight-flavor-wheel" data-node-id="${esc(id)}"><span class="fw-legend-dot" style="background:${esc(colorForNode(id))}"></span><span class="fw-legend-text">${esc(text)}</span></button>`);
  }
  return joinHtml(rows);
}

// ── Shared-element growth (#1374) ─────────────────────────────────────────

interface WheelViewTransition {
  updateCallbackDone?: Promise<void>;
  finished?: Promise<void>;
}

// The wheel grows out of the small wheel only when View Transitions are
// available, the user has not asked for reduced motion, and there is a small
// wheel to grow from. Otherwise it opens and closes directly.
export function shouldGrowWheelFrom(hasViewTransition: boolean, motionOk: boolean, fromSmallWheel: boolean): boolean {
  return hasViewTransition && motionOk && fromSmallWheel;
}

function startWheelViewTransition(cb: () => void): WheelViewTransition | null {
  if (typeof document === 'undefined') return null;
  const doc = document as unknown as { startViewTransition?: (cb: () => void) => WheelViewTransition };
  return typeof doc.startViewTransition === 'function' ? doc.startViewTransition(cb) : null;
}

function setWheelTransitionName(el: HTMLElement | null, on: boolean): void {
  if (!el) return;
  if (on) el.style.setProperty('view-transition-name', 'flavor-wheel');
  else el.style.removeProperty('view-transition-name');
}

export async function openFlavorWheel(beanId: unknown): Promise<void> {
  const bean = S.coffeeLibrary?.beans?.find(b => b.id === beanId);
  if (!bean) return;
  const modal = document.getElementById('flavorWheelModal');
  if (!modal) return;
  // #1374: on a narrow phone #main is position:fixed (max-width:768px) and so
  // becomes a stacking context, which trapped the overlay's own z-index inside
  // it; the body-level bean sheet (z-index 901) therefore always painted above
  // the wheel. One move to <body> puts the wheel back into the page's stacking
  // context. The click delegation (document.body) and the backdrop handler
  // follow the element.
  if (document.body && modal.parentElement !== document.body) document.body.appendChild(modal);

  (document.getElementById('flavorWheelTitle') as HTMLElement).textContent = bean.name as string;
  // #1350: the bean's photo now sits in the wheel's centre (tapping it zooms
  // back to the overview), so the small header image stays hidden.
  const imgEl = document.getElementById('flavorWheelImage') as HTMLImageElement | null;
  if (imgEl) imgEl.style.display = 'none';
  const centerBtn = document.getElementById('flavorWheelCenter');
  const centerImg = document.getElementById('flavorWheelCenterImg') as HTMLImageElement | null;
  if (centerBtn) {
    centerBtn.style.display = 'none';
    centerBtn.setAttribute('aria-label', t('flavor_wheel_center_hint'));
  }
  if (centerBtn && centerImg && bean.image) {
    void loadBeanImageBlobUrl(bean.id).then(url => { if (url) { centerImg.src = url; centerBtn.style.display = ''; } });
  }

  const lang: FlavorLang = (['de', 'en', 'it', 'fr', 'es', 'nl'] as FlavorLang[]).includes(S.currentLang as FlavorLang) ? S.currentLang as FlavorLang : 'en';

  const { unmatched } = matchFlavors(bean.flavors);
  const unmatchedWrap = document.getElementById('flavorWheelUnmatched') as HTMLElement;
  unmatchedWrap.innerHTML = unmatched.length
    ? html`<div class="fw-unmatched-label">${tHtml('flavor_wheel_unmatched')}</div>
       <div class="fw-unmatched-chips">${joinHtml(unmatched.map(f => html`<span class="flavor-chip flavor-chip-static">${esc(f)}</span>`))}</div>`
    : html``;

  const legendEl = document.getElementById('flavorWheelLegend');
  if (legendEl) legendEl.innerHTML = renderLegend(bean.flavors, lang);

  const container = document.getElementById('flavorWheelCanvas') as HTMLElement;
  const breadcrumbEl = document.getElementById('flavorWheelBreadcrumb');
  // echarts is a dynamic import now (#797) — show a loading state while its
  // chunk downloads instead of leaving the canvas blank.
  container.innerHTML = html`<p class="empty-note" style="text-align:center">${tHtml('flavor_wheel_loading')}</p>`;
  if (breadcrumbEl) breadcrumbEl.innerHTML = html``;

  const canvasWrap = modal.querySelector<HTMLElement>('.fw-canvas-wrap');
  const smallWheel = document.querySelector<HTMLElement>('#beanSheet .lib-aroma-wheel');
  const hasViewTransition = typeof (document as unknown as { startViewTransition?: unknown }).startViewTransition === 'function';
  const grow = shouldGrowWheelFrom(hasViewTransition, wheelMotionOk(), !!smallWheel && !!canvasWrap);
  // Remember the exact node the growth snapshots so the close can tell a
  // re-rendered sheet (new node) from the original.
  _wheelGrowFromEl = grow ? smallWheel : null;

  const showModal = (): void => {
    setWheelTransitionName(smallWheel, false);
    setWheelTransitionName(canvasWrap, true);
    modal.style.display = 'flex';
  };

  if (grow) {
    // Grow out of the small wheel: the old snapshot is the sheet's wheel, the
    // new one the full-screen modal.
    setWheelTransitionName(canvasWrap, false); // a previous close may have left the name on the modal
    setWheelTransitionName(smallWheel, true);
    const transition = startWheelViewTransition(showModal);
    if (transition) {
      // Render only after the DOM update has been snapshotted, so the echarts
      // chunk download never blocks the growth.
      if (transition.updateCallbackDone) await transition.updateCallbackDone;
      else showModal();
    } else {
      showModal();
    }
  } else {
    showModal();
  }

  if (!await renderFlavorWheel(container, bean.flavors, lang, breadcrumbEl)) {
    container.innerHTML = html`<p class="empty-note" style="text-align:center">${tHtml('flavor_wheel_unavailable')}</p>`;
    if (breadcrumbEl) breadcrumbEl.innerHTML = html``;
  }
}

export function closeFlavorWheel(): void {
  const modal = document.getElementById('flavorWheelModal');
  if (!modal) { disposeFlavorWheel(); return; }
  const canvasWrap = modal.querySelector<HTMLElement>('.fw-canvas-wrap');
  const smallWheel = document.querySelector<HTMLElement>('#beanSheet .lib-aroma-wheel');
  const hasViewTransition = typeof (document as unknown as { startViewTransition?: unknown }).startViewTransition === 'function';
  // Only run the reverse transition from the very element the open
  // snapshotted; if the sheet was re-rendered that node is gone, so fall back
  // to a direct close instead of naming a detached/different element.
  const fromEl = _wheelGrowFromEl;
  _wheelGrowFromEl = null;
  const shrink = shouldGrowWheelFrom(hasViewTransition, wheelMotionOk(), !!canvasWrap && smallWheel !== null && smallWheel === fromEl);

  const hideModal = (): void => {
    setWheelTransitionName(canvasWrap, false);
    setWheelTransitionName(smallWheel, true);
    modal.style.display = 'none';
  };

  if (shrink) {
    setWheelTransitionName(canvasWrap, true);
    const transition = startWheelViewTransition(() => { hideModal(); disposeFlavorWheel(); });
    if (transition) {
      const clearNames = (): void => { setWheelTransitionName(canvasWrap, false); setWheelTransitionName(smallWheel, false); };
      const done = transition.finished ?? transition.updateCallbackDone;
      if (done) void done.then(clearNames, clearNames);
      else clearNames();
    } else {
      hideModal();
      disposeFlavorWheel();
    }
  } else {
    setWheelTransitionName(canvasWrap, false);
    modal.style.display = 'none';
    disposeFlavorWheel();
  }
}
