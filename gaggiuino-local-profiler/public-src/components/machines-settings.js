// Multi-machine registry UI (#319, #325) — Settings tab "Maschinen" card:
// list, add, edit, delete and test-connect the machines this GLP instance
// manages, against the /api/machines API added in #317. Also renders the
// topbar machine switcher and drives S.activeMachineId, which
// filterShotsByMachine() (state.js) and applyActiveMachineChange() below
// use to keep the Shots list / Analytics / Live view scoped to the
// selected machine.
import { S, setState, filterShotsByMachine } from '../state.js';
import { apiFetch } from '../api.js';
import { t } from '../i18n.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

(function restoreActiveMachine() {
  const stored = localStorage.getItem('glp_active_machine');
  if (stored) S.activeMachineId = stored === 'all' ? 'all' : parseInt(stored, 10);
})();

export function setActiveMachine(id) {
  setState('activeMachineId', id);
  try { localStorage.setItem('glp_active_machine', String(id)); } catch {}
}

// The default machine's id, or null before /api/machines has ever loaded —
// used by views/live.js to decide whether the currently active machine has
// real live-polling support (only the default machine does, in this round).
export function getDefaultMachineId() {
  return (S.machines || []).find(m => m.isDefault)?.id ?? null;
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
      // loadData() and loadMachines() both fire around startup with no
      // fixed order — if shots already loaded before the default machine
      // was known, S.shots was filtered against a null activeMachineId
      // (i.e. unfiltered). Re-filter now that it's set; a no-op for
      // single-machine installs and for the case where loadData() simply
      // hasn't run yet (S.allShots still empty).
      applyActiveMachineChange();
    }
    renderMachinesList();
    renderMachineSwitcher();
  } catch (e) { /* offline/first-run — settings card just stays empty */ }
}

// Topbar switcher (#325) — only shown once >1 machine is registered, so a
// single-machine install never sees it. "All machines" is always the first
// option once the switcher is visible.
export function renderMachineSwitcher() {
  const el = document.getElementById('machineSwitcher');
  if (!el) return;
  const machines = S.machines || [];
  if (machines.length < 2) { el.style.display = 'none'; el.innerHTML = ''; return; }

  el.innerHTML = `<option value="all">${escapeHtml(t('machine_switcher_all'))}</option>` +
    machines.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  el.value = String(S.activeMachineId ?? 'all');
  el.style.display = '';
}

export function switchActiveMachine(rawValue) {
  const value = rawValue === 'all' ? 'all' : parseInt(rawValue, 10);
  setActiveMachine(value);
  applyActiveMachineChange();
}

// Re-filters the cached shot list and refreshes whichever view is
// currently open (#325) — called after switchActiveMachine() and once
// machines first finish loading.
export function applyActiveMachineChange() {
  S.shots = filterShotsByMachine(S.allShots || [], S.activeMachineId);
  if (window.renderSidebar) window.renderSidebar();
  if (S.shots.length && !S.shots.some(s => s.id === S.primaryShotId)) {
    S.primaryShotId = S.shots[S.shots.length - 1].id;
    S.compareShotId = null;
  }
  if (window.updateView) window.updateView();
  if (S.currentMode === 'analytics' && window.initAnalytics) window.initAnalytics();
  if (S.currentMode === 'live' && window.connectLiveStream) window.connectLiveStream();
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
      ${m.type === 'gaggimate' ? `<span class="machine-row-badge-experimental" title="${escapeHtml(t('settings_machine_type_gaggimate'))}">${t('settings_machine_experimental_badge')}</span>` : ''}
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
