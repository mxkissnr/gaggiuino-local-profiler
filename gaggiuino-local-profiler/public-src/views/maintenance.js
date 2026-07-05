import { S } from '../state.js';
import { t } from '../i18n.js';
import { apiFetch } from '../api.js';
import { MAINT_META } from '../constants.js';
import { esc } from '../utils.js';

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
  loadMaintLog();
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
          data-action="set-maint-mode" data-task="${task}" data-mode="shots">${t('maint_by_shots')}</button>
      <button class="maint-mode-btn${mode === 'days' ? ' active' : ''}"
          data-action="set-maint-mode" data-task="${task}" data-mode="days">${t('maint_by_days')}</button>
    </div>
    <label class="maint-threshold-field">
      <input type="number" min="1" max="9999" value="${val}"
          data-action="save-maint-threshold" data-task="${task}" data-field="${mode === 'shots' ? 'threshold_shots' : 'threshold_days'}">
    </label>
  </div>`;
  const card = document.createElement('div');
  card.className = `maint-card status-${d.status}`;
  card.innerHTML = `
    <div class="maint-card-header">
      <span class="maint-icon">${icon}</span>
      <span class="maint-title">${esc(title)}</span>
      <span class="maint-status-pill ${d.status}">${maintStatusLabel(d.status)}</span>
    </div>
    <div class="maint-stats">
      <span>${lastDoneText}${shotsText}</span>
    </div>
    <div class="maint-bar-track">
      <div class="maint-bar-fill ${d.status}" style="width:${Math.round(d.pct * 100)}%"></div>
    </div>
    ${threshHtml}
    <button class="maint-done-btn" data-action="mark-maint-done" data-task="${task}">✓ ${t('maint_done_btn')}</button>
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
    loadMaintLog();
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

// ── Maintenance Log ───────────────────────────────────────────────────────

const _logEsc = s => s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export async function loadMaintLog() {
  const el = document.getElementById('maintLog');
  if (!el) return;
  try {
    const entries = await apiFetch('api/maintenance/log').then(r => r.json());
    renderMaintLog(entries);
  } catch { el.innerHTML = ''; }
}

function taskLabel(entry) {
  const task = entry.task;
  if (MAINT_META[task]) return MAINT_META[task].icon + ' ' + t(MAINT_META[task].key);
  if (task.startsWith('grinder_')) return '⚙ ' + (entry.grinderName || task.replace('grinder_', 'Grinder '));
  return task;
}

export function renderMaintLog(entries) {
  const el = document.getElementById('maintLog');
  if (!el) return;
  if (!entries.length) {
    el.innerHTML = `<p style="color:#52525b;font-size:.82rem;padding:8px 0">${t('maint_log_empty')}</p>`;
    return;
  }
  const locale = S.currentLang === 'de' ? 'de-DE' : S.currentLang === 'nl' ? 'nl-NL'
    : S.currentLang === 'it' ? 'it-IT' : S.currentLang === 'fr' ? 'fr-FR'
    : S.currentLang === 'es' ? 'es-ES' : 'en-GB';

  let html = '<div class="maint-log-list">';
  for (const e of entries) {
    const dateStr = new Date(e.ts * 1000).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const isManual = e.shotCountAtTime === null;
    const metaArr = [];
    if (e.shotCountAtTime !== null) metaArr.push(`${e.shotCountAtTime} ${t('maint_log_shots')}`);
    if (e.machine) metaArr.push(_logEsc(e.machine));
    html += `<div class="maint-log-row">
      <div class="maint-log-date-col">${dateStr}</div>
      <div class="maint-log-task-col">
        <div class="maint-log-task-name">${_logEsc(taskLabel(e))}${isManual ? `<span class="maint-log-manual-badge">${t('maint_log_manual_badge')}</span>` : ''}</div>
        ${metaArr.length ? `<div class="maint-log-meta">${metaArr.join(' · ')}</div>` : ''}
        ${e.notes ? `<div class="maint-log-notes">${_logEsc(e.notes)}</div>` : ''}
      </div>
      <button class="maint-log-del-btn" data-action="delete-maint-log" data-id="${e.id}" title="${t('maint_log_confirm_delete')}">🗑</button>
    </div>`;
  }
  el.innerHTML = html + '</div>';
}

export function openMaintLogForm() {
  const form = document.getElementById('maintLogForm');
  if (!form) return;
  // Populate task dropdown
  const sel = document.getElementById('maintLogTask');
  sel.innerHTML = '';
  for (const [task, meta] of Object.entries(MAINT_META)) {
    const opt = document.createElement('option');
    opt.value = task; opt.textContent = meta.icon + ' ' + t(meta.key);
    sel.appendChild(opt);
  }
  // Set date to today
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('maintLogDate').value = today;
  document.getElementById('maintLogDate').max   = today;
  document.getElementById('maintLogNotes').value = '';
  form.style.display = 'flex';
}

export function closeMaintLogForm() {
  const form = document.getElementById('maintLogForm');
  if (form) form.style.display = 'none';
}

export async function submitMaintLogEntry() {
  const task  = document.getElementById('maintLogTask').value;
  const date  = document.getElementById('maintLogDate').value;
  const notes = document.getElementById('maintLogNotes').value.trim();
  if (!task || !date) return;
  try {
    await apiFetch('api/maintenance/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, date, notes }),
    });
    closeMaintLogForm();
    loadMaintLog();
  } catch {}
}

export async function deleteMaintLogEntry(id) {
  if (!confirm(t('maint_log_confirm_delete'))) return;
  try {
    await apiFetch(`api/maintenance/log/${id}`, { method: 'DELETE' });
    loadMaintLog();
  } catch {}
}
