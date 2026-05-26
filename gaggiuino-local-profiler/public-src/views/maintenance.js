import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { MAINT_META } from '../constants.js';

export function maintStatusLabel(status) {
  return { ok: t('maint_ok'), soon: t('maint_soon'), due: t('maint_due'), never: t('maint_never') }[status] || '';
}

export async function loadMaintenanceView() {
  const container = document.getElementById('maint-cards');
  container.innerHTML = `<div class="loading-state">${t('loading')}</div>`;
  try {
    const r = await apiFetch('api/maintenance');
    const data = await r.json();
    renderMaintenanceCards(data);
  } catch (e) {
    container.innerHTML = `<div class="loading-state" style="color:#ef4444">${t('error_load')}</div>`;
  }
}

export function _buildMaintCard(task, d, title, icon) {
  const lastDoneText = d.daysSince === null
    ? t('maint_never_done')
    : d.daysSince === 0
      ? t('maint_today')
      : `${t('maint_ago_days', d.daysSince)}`;
  const shotsText = d.shotsSince > 0 ? ` · ${t('maint_shots_since', d.shotsSince)}` : '';
  const mode = d.threshold_shots !== null ? 'shots' : 'days';
  const val  = mode === 'shots' ? d.threshold_shots : d.threshold_days;
  const threshHtml = `<div class="maint-thresholds">
    <div class="maint-mode-toggle">
      <button class="maint-mode-btn${mode === 'shots' ? ' active' : ''}"
          onclick="setMaintMode('${task}','shots')">${t('maint_by_shots')}</button>
      <button class="maint-mode-btn${mode === 'days' ? ' active' : ''}"
          onclick="setMaintMode('${task}','days')">${t('maint_by_days')}</button>
    </div>
    <label class="maint-threshold-field">
      <input type="number" min="1" max="9999" value="${val}"
          onchange="saveMaintThreshold('${task}','${mode === 'shots' ? 'threshold_shots' : 'threshold_days'}',this.value)">
    </label>
  </div>`;
  const card = document.createElement('div');
  card.className = `maint-card status-${d.status}`;
  card.innerHTML = `
    <div class="maint-card-header">
      <span class="maint-icon">${icon}</span>
      <span class="maint-title">${title}</span>
      <span class="maint-status-pill ${d.status}">${maintStatusLabel(d.status)}</span>
    </div>
    <div class="maint-stats">
      <span>${lastDoneText}${shotsText}</span>
    </div>
    <div class="maint-bar-track">
      <div class="maint-bar-fill ${d.status}" style="width:${Math.round(d.pct * 100)}%"></div>
    </div>
    ${threshHtml}
    <button class="maint-done-btn" onclick="markMaintDone('${task}')">✓ ${t('maint_done_btn')}</button>
  `;
  return card;
}

export function renderMaintenanceCards(data) {
  const container = document.getElementById('maint-cards');
  container.innerHTML = '';
  let anyDue = false;

  for (const [task, meta] of Object.entries(MAINT_META)) {
    const d = data[task];
    if (!d) continue;
    if (d.status === 'due' || d.status === 'never') anyDue = true;
    container.appendChild(_buildMaintCard(task, d, t(meta.key), meta.icon));
  }

  const grinderEntries = Object.entries(data).filter(([k]) => k.startsWith('grinder_'));
  if (grinderEntries.length > 0) {
    const header = document.createElement('h3');
    header.className = 'maint-section-title';
    header.textContent = t('maint_grinder_section');
    container.appendChild(header);
    for (const [task, d] of grinderEntries) {
      if (!d) continue;
      if (d.status === 'due' || d.status === 'never') anyDue = true;
      container.appendChild(_buildMaintCard(task, d, d.grinderName || task, '⚙'));
    }
  }

  const badge = document.getElementById('maintBadge');
  if (badge) badge.style.display = anyDue ? 'inline-block' : 'none';
}

export async function markMaintDone(task) {
  try {
    const r = await apiFetch(`api/maintenance/${task}/done`, { method: 'POST' });
    renderMaintenanceCards(await r.json());
  } catch (e) {}
}

export async function saveMaintThreshold(task, field, value) {
  try {
    await apiFetch(`api/maintenance/${task}/threshold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: parseInt(value) }),
    });
  } catch (e) {}
}

export async function setMaintMode(task, mode) {
  const defaults = { shots: 200, days: 30 };
  const body = mode === 'shots'
    ? { threshold_shots: defaults.shots, threshold_days: null }
    : { threshold_shots: null, threshold_days: defaults.days };
  try {
    const r = await apiFetch(`api/maintenance/${task}/threshold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    renderMaintenanceCards(await r.json());
  } catch (e) {}
}
