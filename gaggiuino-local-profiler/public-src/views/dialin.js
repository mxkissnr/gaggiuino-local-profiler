import { S } from '../state.js';
import { t } from '../i18n.js';
import { LOCALE_MAP } from '../constants.js';
import { esc, scoreColor } from '../utils.js';

export function renderDialin() {
  const n    = parseInt(document.getElementById('dialinCount')?.value || 5);
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

  const locale = LOCALE_MAP[S.currentLang] || 'de-DE';

  grid.innerHTML = recent.map(s => {
    const data  = window.getShotData ? window.getShotData(s) : null;
    const ann   = s.annotation || {};
    const score = (data && window.calcShotScore) ? window.calcShotScore(s, data) : null;
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
    const scorePill = score !== null
      ? `<span style="background:${scoreColor(score)};color:#fff;font-size:.7rem;font-weight:700;padding:1px 7px;border-radius:10px">${score}</span>`
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
