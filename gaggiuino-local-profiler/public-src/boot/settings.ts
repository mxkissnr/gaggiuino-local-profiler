// Boot step (#1615): the Settings page -- backup, dev database tools, API
// token card, machines, setup wizard, MQTT/notify/MCP/machine-control and
// shot-default cards. Moved verbatim out of main.ts's DOMContentLoaded
// handler; run through runStep() so a missing element only skips this step.
import { S } from '../state/index.js';
import { t } from '../i18n.js';
import { openBackupExportModal, openBackupRestoreModal } from '../components/backup-modal.js';
import { exportDevDb, importDevDb } from '../components/status.js';
import { openMachineForm, closeMachineForm, saveMachineForm, testMachineForm, onThemeCustomColorAChange,
         onThemeCustomColorBChange, onThemeGradientToggleChange, onMachineTypeChange } from '../components/machines-settings.js';
import { openSetupWizard, closeSetupWizard } from '../views/setup-wizard.js';
import { setMqttTransport, saveMqttSettings, applyMqttToMachine } from '../components/mqtt-settings.js';
import { saveNotifySettings } from '../components/notify-settings.js';
import { renderMcpSettingsCard, saveMcpSettings } from '../components/mcp-settings.js';
import { saveMachineControlSetting } from '../components/machine-control.js';
import { saveShotDefaultsSettings } from '../components/shot-defaults-settings.js';

// ── API token (Settings view) ──────────────────────────────────────────────
// Shows the token once the session holds one. #803: when expose_api_port is
// off, a direct-port session (no Ingress) never gets a token at all — this
// card then shows an explanation instead of just disappearing, since a
// silently-hidden card here is exactly what would leave someone setting up
// the installable PWA or a direct-URL Order Card with no idea why. A session
// that reached Settings via Ingress is unaffected either way (Ingress always
// gets a token, expose_api_port or not) and still shows the token normally.
export function renderApiTokenCard() {
  const card = document.getElementById('apiTokenCard');
  const valueEl = document.getElementById('apiTokenValue');
  const rowEl = document.getElementById('apiTokenRow');
  const noticeEl = document.getElementById('apiTokenPortClosedNotice');
  if (!card || !valueEl) return;
  if (S.glpToken) {
    valueEl.textContent = S.glpToken;
    card.style.display = '';
    if (rowEl) rowEl.style.display = '';
    if (noticeEl) noticeEl.style.display = 'none';
    return;
  }
  if (S.apiPortExposed === false) {
    card.style.display = '';
    if (rowEl) rowEl.style.display = 'none';
    if (noticeEl) noticeEl.style.display = '';
    return;
  }
  card.style.display = 'none';
}

function copyApiToken() {
  if (!S.glpToken) return;
  navigator.clipboard?.writeText(S.glpToken)
    .then(() => window.showToast?.(t('settings_api_token_copied')))
    .catch(() => {});
}

export function wireSettings(): void {
  // Cancel/confirm handlers are wired fresh by openBackupExportModal()/
  // openBackupRestoreModal() every time the modal opens (see
  // components/backup-modal.ts) -- no separate wiring needed here, same
  // convention #scanModal uses (its "Schließen" button is wired once, in
  // main.ts, but this modal's actions depend on which flow opened it).
  document.getElementById('backupRestoreInput')!.addEventListener('change', e => { void openBackupRestoreModal(e.target as HTMLInputElement); });
  document.getElementById('backupDownloadBtn')!.addEventListener('click', openBackupExportModal);
  document.getElementById('devExportDbBtn')?.addEventListener('click', () => { void exportDevDb(); });
  document.getElementById('devImportDbInput')?.addEventListener('change', e => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void importDevDb(file);
    input.value = '';
  });
  document.getElementById('apiTokenCopyBtn')!.addEventListener('click', copyApiToken);
  document.getElementById('addMachineBtn')?.addEventListener('click', () => openMachineForm(null));
  document.getElementById('machineFormCancelBtn')?.addEventListener('click', closeMachineForm);
  document.getElementById('machineFormSaveBtn')?.addEventListener('click', () => { void saveMachineForm(); });
  document.getElementById('machineFormTestBtn')?.addEventListener('click', () => { void testMachineForm(); });
  document.getElementById('restartSetupWizardBtn')?.addEventListener('click', () => openSetupWizard());
  document.getElementById('setupWizardModal')?.addEventListener('click', e => {
    if ((e.target as HTMLElement).id === 'setupWizardModal') closeSetupWizard();
  });
  document.getElementById('machineFormType')?.addEventListener('change', onMachineTypeChange);
  document.getElementById('machineThemeCustomA')?.addEventListener('input', onThemeCustomColorAChange);
  document.getElementById('machineThemeCustomB')?.addEventListener('input', onThemeCustomColorBChange);
  document.getElementById('machineThemeGradientToggle')?.addEventListener('change', onThemeGradientToggleChange);
  document.querySelectorAll<HTMLElement>('#mqttTransportToggle [data-mqtt-transport]').forEach(btn => {
    btn.addEventListener('click', () => setMqttTransport(btn.dataset.mqttTransport!));
  });
  document.getElementById('mqttSaveBtn')?.addEventListener('click', () => { void saveMqttSettings(); });
  document.getElementById('mqttApplyToMachineBtn')?.addEventListener('click', () => { void applyMqttToMachine(); });
  document.getElementById('notifySettingsSaveBtn')?.addEventListener('click', () => { void saveNotifySettings(); });
  document.getElementById('mcpSettingsSaveBtn')?.addEventListener('click', () => { void saveMcpSettings(); });
  // #1288: write/developer tools only apply while the server is on, so their disabled state follows the master toggle.
  document.getElementById('mcpEnabled')?.addEventListener('change', () => renderMcpSettingsCard());
  // #1324: opt-in machine control saves immediately on toggle (there is no Save button).
  document.getElementById('machineControlEnabled')?.addEventListener('change', () => { void saveMachineControlSetting(); });
  document.getElementById('shotDefaultsSaveBtn')?.addEventListener('click', () => { void saveShotDefaultsSettings(); });
}
