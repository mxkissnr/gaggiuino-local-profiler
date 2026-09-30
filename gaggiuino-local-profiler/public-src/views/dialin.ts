import { S } from '../state/index.js';
import type { ShotMeta } from '../state/index.js';
import { tHtml } from '../i18n.js';
import { localeFor } from '../constants.js';
import { esc, html, joinHtml, scoreColor } from '../utils.js';
import type { Html } from '../utils.js';

interface DialinAnnotation {
  dose?: string | number | null;
  coffee?: string | null;
}

// state/index.ts types shot rows as metadata-only `ShotMeta`; the dial-in grid
// reads the hydrated fields the metadata list still carries.
interface DialinShot extends ShotMeta {
  _trashed?: boolean;
  duration?: number | null;
  weight?: number | null;
  profileName?: string | null;
  profile?: { name?: string | null } | null;
  annotation?: DialinAnnotation | null;
}

export async function renderDialin(): Promise<void> {
  const select = document.getElementById('dialinCount') as HTMLSelectElement | null;
  const saved  = localStorage.getItem('glp_dialin_count');
  if (select && saved && select.value !== saved) select.value = saved;

  const n    = parseInt((select?.value || 5) as string);
  const grid = document.getElementById('dialinGrid');
  if (!grid) return;

  const recent = ([...S.shots] as DialinShot[])
    .filter(s => !s._trashed)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, n);

  if (recent.length === 0) {
    grid.innerHTML = html`<div class="dialin-empty">${tHtml('dialin_empty')}</div>`;
    return;
  }

  const locale = localeFor(S.currentLang);

  // #957: curves are lazy per shot — fetch the handful this grid shows first.
  if (window.ensureCurves) await window.ensureCurves(recent.map(s => s.id));

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  grid.innerHTML = joinHtml(recent.map(s => {
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

    const dose   = ann.dose  ? html`${esc(String(ann.dose))} g`  : null;
    const yield_ = s.weight  ? html`${esc((s.weight / 10).toFixed(1))} g` : null;
    const ratio  = (ann.dose && s.weight) ? html`1:${esc((s.weight / 10 / (ann.dose as number)).toFixed(1))}` : null;
    const date   = new Date(s.timestamp * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
    const profile = s.profile?.name || s.profileName || '–';
    const scorePill: Html = score != null
      // #811: colour/size/radius moved to .score-pill in style.css so this
      // resolves through --on-fill and the type scale. The hardcoded #fff
      // measured 2.37-3.16:1 on the dark theme's semantic fills; only the
      // background stays inline, since it is computed per score.
      ? html`<span class="score-pill" style="background:${esc(scoreColor(score))}">${esc(score)}</span>`
      : html``;

    const metrics = [
      [tHtml('dialin_pressure'), esc(pAvg)],
      [tHtml('dialin_duration'), esc(dur)],
      dose   ? [tHtml('dialin_dose'),  dose]   : null,
      ratio  ? [tHtml('dialin_ratio'), ratio]  : null,
      yield_ ? [tHtml('dialin_yield'), yield_] : null,
    ].filter((m): m is [Html, Html] => m !== null).slice(0, 5);

    return html`<div class="dialin-card" data-action="goto-shot" data-id="${esc(s.id)}">
      <div class="dialin-card-head">
        <div>
          <div class="dialin-profile">${esc(profile)}</div>
          <div class="dialin-date">${esc(date)}${ann.coffee ? html` · ${esc(ann.coffee)}` : html``}</div>
        </div>
        ${scorePill}
      </div>
      <div class="dialin-metrics">
        ${joinHtml(metrics.map(([l, v]) => html`<div class="dialin-metric"><span class="dialin-metric-lbl">${l}</span><span class="dialin-metric-val">${v}</span></div>`))}
      </div>
    </div>`;
  }));
}
