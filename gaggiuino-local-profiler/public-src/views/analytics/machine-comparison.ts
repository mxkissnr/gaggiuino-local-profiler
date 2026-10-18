import { tHtml } from '../../i18n.js';
import { esc, html, joinHtml, scoreClass } from '../../utils.js';
import { _allShots, _machines } from './shared.js';
import type { MachineRow, ShotRow } from './shared.js';

// ── Machine comparison ──────────────────────────────────────────────────────
// Deliberately reads S.allShots (unfiltered), not S.shots — comparing
// machines against each other only makes sense across all of them,
// regardless of whatever S.activeMachineId currently scopes the rest of
// the app to. Only rendered once >=2 machines are registered.
function _tempStability(shot: ShotRow): number | null {
  // #957: the server computes this scalar per GET /api/shots row
  // (tempStabilityDev) from the same temp+target series it parses to score —
  // no per-shot curve fetch needed here. Fall back to a local compute only
  // for synthetic/demo shots that carry their own datapoints inline.
  if (shot.tempStabilityDev !== undefined) return shot.tempStabilityDev;
  const d = shot.datapoints ?? {};
  const temp = d.temperature, target = d.targetTemperature;
  if (!temp?.length || !target?.length) return null;
  const n = Math.min(temp.length, target.length);
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    const t = temp[i], tg = target[i];
    // #1688: skip a failed thermocouple read (stored as exactly 0) as well as
    // a missing target sample, so a dropout is not counted as a ~90 C
    // deviation and this fallback matches the server's tempStabilityDev.
    if (t == null || tg == null || tg === 0 || t === 0) continue;
    sum += Math.abs(t - tg) / 10; // both datapoints ×10-scaled per GLP convention
    count++;
  }
  return count ? sum / count : null;
}

export function _computeMachineComparison(shots: ShotRow[], machines: MachineRow[]) {
  const byMachine: Record<number, { name: string | null | undefined; shots: ShotRow[] }> = {};
  for (const m of machines) byMachine[m.id] = { name: m.name, shots: [] };
  for (const s of shots) {
    const mid = s.machineId ?? 1;
    const machine = byMachine[mid];
    if (machine) machine.shots.push(s);
  }

  return Object.values(byMachine).map(d => {
    const scored = d.shots
      .map(s => window.calcShotScore ? window.calcShotScore(s) : null)
      .filter((sc): sc is number => sc !== null);
    const avgScore = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;

    const durations = d.shots.map(s => (s.duration || 0) / 10).filter(x => x > 5);
    const avgDuration = durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null;

    const stabilities = d.shots.map(_tempStability).filter((x): x is number => x != null);
    const avgStability = stabilities.length ? Math.round((stabilities.reduce((a, b) => a + b, 0) / stabilities.length) * 10) / 10 : null;

    return { name: d.name, count: d.shots.length, avgScore, avgDuration, avgStability };
  });
}

export function buildMachineComparison() {
  const card = document.getElementById('machineComparisonCard');
  if (!card) return;
  const machines = _machines() || [];
  if (machines.length < 2) { card.style.display = 'none'; return; }
  card.style.display = '';

  const el = document.getElementById('machineComparison');
  if (!el) return;

  const rows = _computeMachineComparison(_allShots() || [], machines);
  if (!rows.some(r => r.count > 0)) {
    el.innerHTML = html`<p class="empty-note">${tHtml('analytics_no_machine_data')}</p>`;
    return;
  }

  const rowsHtml = joinHtml(rows.map(r => html`<tr>
    <td>${esc(r.name)}</td>
    <td class="num">${esc(r.count)}</td>
    <td class="num">${r.avgScore !== null ? html`<span class="${esc(scoreClass(r.avgScore))}">${esc(r.avgScore)}</span>` : esc('–')}</td>
    <td class="num">${esc(r.avgDuration !== null ? r.avgDuration + 's' : '–')}</td>
    <td class="num">${esc(r.avgStability !== null ? '±' + r.avgStability + '°' : '–')}</td>
  </tr>`));

  el.innerHTML = html`<div class="analytics-table-wrap"><table class="analytics-table">
    <thead><tr>
      <th>${tHtml('maint_log_machine')}</th><th>${tHtml('bean_stat_shots')}</th><th>${tHtml('bean_stat_avg')}</th>
      <th>${tHtml('bean_stat_duration')}</th><th>${tHtml('analytics_machine_stability')}</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table></div>`;
}
