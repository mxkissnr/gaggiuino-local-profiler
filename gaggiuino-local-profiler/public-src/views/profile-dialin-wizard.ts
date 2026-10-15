// Profile Dial-In wizard (#313) — sibling to dialin-wizard.js (the grind
// wizard), same session/polling/candidate-confirm architecture, adapted for
// tuning a machine profile's phases instead of a single grind number.
//
// v1 SCOPE: the primary tuning signal is a manual taste-symptom pick per
// round (sour/balanced/bitter/watery/channeling), mapped to a concrete
// phase/field adjustment via profile-dialin-convergence.js's symptom table.
// calcShotScore is the objective secondary signal, used only for convergence
// detection. shot.profile.phases is intentionally NOT parsed here — its field
// shape is unverified against real hardware.
//
// Every accepted round PUTs the updated profile straight back to the
// machine (api/machine/profile/:id) before the next round starts waiting —
// there's no separate "save" step, the machine is always in sync with the
// session's current profile.
import { S, concreteActiveMachineId } from '../state/index.js';
import { t, tHtml }        from '../i18n.js';
import * as machinesApi from '../api/machines.js';
import { esc, html, joinHtml, scoreColor } from '../utils.js';
import type { Html } from '../utils.js';
import { calcShotScore } from './shots/utils.js';
import type { ShotLike } from './shots/utils.js';
import { _miniShotChart } from './shots/grind.js';
import { suggestPhaseAdjustment, applyPhaseAdjustment, isProfileDialinConverged, profileDialinConvergenceReason }
  from '../profile-dialin-convergence.js';
import type { ProfileSuggestion } from '../profile-dialin-convergence.js';
import { bestRound, checkForCandidate, createWizardSession, renderChips } from './wizard-session.js';

// state/index.ts types the session as Record<string, unknown> and shot rows
// as metadata-only ShotMeta; these aliases name the fields this wizard
// actually reads/writes, same pattern as views/dialin-wizard.ts.
interface ProfileDialinShotRow extends ShotLike {
  _trashed?: boolean;
}

interface ProfileDialinRound {
  symptom?: string | undefined;
  score: number | null;
  shotId: number;
  appliedAdjustment: { phaseIndex: number | null; field: string | null; delta: number } | null;
}

interface ProfileDialinReviewRound {
  shotId: number;
  score: number | null;
  suggestion: ProfileSuggestion | null;
}

// The full profile object as returned by GET /api/machine/profile/:id (must
// include a real `id` — dial-in PUTs updates back to that id).
interface DialinProfile {
  id?: string | number | null | undefined;
  name?: string | null | undefined;
  [key: string]: unknown;
}

interface ProfileDialinSession extends Record<string, unknown> {
  id: number;
  startedAt: number;
  profileId: string | number;
  // The machine the dial-in was started for; null/undefined means "no explicit
  // machine" ('all'/none selected), so the backend targets the default machine.
  machineId?: number | null;
  profileName: string;
  profile: DialinProfile;
  rounds: ProfileDialinRound[];
  reviewRound: ProfileDialinReviewRound | null;
  pendingSymptoms: string[];
  candidateShotId: number | null;
  dismissedShotIds: number[];
  awaitingShotSince: number | null;
  status: string;
  _profileReqToken?: number;
}

const wizard = createWizardSession<ProfileDialinSession, ProfileDialinShotRow>({
  stateKey: 'profileDialinSession',
  storageKey: 'glp_profile_dialin_session',
  overrideInputId: 'pdwOverrideInput',
  onTick: renderProfileDialinWizard,
});

// ── Open / close ────────────────────────────────────────────────────────

// profile: the full profile object as returned by GET /api/machine/profile/:id
// (must include a real `id` — dial-in PUTs updates back to that id).
export function openProfileDialinWizard(profile: DialinProfile | null | undefined, machineId?: number | null): void {
  if (!profile?.id) return;
  if (!S.profileDialinSession || S.profileDialinSession.status !== 'active' || S.profileDialinSession.profileId !== profile.id) {
    S.profileDialinSession = {
      id: Date.now(),
      startedAt: Date.now(),
      profileId: profile.id,
      machineId: machineId ?? null,
      profileName: profile.name || '',
      profile,
      rounds: [],
      reviewRound: null,
      pendingSymptoms: [],
      candidateShotId: null,
      dismissedShotIds: [],
      awaitingShotSince: Math.floor(Date.now() / 1000),
      status: 'active',
    };
    wizard.persist();
  }
  const modal = document.getElementById('profileDialinWizardModal') as HTMLElement;
  modal.classList.add('open');
  modal.style.display = 'flex';
  renderProfileDialinWizard();
  wizard.startPoll();
}

// Profile-list entry point ("🎯" row action) — fetches the full profile
// (the list only holds {id, name}) before opening, since dial-in needs the
// real phases to compute suggestions against.
export async function startProfileDialinFromList(id: string | number): Promise<void> {
  const machineId = concreteActiveMachineId();
  const profile = await machinesApi.getMachineProfile(id, machineId ?? undefined);
  if (!profile) { window.showToast?.(t('profile_load_error')); return; }
  openProfileDialinWizard(profile, machineId);
}

export function closeProfileDialinWizard(): void {
  const modal = document.getElementById('profileDialinWizardModal') as HTMLElement;
  modal.classList.remove('open');
  modal.style.display = 'none';
  wizard.stopPoll();
}

export function profileDialinClose(): void {
  closeProfileDialinWizard();
}

// ── Actions (data-action wiring, see main.js) ──────────────────────────

// Toggles a symptom in the current round's pending pick set. "balanced" is
// exclusive with every other symptom (matches the priority table in
// profile-dialin-convergence.js, where balanced only ever wins alone).
export function profileDialinToggleSymptom(symptom: string | undefined): void {
  const s = wizard.session();
  if (!s || !s.reviewRound) return;
  // The symptom buttons always carry data-symptom (see main.ts's [data-action]
  // handler), so this narrows to the value the untyped .js already handled.
  const sym = symptom as string;
  let picks = s.pendingSymptoms || [];
  if (sym === 'balanced') {
    picks = picks.includes('balanced') ? [] : ['balanced'];
  } else {
    picks = picks.includes('balanced') ? [sym] : (picks.includes(sym) ? picks.filter(p => p !== sym) : [...picks, sym]);
  }
  s.pendingSymptoms = picks;
  s.reviewRound.suggestion = picks.length ? suggestPhaseAdjustment(picks, s.profile, s.rounds) : null;
  wizard.persist();
  renderProfileDialinWizard();
}

// Guards against a double-click firing profileDialinAcceptNext()/
// profileDialinOverride() again before the first PUT resolves — the token
// lives on the session object `s` itself (not a module-level counter, since
// `s` is the single shared S.profileDialinSession instance callers pass in).
// Only the call that is still current when its response lands writes
// s.profile; a superseded call returns false without a toast (its PUT still
// reached the machine, but the newer call's profile is authoritative).
async function _sendUpdatedProfile(s: ProfileDialinSession, nextProfile: DialinProfile): Promise<boolean> {
  const token = (s._profileReqToken || 0) + 1;
  s._profileReqToken = token;
  // Target the machine the session was opened for, not whatever is active now
  // (#1605). With none captured, send no machineId so the backend uses the
  // default machine.
  const requestBody = s.machineId != null ? { ...nextProfile, machineId: s.machineId } : nextProfile;
  const r = await machinesApi.saveMachineProfile(s.profileId, requestBody);
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    window.showToast?.(t('profile_send_error') + (body.error ? `: ${body.error}` : ''));
    return false;
  }
  if (token !== s._profileReqToken) return false;
  s.profile = nextProfile;
  return true;
}

export async function profileDialinAcceptNext(): Promise<void> {
  const s = wizard.session();
  if (!s || !s.reviewRound || !s.reviewRound.suggestion) return;

  const sug = s.reviewRound.suggestion;
  const round: ProfileDialinRound = {
    symptom: sug.symptom,
    score: s.reviewRound.score,
    shotId: s.reviewRound.shotId,
    appliedAdjustment: sug.type === 'adjust' ? { phaseIndex: sug.phaseIndex, field: sug.field, delta: sug.delta } : null,
  };

  if (sug.type === 'adjust') {
    const nextProfile = applyPhaseAdjustment(s.profile, sug);
    const ok = await _sendUpdatedProfile(s, nextProfile);
    if (!ok) return;
  }

  s.rounds.push(round);
  s.reviewRound = null;
  s.pendingSymptoms = [];
  s.candidateShotId = null;

  if (isProfileDialinConverged(s.rounds)) {
    s.status = 'converged';
    wizard.persist();
    renderProfileDialinWizard();
    return;
  }
  s.awaitingShotSince = Math.floor(Date.now() / 1000);
  wizard.persist();
  renderProfileDialinWizard();
}

// Lets the user type a different target value for the SAME field the
// algorithm suggested, rather than accepting its computed step — mirrors
// the grind wizard's override (a manual number, not a different strategy).
export async function profileDialinOverride(): Promise<void> {
  const s = wizard.session();
  if (!s || !s.reviewRound || !s.reviewRound.suggestion || s.reviewRound.suggestion.type !== 'adjust') return;
  const input = document.getElementById('pdwOverrideInput') as HTMLInputElement | null;
  const val = parseFloat(input?.value as string);
  if (!Number.isFinite(val)) { input?.focus(); return; }

  const sug = { ...s.reviewRound.suggestion, newValue: val, delta: Math.round((val - (s.reviewRound.suggestion.oldValue as number)) * 1000) / 1000 };
  const round = { symptom: sug.symptom, score: s.reviewRound.score, shotId: s.reviewRound.shotId,
    appliedAdjustment: { phaseIndex: sug.phaseIndex, field: sug.field, delta: sug.delta } };

  const nextProfile = applyPhaseAdjustment(s.profile, sug);
  const ok = await _sendUpdatedProfile(s, nextProfile);
  if (!ok) return;
  s.rounds.push(round);
  s.reviewRound = null;
  s.pendingSymptoms = [];
  s.candidateShotId = null;

  if (isProfileDialinConverged(s.rounds)) {
    s.status = 'converged';
    wizard.persist();
    renderProfileDialinWizard();
    return;
  }
  s.awaitingShotSince = Math.floor(Date.now() / 1000);
  wizard.persist();
  renderProfileDialinWizard();
}

export function profileDialinEnd(): void {
  const s = wizard.session();
  if (!s) return;
  s.status = 'ended';
  s.candidateShotId = null;
  wizard.persist();
  renderProfileDialinWizard();
}

// isMatch: '1' confirms the candidate as this round's dial-in shot, '0'
// dismisses it — no silent auto-matching, same reasoning as the grind
// wizard (Max sometimes pulls shots for guests mid-session).
export function profileDialinConfirmShot(shotId: number, isMatch: boolean): void {
  const s = wizard.session();
  if (!s || s.status !== 'active') return;

  if (!isMatch) {
    s.dismissedShotIds = s.dismissedShotIds || [];
    s.dismissedShotIds.push(shotId);
    s.candidateShotId = null;
    wizard.persist();
    renderProfileDialinWizard();
    return;
  }

  const shot = wizard.shots().find(sh => sh.id === shotId);
  if (!shot) return;
  const score = calcShotScore(shot); // #957: server score on the metadata row, no curve fetch
  s.reviewRound = { shotId, score, suggestion: null };
  s.pendingSymptoms = [];
  s.candidateShotId = null;
  wizard.persist();
  renderProfileDialinWizard();
}

// ── Rendering ────────────────────────────────────────────────────────────

const SYMPTOMS = ['balanced', 'sour', 'bitter', 'watery', 'channeling'];

export function renderProfileDialinWizard(): void {
  const s = wizard.session();
  const body = document.getElementById('pdwBody');
  if (!body) return;
  if (!s) { body.innerHTML = html``; return; }

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  if (s.status === 'converged' || s.status === 'ended') { body.innerHTML = _renderSummary(s); return; }

  if (!s.candidateShotId && !s.reviewRound) checkForCandidate(s, wizard.shots());
  // #957: the candidate mini-chart needs its curve — fetch then re-render.
  if (s.candidateShotId && window.getRawCurve && !window.getRawCurve(s.candidateShotId)) {
    const pendingId = s.candidateShotId;
    void window.getShotCurve?.(pendingId).then(() => {
      if (S.profileDialinSession?.candidateShotId === pendingId) renderProfileDialinWizard();
    });
  }
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  body.innerHTML = _renderRound(s);
}

function _renderRound(s: ProfileDialinSession): Html {
  const roundNum = s.rounds.length + 1;
  const chips = renderChips(s.rounds, r => tHtml('profile_dialin_symptom_' + String(r.symptom)));

  if (s.reviewRound) {
    const rr = s.reviewRound;
    const sug = rr.suggestion;
    const symptomButtons = joinHtml(SYMPTOMS.map(sym => html`<button type="button" class="pdw-symptom-btn${esc((s.pendingSymptoms || []).includes(sym) ? ' active' : '')}" data-action="profile-dialin-symptom" data-symptom="${esc(sym)}">${tHtml('profile_dialin_symptom_' + sym)}</button>`));

    let suggestionBlock: Html = html``;
    if (sug) {
      if (sug.type === 'adjust') {
        const text = t(sug.reason, sug.phaseName || t('profile_dialin_generic_field'), sug.oldValue, sug.newValue, sug.unit || '');
        suggestionBlock = html`<div class="dw-suggestion">${esc(text)}</div>
          <div class="dw-actions">
            <button class="lib-save-btn" data-action="profile-dialin-accept-next">${tHtml('profile_dialin_accept_next')}</button>
            <div class="dw-override-row">
              <input type="number" step="0.1" id="pdwOverrideInput" aria-label="${esc(t('dialin_wizard_override'))}" placeholder="${esc(sug.newValue)}">
              <button class="lib-btn-sm" data-action="profile-dialin-override">${tHtml('dialin_wizard_override')}</button>
            </div>
          </div>`;
      } else {
        suggestionBlock = html`<div class="dw-suggestion">${esc(t(sug.reason))}</div>
          <div class="dw-actions"><button class="lib-save-btn" data-action="profile-dialin-accept-next">${tHtml('profile_dialin_accept_next')}</button></div>`;
      }
    }

    return html`<div class="dw-round">
      <div class="dw-round-label">${tHtml('dialin_wizard_round_label', roundNum)}</div>
      <div class="dw-score-row">
        <div class="dw-score-chip" style="background:${esc(scoreColor(rr.score))}">${esc(rr.score ?? '–')}</div>
      </div>
      <div class="pdw-symptom-label">${tHtml('profile_dialin_symptom_prompt')}</div>
      <div class="pdw-symptom-row">${symptomButtons}</div>
      ${suggestionBlock}
      <button class="lib-btn-sm del" data-action="profile-dialin-end">${tHtml('dialin_wizard_end')}</button>
      ${chips}
    </div>`;
  }

  const candidate = s.candidateShotId ? wizard.shots().find(sh => sh.id === s.candidateShotId) : null;

  return html`<div class="dw-round">
    <div class="dw-round-label">${tHtml('dialin_wizard_round_label', roundNum)}</div>
    <div class="pdw-profile-name">${esc(s.profileName)}</div>
    ${candidate ? html`
      <div class="dw-candidate">
        <div class="dw-candidate-title">${tHtml('dialin_wizard_candidate_title')}</div>
        ${_miniShotChart(candidate)}
        <div class="dw-candidate-actions">
          <button class="lib-save-btn" data-action="profile-dialin-confirm-shot" data-id="${esc(candidate.id)}" data-match="1">${tHtml('dialin_wizard_candidate_confirm')}</button>
          <button class="lib-btn-sm" data-action="profile-dialin-confirm-shot" data-id="${esc(candidate.id)}" data-match="0">${tHtml('dialin_wizard_candidate_reject')}</button>
        </div>
      </div>` : html`<div class="dw-waiting">${tHtml('dialin_wizard_waiting')}</div>`}
    <button class="lib-btn-sm del" data-action="profile-dialin-end">${tHtml('dialin_wizard_end')}</button>
    ${chips}
  </div>`;
}

function _renderSummary(s: ProfileDialinSession): Html {
  const best = bestRound(s.rounds);
  const title = s.status === 'converged' ? t('dialin_wizard_converged_title') : t('dialin_wizard_summary_title');
  const reasonText = s.status === 'converged' && s.rounds.length ? t(profileDialinConvergenceReason(s.rounds)) : '';
  return html`<div class="dw-summary">
    <div class="dw-summary-title">${esc(title)}</div>
    ${reasonText ? html`<div class="dw-summary-reason">${esc(reasonText)}</div>` : html``}
    ${best ? html`<div class="dw-summary-best">
      <div class="dw-score-chip" style="background:${esc(scoreColor(best.score))}">${esc(best.score)}</div>
      <div>${tHtml('profile_dialin_summary_best')}</div>
    </div>` : html``}
    <div class="dw-actions">
      ${best ? html`<button class="lib-btn-sm" data-action="goto-shot" data-id="${esc(best.shotId)}">${tHtml('dialin_wizard_goto_shot')}</button>` : html``}
      <button class="lib-btn-sm" data-action="profile-dialin-close">${tHtml('dialin_wizard_continue')}</button>
    </div>
    ${renderChips(s.rounds, r => tHtml('profile_dialin_symptom_' + String(r.symptom)))}
  </div>`;
}

