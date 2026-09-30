// First-run setup wizard (#744) — a 3-step onboarding modal (welcome ->
// connect a machine -> done) shown once when the app has zero machines
// configured. Modeled on the Guided Dial-In wizard's architecture
// (./dialin-wizard.js: session-state-on-S, open/close/render functions, a
// modal driven by a CSS class) but simpler — there's no live shot data to
// poll for, so no timer loop.
//
// Step 2 (connect a machine) deliberately does NOT rebuild the add-machine
// form/test-connect logic: it reparents the real, singleton
// #machineFormCard node (public-src/components/machines-settings.js) into
// its own slot for the duration of that step, then moves it back to its
// original place in Settings the moment the wizard leaves that step (via
// _leaveConnectStep(), called at the top of every render()). This means
// #machineFormSaveBtn/#machineFormTestBtn keep working unmodified (main.js
// wires them once, directly to saveMachineForm()/testMachineForm()) and the
// SSRF-guard error surfacing, id-rewrite-on-success and staleness guards
// documented in machines-settings.js all apply here for free.
import { S, subscribe } from '../state/index.js';
import type { MachineRecord } from '../state/index.js';
import { tHtml } from '../i18n.js';
import { html, COMPLETED_KEY } from '../utils.js';
import type { Html } from '../utils.js';
import { openMachineForm } from '../components/machines-settings.js';
import { loadDemoData } from '../components/onboarding.js';

// Captured once, the first time the wizard ever reaches the connect step —
// #machineFormCard's original position in the Settings "Machines" card, so
// _leaveConnectStep() can put it back exactly where it came from.
let _formOrigParent: Node | null = null;
let _formOrigNextSibling: Node | null = null;

// Pure trigger check (#744) — no DOM/localStorage side effects beyond the
// read, so main.js's init sequence (and tests) can call it directly against
// S.machines without needing a real document.
//
// #746: triggers on "no machine has a configured host", not "zero machine
// rows" — registry.ensureDefaultMachine() (lib/machines/registry.js) always
// seeds an empty-host default machine #1 on a fresh DB, called on every
// GET /api/machines, so a real fresh install's S.machines is never actually
// empty by the time the frontend checks it.
export function shouldOpenSetupWizard(machines: MachineRecord[] | null | undefined): boolean {
  return (machines || []).every(m => !m?.host) && !localStorage.getItem(COMPLETED_KEY);
}

// #750: syncInstallId() now lives in public-src/utils.js —
// components/status.js calls it from updateStatus() without importing this
// wizard module back (import-cycle #1102). Re-exported here for existing
// importers (e.g. test/setup-wizard.test.js).
export { syncInstallId } from '../utils.js';

export function openSetupWizard(): void {
  S.setupWizardStep = 'welcome';
  S.setupWizardOpen = true;
  const modal = document.getElementById('setupWizardModal');
  if (modal) { modal.classList.add('open'); modal.style.display = 'flex'; }
  renderSetupWizard();
}

// Used by the header's X button, the welcome step's "Later" link, and the
// done step's own closing button — "Later" (and any close before reaching
// done) must NOT set the completed flag, so the wizard reappears next
// launch; only closing from the done step marks it complete.
export function closeSetupWizard(): void {
  if (S.setupWizardStep === 'done') {
    try { localStorage.setItem(COMPLETED_KEY, '1'); } catch { /* ignore */ }
  }
  S.setupWizardOpen = false;
  _leaveConnectStep();
  const modal = document.getElementById('setupWizardModal');
  if (modal) { modal.classList.remove('open'); modal.style.display = 'none'; }
}

export function setupWizardGetStarted(): void {
  S.setupWizardStep = 'connect';
  renderSetupWizard();
}

// "I don't have a machine yet, show me demo data" — seeds demo data via the
// existing onboarding.js helper and skips straight to the done step,
// regardless of whether a real machine ever gets configured.
export async function setupWizardSkipToDemo(): Promise<void> {
  await loadDemoData();
  S.setupWizardStep = 'done';
  renderSetupWizard();
}

// Auto-advances connect -> done, but only on an explicit "Save" — NOT on
// Test-connection's implicit save-before-test (#729/#733).
//
// #748: this used to subscribe to the generic 'machines' state instead,
// which both saveMachineForm() and testMachineForm() trigger indirectly via
// loadMachines() on success. That meant clicking "Test connection" advanced
// (and effectively closed) the wizard before the user ever saw the test
// result. saveMachineForm() now setState()s this dedicated
// 'machineExplicitSave' signal itself, which testMachineForm() never touches,
// so only a real Save can complete this step.
//
// The signal is deliberately absent from AppState (machines-settings.ts
// writes it through the same Parameters<typeof setState>[0] escape hatch),
// so the key is cast here to match.
subscribe('machineExplicitSave' as Parameters<typeof subscribe>[0], id => {
  if (S.setupWizardOpen && S.setupWizardStep === 'connect' && id) {
    S.setupWizardStep = 'done';
    renderSetupWizard();
  }
});

export function renderSetupWizard(): void {
  const body = document.getElementById('swBody');
  if (!body) return;
  // Always leave the connect step's reused form node *before* touching
  // #swBody's innerHTML — overwriting the innerHTML of an ancestor of
  // #machineFormCard would detach (and orphan) it, since reassigning
  // .innerHTML tears down the previous subtree.
  _leaveConnectStep();
  if (S.setupWizardStep === 'welcome') { body.innerHTML = _renderWelcome(); return; }
  if (S.setupWizardStep === 'done')    { body.innerHTML = _renderDone(); return; }
  body.innerHTML = _renderConnectShell();
  _enterConnectStep();
}

function _enterConnectStep(): void {
  const slot = document.getElementById('swConnectFormSlot');
  const card = document.getElementById('machineFormCard');
  if (!slot || !card) return;
  if (!_formOrigParent) { _formOrigParent = card.parentNode; _formOrigNextSibling = card.nextSibling; }
  // #748: edit the already-seeded default machine (registry.ensureDefaultMachine())
  // instead of always opening a blank "new machine" form — openMachineForm(null)
  // here used to POST a brand new machine on save/test, leaving the user with
  // both the empty-host default and the one they just configured.
  const defaultMachine = (S.machines || []).find(m => m.isDefault) || null;
  openMachineForm(defaultMachine);
  slot.appendChild(card);
  // Cancel only makes sense inside the Settings card it normally lives in —
  // here it's replaced by the wizard's own close (X) / demo-data escape
  // hatches, which (unlike closeMachineForm()) close the whole wizard.
  const cancelBtn = document.getElementById('machineFormCancelBtn');
  if (cancelBtn) cancelBtn.style.display = 'none';
}

function _leaveConnectStep(): void {
  const card = document.getElementById('machineFormCard');
  const origParent = _formOrigParent;
  if (!card || !origParent || card.parentNode === origParent) return;
  card.style.display = 'none';
  const cancelBtn = document.getElementById('machineFormCancelBtn');
  if (cancelBtn) cancelBtn.style.display = '';
  origParent.insertBefore(card, _formOrigNextSibling);
}

function _renderWelcome(): Html {
  return html`<div class="dw-summary">
    <div class="dw-summary-title">${tHtml('setup_wizard_welcome_title')}</div>
    <div class="dw-summary-reason">${tHtml('setup_wizard_welcome_body')}</div>
    <div class="dw-actions">
      <button class="lib-save-btn" data-action="setup-wizard-get-started">${tHtml('setup_wizard_get_started')}</button>
      <button class="lib-btn-sm" data-action="setup-wizard-close">${tHtml('setup_wizard_later')}</button>
    </div>
  </div>`;
}

function _renderConnectShell(): Html {
  return html`<div class="dw-setup">
    <div class="dw-summary-reason">${tHtml('setup_wizard_connect_body')}</div>
    <div id="swConnectFormSlot"></div>
    <button type="button" class="lib-btn-sm" data-action="setup-wizard-skip-demo">${tHtml('setup_wizard_demo_link')}</button>
  </div>`;
}

function _renderDone(): Html {
  return html`<div class="dw-summary">
    <div class="dw-summary-title">${tHtml('setup_wizard_done_title')}</div>
    <div class="dw-summary-reason">${tHtml('setup_wizard_done_body')}</div>
    <div class="dw-actions">
      <button class="lib-save-btn" data-action="setup-wizard-close">${tHtml('setup_wizard_done_btn')}</button>
    </div>
  </div>`;
}
