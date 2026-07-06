import { FLAVOR_WHEEL } from '../flavor-data.js';
import { matchFlavors, markLit, hslFor, labelColorFor } from '../flavor-match.js';
import { S } from '../state.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { loadBeanImageBlobUrl } from '../bean-image.js';

export { matchFlavors, normalizeFlavor } from '../flavor-match.js';

// ── Sunburst rendering ──────────────────────────────────────────────────────

function toSunburstData(node, depth, hue, lang) {
  const label = node[lang] || node.en;
  const lit   = node._lit;
  const entry = {
    name: label,
    itemStyle: { color: hslFor(hue, depth, !lit) },
    label: { show: depth === 1 || lit, color: labelColorFor(depth, lit), fontSize: depth === 1 ? 12 : 10 },
  };
  if (node.children?.length) {
    entry.children = node.children.map(c => toSunburstData(c, depth + 1, hue, lang));
  } else {
    entry.value = 1;
  }
  return entry;
}

let _chart = null;

export function renderFlavorWheel(container, flavors, lang) {
  if (typeof echarts === 'undefined') return false;
  const { matched } = matchFlavors(flavors);
  const data = FLAVOR_WHEEL.map(cat => {
    markLit(cat, matched);
    return toSunburstData(cat, 1, cat.hue, lang);
  });

  if (_chart) { _chart.dispose(); _chart = null; }
  _chart = echarts.init(container);
  _chart.setOption({
    backgroundColor: 'transparent',
    series: [{
      type: 'sunburst', radius: ['14%', '92%'], center: ['50%', '50%'],
      data, sort: null,
      emphasis: { focus: 'ancestor' },
      itemStyle: { borderColor: '#111113', borderWidth: 1.5 },
      // minAngle/hideOverlap: crowded outer rings (many matched leaf flavors
      // under one subcategory) could otherwise overlap or run off tiny wedges.
      label: { minAngle: 8, hideOverlap: true },
      levels: [{}, { r0: '14%', r: '38%' }, { r0: '38%', r: '68%' }, { r0: '68%', r: '92%' }],
    }],
  });
  return true;
}

export function disposeFlavorWheel() {
  if (_chart) { _chart.dispose(); _chart = null; }
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
  const lang = ['de', 'en', 'it', 'fr', 'es', 'nl'].includes(S.currentLang) ? S.currentLang : 'en';
  if (!renderFlavorWheel(container, bean.flavors, lang)) {
    container.innerHTML = `<p style="color:#52525b;font-size:.85rem;text-align:center">${t('flavor_wheel_unavailable')}</p>`;
  }
}

export function closeFlavorWheel() {
  const modal = document.getElementById('flavorWheelModal');
  if (modal) modal.style.display = 'none';
  disposeFlavorWheel();
}
