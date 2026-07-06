import { FLAVOR_WHEEL } from '../flavor-data.js';
import { matchFlavors, markLit, hslFor, labelColorFor, parentIdOf, nodeById, pathToNode, findAutoZoomTarget } from '../flavor-match.js';
import { S } from '../state.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { loadBeanImageBlobUrl } from '../bean-image.js';

export { matchFlavors, normalizeFlavor } from '../flavor-match.js';

// ── Sunburst rendering ──────────────────────────────────────────────────────

const WHEEL_ROOT_ID = '__flavor_wheel_root__'; // virtual root name (see SunburstSeries: {name, children: data})

function toSunburstData(node, depth, hue, lang) {
  const label = node[lang] || node.en;
  const lit   = node._lit;
  const entry = {
    id: node.id,
    name: label,
    // Only the matched path (this bean's actual flavor tags + their
    // ancestor categories, via markLit) is shown large/labeled/fully
    // colored. Everything else stays a narrow, muted, unlabeled sliver —
    // the full wheel shape is still there for context, but it no longer
    // competes with the handful of segments that actually matter for this
    // bean (see hslFor for the color side of this).
    itemStyle: { color: hslFor(hue, depth, lit), borderColor: lit ? '#fff' : '#111113', borderWidth: lit ? 2.5 : 1.5 },
    label: { show: !!lit, color: labelColorFor(depth), fontSize: depth === 1 ? 13 : depth === 2 ? 11 : 10, fontWeight: 'bold' },
  };
  if (node.children?.length) {
    entry.children = node.children.map(c => toSunburstData(c, depth + 1, hue, lang));
  } else {
    entry.value = 1;
  }
  return entry;
}

let _chart = null;
let _rootId = null; // currently zoomed-to node id, or null for the full overview
let _lang = 'en';
let _breadcrumbEl = null;

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
  const data = FLAVOR_WHEEL.map(cat => toSunburstData(cat, 1, cat.hue, lang));

  _lang = lang;
  _breadcrumbEl = breadcrumbEl || null;
  if (_chart) { _chart.dispose(); _chart = null; }
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
  return true;
}

export function disposeFlavorWheel() {
  if (_chart) { _chart.dispose(); _chart = null; }
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
