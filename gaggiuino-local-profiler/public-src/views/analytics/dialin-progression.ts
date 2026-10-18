import Chart from 'chart.js/auto';
import * as chartRegistry from '../../state/charts.js';
import { t, tHtml } from '../../i18n.js';
import { esc, html, joinHtml, chartColors, themeColor } from '../../utils.js';
import { _parseGrindNum } from '../shots/grind.js';
import type { ChartConfiguration } from 'chart.js';
import { _beanGroup, _beans, _chartCanvas, _mutedTickColor, _pageShots } from './shared.js';

// ── Dial-in progression ─────────────────────────────────────────────────────
// Per-bean line chart of grind setting and score across that bean's own shot
// sequence, so a dial-in arc is visible independent of calendar time. Shots
// are grouped by _beanGroup's key (beanId first, name fallback), so old and
// new names of a renamed bean stay one series; the option label is the
// library bean's current name. The <option> value is that key.
export function buildDialinProgression() {
  const sel = document.getElementById('dialinProgressionBeanSelect') as HTMLSelectElement | null;
  if (!sel) return;

  const beans = _beans();
  const seen = new Map<string, string>();
  for (const s of _pageShots()) {
    const group = _beanGroup(s.annotation, beans);
    if (!group) continue;
    if (!seen.has(group.key)) seen.set(group.key, group.label);
  }
  const keys = [...seen.keys()].sort((a, b) => (seen.get(a) || '').localeCompare(seen.get(b) || ''));

  if (!keys.length) {
    sel.innerHTML = html``;
    _renderDialinProgressionChart(null);
    return;
  }

  const prevValue = sel.value;
  sel.innerHTML = joinHtml(keys.map(k => html`<option value="${esc(k)}">${esc(seen.get(k) || '')}</option>`));
  sel.value = keys.includes(prevValue) ? prevValue : keys[0] ?? '';
  _renderDialinProgressionChart(sel.value);
}

export function setDialinProgressionBean(beanKey: string): void {
  _renderDialinProgressionChart(beanKey);
}

function _renderDialinProgressionChart(beanKey: string | null): void {
  // #814: resolved per render, never at module load — the value has to be
  // whatever the ACTIVE theme resolves to right now.
  const C = chartColors();
  const ctx = _chartCanvas('dialinProgressionChart');
  if (!ctx) return;
  chartRegistry.dispose('dialinProgressionChart');

  if (!beanKey) {
    ctx.parentElement!.innerHTML = html`<p class="empty-note pad-top">${tHtml('analytics_no_beans')}</p>`;
    return;
  }

  const beans = _beans();
  const shots = _pageShots()
    .filter(s => _beanGroup(s.annotation, beans)?.key === beanKey)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (shots.length < 2) {
    ctx.parentElement!.innerHTML = html`<p class="empty-note pad-top">${tHtml('analytics_no_trend')}</p>`;
    return;
  }

  const labels    = shots.map((_, i) => `#${i + 1}`);
  const grindData = shots.map(s => _parseGrindNum(s.annotation?.grindSetting));
  const scoreData = shots.map(s => window.calcShotScore ? window.calcShotScore(s) : null);

  chartRegistry.set('dialinProgressionChart', new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: t('ann_grind_setting'), data: grindData, borderColor: '#38bdf8', backgroundColor: 'transparent',
          yAxisID: 'y', spanGaps: true, tension: .2, pointRadius: 3 },
        { label: t('sort_score'), data: scoreData, borderColor: '#ef4444', backgroundColor: 'transparent',
          yAxisID: 'y1', spanGaps: true, tension: .2, pointRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      onClick: (_: unknown, elements: { index: number }[]) => {
        const first = elements[0];
        const shot = first ? shots[first.index] : undefined;
        if (shot && window.goToShot) window.goToShot(shot.id);
      },
      plugins: { legend: { labels: { color: C.tick, font: { size: 11 } } } },
      scales: {
        x:  { ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { color: themeColor('--gray-700', '#2b2f33') } },
        y:  { position: 'left',  ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { color: themeColor('--gray-700', '#2b2f33') } },
        y1: { position: 'right', min: 0, max: 100, ticks: { color: _mutedTickColor(), font: { size: 10 } }, grid: { drawOnChartArea: false } },
      },
    },
  } satisfies ChartConfiguration<'line'>));
}
