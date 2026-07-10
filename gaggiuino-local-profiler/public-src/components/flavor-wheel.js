import { FLAVOR_WHEEL } from '../flavor-data.js';
import { matchFlavors, markLit, colorForNode, muteHex, contrastTextColor, parentIdOf, nodeById, pathToNode, findAutoZoomTarget } from '../flavor-match.js';
import { layoutLeaderLabels } from '../flavor-wheel-labels.js';
import { S } from '../state.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { loadBeanImageBlobUrl } from '../bean-image.js';

export { matchFlavors, normalizeFlavor } from '../flavor-match.js';

// ── Sunburst rendering ──────────────────────────────────────────────────────

const WHEEL_ROOT_ID = '__flavor_wheel_root__'; // virtual root name (see SunburstSeries: {name, children: data})

// Modal background the muted/unmatched fills and outer-ring label colors
// blend toward — read once per render from the actual modal box so it
// tracks the active dark/light theme instead of a hardcoded guess.
function rgbStringToHex(rgbStr, fallback) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgbStr || '');
  if (!m) return fallback;
  const hex = n => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

function resolveModalBgHex(container) {
  const modalBox = container?.closest?.('.flavor-wheel-modal');
  const bg = modalBox ? getComputedStyle(modalBox).backgroundColor : null;
  return rgbStringToHex(bg, '#18181b');
}

function toSunburstData(node, depth, lang, bgHex) {
  const label = node[lang] || node.en;
  const lit   = node._lit;
  const realColor = colorForNode(node.id);
  // Only the matched path (this bean's actual flavor tags + their ancestor
  // categories, via markLit) is shown fully colored/labeled. Everything
  // else stays a narrow, muted sliver blended toward the modal background —
  // the full wheel shape is still there for context and still hints at its
  // real hue, without competing with the handful of segments that actually
  // matter for this bean.
  const fillColor = lit ? realColor : muteHex(realColor, bgHex, 0.35);
  // Depth 1 (the 9 top categories) keeps ECharts' native in-wedge label —
  // wide wedges that practically never collide. Depth 2/3 labels are drawn
  // by our own leader-line SVG overlay instead (see renderLeaderOverlay
  // below): unpredictable subsets of lit nodes at those depths could
  // otherwise collide with each other's in-wedge text, so the native label
  // is suppressed here regardless of `lit`.
  const labelCfg = { show: depth === 1 ? !!lit : false, color: contrastTextColor(realColor), fontSize: depth === 1 ? 13 : depth === 3 ? 10 : 11, fontWeight: 'bold' };
  const entry = {
    id: node.id,
    name: label,
    itemStyle: { color: fillColor, borderColor: lit ? '#fff' : '#111113', borderWidth: lit ? 2.5 : 1.5 },
    label: labelCfg,
  };
  if (node.children?.length) {
    entry.children = node.children.map(c => toSunburstData(c, depth + 1, lang, bgHex));
  } else {
    entry.value = 1;
  }
  return entry;
}

let _chart = null;
let _rootId = null; // currently zoomed-to node id, or null for the full overview
let _lang = 'en';
let _breadcrumbEl = null;
let _bgHex = '#18181b';
let _overlaySvg = null; // leader-line label overlay (see renderLeaderOverlay)

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── Leader-line label overlay (depth 2/3) ───────────────────────────────
// Native ECharts in-wedge labels are disabled for depth 2/3 (see
// toSunburstData above) in favor of leader lines drawn on a transparent SVG
// laid directly over the ECharts canvas: text sits horizontally at the
// container's edge, connected to its wedge by a thin line, with
// hemisphere + vertical-relaxation collision avoidance (flavor-wheel-labels.js)
// so any combination of simultaneously lit flavors stays readable.
//
// Wedge geometry is read straight from ECharts' own computed sunburst
// layout (series.getData().tree.root, each TreeNode's getLayout()) rather
// than re-derived/estimated — that tree reflects the *original* (unzoomed)
// data order and depth, while getLayout() reflects whatever the chart is
// currently showing (including after sunburstRootToNode zooms), so reading
// both together always matches the real rendered wedge positions exactly.
function collectLeaderAnchors() {
  const seriesModel = _chart.getModel().getSeriesByIndex(0);
  const data = seriesModel.getData();
  const root = data.tree.root;
  const anchors = [];
  (function walk(treeNode) {
    if (treeNode.depth >= 2) {
      const rawItem = data.getRawDataItem(treeNode.dataIndex);
      const id = rawItem && rawItem.id;
      const node = id ? nodeById(id) : null;
      const layout = treeNode.getLayout();
      if (node?._lit && layout && layout.r > layout.r0 && (layout.endAngle - layout.startAngle) > 1e-6) {
        anchors.push({
          id,
          angle: (layout.startAngle + layout.endAngle) / 2,
          r: layout.r,
          cx: layout.cx,
          cy: layout.cy,
          text: node[_lang] || node.en,
          color: colorForNode(id),
        });
      }
    }
    (treeNode.children || []).forEach(walk);
  })(root);
  return anchors;
}

function ensureOverlay(container) {
  if (_overlaySvg) return;
  _overlaySvg = document.createElementNS(SVG_NS, 'svg');
  _overlaySvg.setAttribute('class', 'fw-label-overlay');
  container.appendChild(_overlaySvg);
}

function renderLeaderOverlay() {
  if (!_chart || !_overlaySvg) return;
  const container = _chart.getDom();
  const w = container.clientWidth;
  const h = container.clientHeight;
  _overlaySvg.setAttribute('width', w);
  _overlaySvg.setAttribute('height', h);
  _overlaySvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  while (_overlaySvg.firstChild) _overlaySvg.removeChild(_overlaySvg.firstChild);

  const anchors = collectLeaderAnchors();
  if (!anchors.length) return;

  // All labels aim for the same target radius (regardless of which ring
  // their wedge is actually on) so mid- and outer-ring labels relax against
  // each other in one shared column instead of two disconnected ones.
  const targetR = Math.min(w, h) / 2 - 6;
  const elbowPad = 14;
  const textMargin = 4;
  // Measured (not just estimated) text width per label, so a long label
  // (e.g. "Zartbitterschokolade") gets pulled in from the edge instead of
  // running past the container and getting silently clipped.
  const measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = "600 10px 'Figtree', sans-serif";
  const placed = layoutLeaderLabels(anchors.map(a => ({
    id: a.id, angle: a.angle, labelY: Math.sin(a.angle) * targetR,
  })), { minGap: 18 });

  // Leader-line text now sits on the modal background, not on its wedge's
  // own fill color, so it must be contrast-safe against `_bgHex` instead of
  // per-segment contrastTextColor(realColor) like the old in-wedge labels.
  const textColor = contrastTextColor(_bgHex);

  for (const p of placed) {
    const src = anchors.find(a => a.id === p.id);
    if (!src) continue;
    const anchorX = src.cx + Math.cos(src.angle) * src.r;
    const anchorY = src.cy + Math.sin(src.angle) * src.r;
    const elbowX = src.cx + Math.cos(src.angle) * (src.r + elbowPad);
    const elbowY = src.cy + Math.sin(src.angle) * (src.r + elbowPad);
    const textWidth = measureCtx.measureText(src.text).width;
    let labelX = p.side === 'right' ? src.cx + targetR : src.cx - targetR;
    if (p.side === 'right') {
      labelX = Math.min(labelX, w - 2 - textMargin - textWidth);
    } else {
      labelX = Math.max(labelX, textMargin + textWidth + 2);
    }
    // Clamp to the container bounds — the relaxed y can occasionally land a
    // couple px past the edge for an outlier in a dense cluster (see
    // horizontal clamp above for the same reasoning), which would otherwise
    // get silently clipped by the SVG's viewBox.
    const labelY = Math.min(h - 8, Math.max(8, src.cy + p.y));

    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', `${anchorX},${anchorY} ${elbowX},${elbowY} ${labelX},${labelY}`);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'rgba(161,161,170,.55)');
    line.setAttribute('stroke-width', '1');
    _overlaySvg.appendChild(line);

    // Small color-coded dot at the wedge itself, so which line belongs to
    // which segment stays unambiguous even when several leaders cross.
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', anchorX);
    dot.setAttribute('cy', anchorY);
    dot.setAttribute('r', '2.5');
    dot.setAttribute('fill', src.color);
    _overlaySvg.appendChild(dot);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', labelX + (p.side === 'right' ? 4 : -4));
    text.setAttribute('y', labelY);
    text.setAttribute('fill', textColor);
    text.setAttribute('font-size', '10');
    text.setAttribute('font-weight', '600');
    text.setAttribute('text-anchor', p.side === 'right' ? 'start' : 'end');
    text.setAttribute('dominant-baseline', 'middle');
    text.textContent = src.text;
    _overlaySvg.appendChild(text);
  }
}

function disposeOverlay() {
  if (_overlaySvg?.parentNode) _overlaySvg.parentNode.removeChild(_overlaySvg);
  _overlaySvg = null;
}

function renderBreadcrumb() {
  if (!_breadcrumbEl) return;
  const ids = _rootId ? pathToNode(_rootId) : [];
  const crumbs = [`<button type="button" class="fw-crumb" data-action="zoom-flavor-wheel" data-zoom-id="">${esc(t('flavor_wheel_overview'))}</button>`];
  for (const id of ids) {
    const node = nodeById(id);
    if (!node) continue;
    const label = node[_lang] || node.en;
    crumbs.push(`<span class="fw-crumb-sep">›</span><button type="button" class="fw-crumb" data-action="zoom-flavor-wheel" data-zoom-id="${esc(id)}">${esc(label)}</button>`);
  }
  _breadcrumbEl.innerHTML = crumbs.join('');
}

function zoomTo(id) {
  _rootId = id;
  _chart.dispatchAction({ type: 'sunburstRootToNode', targetNode: id || WHEEL_ROOT_ID });
  renderBreadcrumb();
  renderLeaderOverlay();
}

// Called from the global data-action click delegate (main.js) when a
// breadcrumb crumb is clicked; `id` is '' for the overview crumb.
export function zoomFlavorWheelTo(id) {
  if (!_chart) return;
  zoomTo(id || null);
}

export function renderFlavorWheel(container, flavors, lang, breadcrumbEl) {
  if (typeof echarts === 'undefined') return false;
  const { matched } = matchFlavors(flavors);
  FLAVOR_WHEEL.forEach(cat => markLit(cat, matched));
  const bgHex = resolveModalBgHex(container);
  const data = FLAVOR_WHEEL.map(cat => toSunburstData(cat, 1, lang, bgHex));

  _lang = lang;
  _bgHex = bgHex;
  _breadcrumbEl = breadcrumbEl || null;
  if (_chart) { _chart.dispose(); _chart = null; }
  disposeOverlay();
  _chart = echarts.init(container);
  _chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { formatter: params => (params.name === WHEEL_ROOT_ID ? '' : esc(params.name)) },
    series: [{
      type: 'sunburst', name: WHEEL_ROOT_ID, radius: ['14%', '92%'], center: ['50%', '50%'],
      data, sort: null,
      // Zoom is driven entirely by our own click handler below (so the
      // breadcrumb always matches what's on screen, including zoom-out).
      nodeClick: false,
      emphasis: { focus: 'ancestor' },
      itemStyle: { borderColor: '#111113', borderWidth: 1.5 },
      // minAngle/hideOverlap: crowded outer rings (many matched leaf flavors
      // under one subcategory) could otherwise overlap or run off tiny wedges.
      label: { minAngle: 8, hideOverlap: true },
      levels: [
        // depth 0 is echarts' own synthetic wrapper node (created internally
        // from `series.name` + our 9-category array) — it has no data of its
        // own, so it gets no itemStyle/label from toSunburstData and falls
        // back to echarts' theme defaults (a visible blue fill + its raw
        // name as a label). Invisible by default (tiny sliver at 0-14%
        // radius) but once zoomed in it's redistributed into a big, very
        // visible ring unless explicitly zeroed out here — same for the
        // emphasis state, since clicking triggers focus:'ancestor' up to it.
        { label: { show: false }, itemStyle: { color: 'transparent' }, emphasis: { label: { show: false }, itemStyle: { color: 'transparent' } } },
        { r0: '14%', r: '38%' },
        // Radial (spoke-pointing) labels on the outer two rings, matching
        // the real SCA/WCR wheel's signature look — you tilt the wheel to
        // read the far side, same as the paper original.
        { r0: '38%', r: '68%', label: { rotate: 'radial' } },
        { r0: '68%', r: '92%', label: { rotate: 'radial' } },
      ],
    }],
  });

  _chart.off('click');
  _chart.on('click', params => {
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
    // are a no-op — zooming a sunburst into an empty leaf has nothing to
    // draw (see findAutoZoomTarget for the same constraint on auto-zoom).
    if (clickedId === _rootId) { zoomTo(parentIdOf(clickedId)); return; }
    if (nodeById(clickedId)?.children?.length) zoomTo(clickedId);
  });

  const autoZoomId = findAutoZoomTarget(FLAVOR_WHEEL);
  _rootId = autoZoomId;
  if (autoZoomId) _chart.dispatchAction({ type: 'sunburstRootToNode', targetNode: autoZoomId });
  renderBreadcrumb();

  ensureOverlay(container);
  renderLeaderOverlay();
  // Safety net: node layout is available synchronously above, but 'finished'
  // (fired once entering animations settle) also re-runs the overlay so it
  // stays correct if a future echarts version ever delays layout.
  _chart.off('finished');
  _chart.on('finished', renderLeaderOverlay);
  return true;
}

export function disposeFlavorWheel() {
  if (_chart) { _chart.dispose(); _chart = null; }
  disposeOverlay();
  _rootId = null;
  _breadcrumbEl = null;
}

// ── Modal wiring ─────────────────────────────────────────────────────────

export function openFlavorWheel(beanId) {
  const bean = S.coffeeLibrary?.beans?.find(b => b.id === beanId);
  if (!bean) return;
  const modal = document.getElementById('flavorWheelModal');
  if (!modal) return;

  document.getElementById('flavorWheelTitle').textContent = bean.name;
  const imgEl = document.getElementById('flavorWheelImage');
  if (imgEl) {
    imgEl.style.display = 'none';
    if (bean.image) {
      loadBeanImageBlobUrl(bean.id).then(url => { if (url) { imgEl.src = url; imgEl.style.display = ''; } });
    }
  }

  const { unmatched } = matchFlavors(bean.flavors);
  const unmatchedWrap = document.getElementById('flavorWheelUnmatched');
  unmatchedWrap.innerHTML = unmatched.length
    ? `<div class="fw-unmatched-label">${t('flavor_wheel_unmatched')}</div>
       <div class="fw-unmatched-chips">${unmatched.map(f => `<span class="flavor-chip flavor-chip-static">${esc(f)}</span>`).join('')}</div>`
    : '';

  modal.style.display = 'flex';
  const container = document.getElementById('flavorWheelCanvas');
  const breadcrumbEl = document.getElementById('flavorWheelBreadcrumb');
  const lang = ['de', 'en', 'it', 'fr', 'es', 'nl'].includes(S.currentLang) ? S.currentLang : 'en';
  if (!renderFlavorWheel(container, bean.flavors, lang, breadcrumbEl)) {
    container.innerHTML = `<p style="color:#52525b;font-size:.85rem;text-align:center">${t('flavor_wheel_unavailable')}</p>`;
    if (breadcrumbEl) breadcrumbEl.innerHTML = '';
  }
}

export function closeFlavorWheel() {
  const modal = document.getElementById('flavorWheelModal');
  if (modal) modal.style.display = 'none';
  disposeFlavorWheel();
}
