// Multi-machine registry UI (#319) — Settings tab "Maschinen" card: list,
// add, edit, delete and test-connect the machines this GLP instance
// manages, against the /api/machines API added in #317. S.activeMachineId
// is persisted so a future machine-scoped view (Live/Shots/Analytics
// filtering) has a stable place to read "which machine am I looking at"
// from; per-view filtering itself is a follow-up, not wired in this round.
import { S, setState } from '../state.js';
import { apiFetch } from '../api.js';
import { t } from '../i18n.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

(function restoreActiveMachine() {
  const stored = localStorage.getItem('glp_active_machine');
  if (stored) S.activeMachineId = parseInt(stored, 10);
})();

export function setActiveMachine(id) {
  setState('activeMachineId', id);
  try { localStorage.setItem('glp_active_machine', String(id)); } catch {}
}

export async function loadMachines() {
  try {
    const r = await apiFetch('api/machines');
    if (!r.ok) return;
    const machines = await r.json();
    setState('machines', machines);
    if (!S.activeMachineId) {
      const def = machines.find(m => m.isDefault) || machines[0];
      if (def) setActiveMachine(def.id);
    }
    renderMachinesList();
  } catch (e) { /* offline/first-run — settings card just stays empty */ }
}

export function renderMachinesList() {
  const list = document.getElementById('machinesList');
  if (!list) return;
  list.innerHTML = '';
  (S.machines || []).forEach(m => {
    const row = document.createElement('div');
    row.className = 'machine-row';
    row.innerHTML = `
      <span class="machine-row-name">${escapeHtml(m.name)}</span>
      <span class="machine-row-type">${m.type === 'gaggimate' ? 'GaggiMate' : 'Gaggiuino'}</span>
      ${m.isDefault ? `<span class="machine-row-badge">${t('settings_machine_default')}</span>` : ''}
      <span class="machine-row-actions">
        <button type="button" class="machine-edit-btn">${t('settings_machine_edit')}</button>
        ${!m.isDefault ? `<button type="button" class="machine-delete-btn">${t('settings_machine_delete')}</button>` : ''}
      </span>`;
    row.querySelector('.machine-edit-btn').addEventListener('click', () => openMachineForm(m));
    row.querySelector('.machine-delete-btn')?.addEventListener('click', () => deleteMachine(m.id));
    list.appendChild(row);
  });
}

export function openMachineForm(machine) {
  const card = document.getElementById('machineFormCard');
  if (!card) return;
  document.getElementById('machineFormId').value = machine?.id || '';
  document.getElementById('machineFormName').value = machine?.name || '';
  document.getElementById('machineFormType').value = machine?.type || 'gaggiuino';
  document.getElementById('machineFormHost').value = machine?.host || '';
  document.getElementById('machineFormSwitch').value = machine?.switchEntity || '';
  document.getElementById('machineFormTestResult').textContent = '';
  card.style.display = '';
}

export function closeMachineForm() {
  const card = document.getElementById('machineFormCard');
  if (card) card.style.display = 'none';
}

export async function saveMachineForm() {
  const id = document.getElementById('machineFormId').value;
  const payload = {
    name: document.getElementById('machineFormName').value.trim(),
    type: document.getElementById('machineFormType').value,
    host: document.getElementById('machineFormHost').value.trim(),
    switchEntity: document.getElementById('machineFormSwitch').value.trim() || null,
  };
  if (!payload.name || !payload.host) return;
  const url    = id ? `api/machines/${id}` : 'api/machines';
  const method = id ? 'PUT' : 'POST';
  const r = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (r.ok) { closeMachineForm(); loadMachines(); }
}

export async function deleteMachine(id) {
  if (!confirm(t('settings_machine_delete_confirm'))) return;
  const r = await apiFetch(`api/machines/${id}`, { method: 'DELETE' });
  if (r.ok) loadMachines();
}

export async function testMachineForm() {
  const id = document.getElementById('machineFormId').value;
  const resultEl = document.getElementById('machineFormTestResult');
  if (!resultEl) return;
  if (!id) { resultEl.textContent = t('settings_machine_test_save_first'); return; }
  resultEl.textContent = t('settings_machine_testing');
  try {
    const r = await apiFetch(`api/machines/${id}/test`, { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    resultEl.textContent = data.reachable ? t('settings_machine_test_ok') : t('settings_machine_test_fail');
  } catch (e) {
    resultEl.textContent = t('settings_machine_test_fail');
  }
}
