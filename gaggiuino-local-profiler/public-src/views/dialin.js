import { S } from '../state.js';
import { t } from '../i18n.js';
import { localeFor } from '../constants.js';
import { esc, scoreColor } from '../utils.js';

export async function renderDialin() {
  const select = document.getElementById('dialinCount');
  const saved  = localStorage.getItem('glp_dialin_count');
  if (select && saved && select.value !== saved) select.value = saved;

  const n    = parseInt(select?.value || 5);
  const grid = document.getElementById('dialinGrid');
  if (!grid) return;

  const recent = [...S.shots]
    .filter(s => !s._trashed)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, n);

  if (recent.length === 0) {
    grid.innerHTML = `<div class="dialin-empty">${t('dialin_empty')}</div>`;
    return;
  }

  const locale = localeFor(S.currentLang);

  // #957: curves are lazy per shot — fetch the handful this grid shows first.
  if (window.ensureCurves) await window.ensureCurves(recent.map(s => s.id));

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  grid.innerHTML = recent.map(s => {
    const data  = window.getShotDataById ? window.getShotDataById(s.id) : null;
    const ann   = s.annotation || {};
    const score = window.calcShotScore ? window.calcShotScore(s) : null;
    const dur   = s.duration ? (s.duration / 10).toFixed(0) + ' s' : '–';

    let pAvg = '–';
    if (data) {
      const pArr    = data.pressure || [];
      const pActive = pArr.filter(pt => pt.y != null && pt.y >= 5);
      pAvg = pActive.length ? (pActive.reduce((a, pt) => a + pt.y, 0) / pActive.length).toFixed(1) + ' bar' : '–';
    }

    const dose   = ann.dose  ? ann.dose + ' g'  : null;
    const yield_ = s.weight  ? (s.weight / 10).toFixed(1) + ' g' : null;
    const ratio  = (ann.dose && s.weight) ? '1:' + (s.weight / 10 / ann.dose).toFixed(1) : null;
    const date   = new Date(s.timestamp * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
    const profile = s.profile?.name || s.profileName || '–';
    const scorePill = score != null
      // #811: colour/size/radius moved to .score-pill in style.css so this
      // resolves through --on-fill and the type scale. The hardcoded #fff
      // measured 2.37-3.16:1 on the dark theme's semantic fills; only the
      // background stays inline, since it is computed per score.
      ? `<span class="score-pill" style="background:${scoreColor(score)}">${score}</span>`
      : '';

    const metrics = [
      [t('dialin_pressure'), pAvg],
      [t('dialin_duration'), dur],
      dose   ? [t('dialin_dose'),  dose]   : null,
      ratio  ? [t('dialin_ratio'), ratio]  : null,
      yield_ ? [t('dialin_yield'), yield_] : null,
    ].filter(Boolean).slice(0, 5);

    return `<div class="dialin-card" data-action="goto-shot" data-id="${s.id}">
      <div class="dialin-card-head">
        <div>
          <div class="dialin-profile">${esc(profile)}</div>
          <div class="dialin-date">${date}${ann.coffee ? ' · ' + esc(ann.coffee) : ''}</div>
        </div>
        ${scorePill}
      </div>
      <div class="dialin-metrics">
        ${metrics.map(([l, v]) => `<div class="dialin-metric"><span class="dialin-metric-lbl">${l}</span><span class="dialin-metric-val">${v}</span></div>`).join('')}
      </div>
    </div>`;
  }).join('');
}
