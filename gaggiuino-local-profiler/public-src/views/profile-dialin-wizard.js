// Profile Dial-In wizard (#313) — sibling to dialin-wizard.js (the grind
// wizard), same session/polling/candidate-confirm architecture, adapted for
// tuning a machine profile's phases instead of a single grind number.
//
// v1 SCOPE (see ~/.claude/plans/glp-profile-dialin-phase2.md): the primary
// tuning signal is a manual taste-symptom pick per round (sour/balanced/
// bitter/watery/channeling), mapped to a concrete phase/field adjustment via
// profile-dialin-convergence.js's symptom table (itself grounded in the
// coffee-expert skill). calcShotScore is the objective secondary signal,
// used only for convergence detection. shot.profile.phases is intentionally
// NOT parsed here — its field shape is unverified against real hardware.
//
// Every accepted round PUTs the updated profile straight back to the
// machine (api/machine/profile/:id) before the next round starts waiting —
// there's no separate "save" step, the machine is always in sync with the
// session's current profile.
import { S }             from '../state.js';
import { t }              from '../i18n.js';
import { apiFetch }       from '../api.js';
import { esc }            from '../utils.js';
import { getShotData, calcShotScore } from './shots/utils.js';
import { _miniShotChart } from './shots/grind.js';
import { suggestPhaseAdjustment, applyPhaseAdjustment, isProfileDialinConverged, profileDialinConvergenceReason }
  from '../profile-dialin-convergence.js';

const POLL_MS = 3000;
let _pollTimer = null;

function _persist() {
  if (S.profileDialinSession) localStorage.setItem('glp_profile_dialin_session', JSON.stringify(S.profileDialinSession));
  else localStorage.removeItem('glp_profile_dialin_session');
}

function _startPoll() {
  _stopPoll();
  _pollTimer = setInterval(() => {
    if (!S.profileDialinSession || S.profileDialinSession.status !== 'active') return;
    renderProfileDialinWizard();
  }, POLL_MS);
}

function _stopPoll() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
}

// ── Open / close ────────────────────────────────────────────────────────

// profile: the full profile object as returned by GET /api/machine/profile/:id
// (must include a real `id` — dial-in PUTs updates back to that id).
export function openProfileDialinWizard(profile) {
  if (!profile?.id) return;
  if (!S.profileDialinSession || S.profileDialinSession.status !== 'active' || S.profileDialinSession.profileId !== profile.id) {
    S.profileDialinSession = {
      id: Date.now(),
      startedAt: Date.now(),
      profileId: profile.id,
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
    _persist();
  }
  document.getElementById('profileDialinWizardModal').classList.add('open');
  document.getElementById('profileDialinWizardModal').style.display = 'flex';
  renderProfileDialinWizard();
  _startPoll();
}

// Profile-list entry point ("🎯" row action) — fetches the full profile
// (the list only holds {id, name}) before opening, since dial-in needs the
// real phases to compute suggestions against.
export async function startProfileDialinFromList(id) {
  const r = await apiFetch(`api/machine/profile/${id}`);
  if (!r.ok) { window.showToast?.(t('profile_load_error')); return; }
  const profile = await r.json();
  openProfileDialinWizard(profile);
}

export function closeProfileDialinWizard() {
  document.getElementById('profileDialinWizardModal').classList.remove('open');
  document.getElementById('profileDialinWizardModal').style.display = 'none';
  _stopPoll();
}

export function profileDialinClose() {
  closeProfileDialinWizard();
}

// ── Actions (data-action wiring, see main.js) ──────────────────────────

// Toggles a symptom in the current round's pending pick set. "balanced" is
// exclusive with every other symptom (matches the priority table in
// profile-dialin-convergence.js, where balanced only ever wins alone).
export function profileDialinToggleSymptom(symptom) {
  const s = S.profileDialinSession;
  if (!s || !s.reviewRound) return;
  let picks = s.pendingSymptoms || [];
  if (symptom === 'balanced') {
    picks = picks.includes('balanced') ? [] : ['balanced'];
  } else {
    picks = picks.includes('balanced') ? [symptom] : (picks.includes(symptom) ? picks.filter(p => p !== symptom) : [...picks, symptom]);
  }
  s.pendingSymptoms = picks;
  s.reviewRound.suggestion = picks.length ? suggestPhaseAdjustment(picks, s.profile, s.rounds) : null;
  _persist();
  renderProfileDialinWizard();
}

async function _sendUpdatedProfile(s, nextProfile) {
  const r = await apiFetch(`api/machine/profile/${s.profileId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nextProfile),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    window.showToast?.(t('profile_send_error') + (body.error ? `: ${body.error}` : ''));
    return false;
  }
  s.profile = nextProfile;
  return true;
}

export async function profileDialinAcceptNext() {
  const s = S.profileDialinSession;
  if (!s || !s.reviewRound || !s.reviewRound.suggestion) return;

  const sug = s.reviewRound.suggestion;
  const round = {
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
    _persist();
    renderProfileDialinWizard();
    return;
  }
  s.awaitingShotSince = Math.floor(Date.now() / 1000);
  _persist();
  renderProfileDialinWizard();
}

// Lets the user type a different target value for the SAME field the
// algorithm suggested, rather than accepting its computed step — mirrors
// the grind wizard's override (a manual number, not a different strategy).
export async function profileDialinOverride() {
  const s = S.profileDialinSession;
  if (!s || !s.reviewRound || !s.reviewRound.suggestion || s.reviewRound.suggestion.type !== 'adjust') return;
  const input = document.getElementById('pdwOverrideInput');
  const val = parseFloat(input?.value);
  if (!Number.isFinite(val)) { input?.focus(); return; }

  const sug = { ...s.reviewRound.suggestion, newValue: val, delta: Math.round((val - s.reviewRound.suggestion.oldValue) * 1000) / 1000 };
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
    _persist();
    renderProfileDialinWizard();
    return;
  }
  s.awaitingShotSince = Math.floor(Date.now() / 1000);
  _persist();
  renderProfileDialinWizard();
}

export function profileDialinEnd() {
  const s = S.profileDialinSession;
  if (!s) return;
  s.status = 'ended';
  s.candidateShotId = null;
  _persist();
  renderProfileDialinWizard();
}

// isMatch: '1' confirms the candidate as this round's dial-in shot, '0'
// dismisses it — no silent auto-matching, same reasoning as the grind
// wizard (Max sometimes pulls shots for guests mid-session).
export function profileDialinConfirmShot(shotId, isMatch) {
  const s = S.profileDialinSession;
  if (!s || s.status !== 'active') return;

  if (!isMatch) {
    s.dismissedShotIds = s.dismissedShotIds || [];
    s.dismissedShotIds.push(shotId);
    s.candidateShotId = null;
    _persist();
    renderProfileDialinWizard();
    return;
  }

  const shot = S.shots.find(sh => sh.id === shotId);
  if (!shot) return;
  const score = calcShotScore(shot, getShotData(shot));
  s.reviewRound = { shotId, score, suggestion: null };
  s.pendingSymptoms = [];
  s.candidateShotId = null;
  _persist();
  renderProfileDialinWizard();
}

function _checkForCandidate(s) {
  if (!s.awaitingShotSince) return;
  const dismissed = new Set(s.dismissedShotIds || []);
  const already   = new Set((s.rounds || []).map(r => r.shotId));
  const candidate = [...S.shots]
    .filter(sh => !sh._trashed && sh.timestamp >= s.awaitingShotSince && !dismissed.has(sh.id) && !already.has(sh.id))
    .sort((a, b) => a.timestamp - b.timestamp)[0];
  if (candidate) s.candidateShotId = candidate.id;
}

// ── Rendering ────────────────────────────────────────────────────────────

const SYMPTOMS = ['balanced', 'sour', 'bitter', 'watery', 'channeling'];

export function renderProfileDialinWizard() {
  const s = S.profileDialinSession;
  const body = document.getElementById('pdwBody');
  if (!body) return;
  if (!s) { body.innerHTML = ''; return; }

  if (s.status === 'converged' || s.status === 'ended') { body.innerHTML = _renderSummary(s); return; }

  if (!s.candidateShotId && !s.reviewRound) _checkForCandidate(s);
  body.innerHTML = _renderRound(s);
}

function _renderRound(s) {
  const roundNum = s.rounds.length + 1;
  const chips = _renderChips(s.rounds);

  if (s.reviewRound) {
    const rr = s.reviewRound;
    const sug = rr.suggestion;
    const symptomButtons = SYMPTOMS.map(sym => `<button type="button" class="pdw-symptom-btn${(s.pendingSymptoms || []).includes(sym) ? ' active' : ''}" data-action="profile-dialin-symptom" data-symptom="${sym}">${t('profile_dialin_symptom_' + sym)}</button>`).join('');

    let suggestionBlock = '';
    if (sug) {
      if (sug.type === 'adjust') {
        const text = t(sug.reason, sug.phaseName || t('profile_dialin_generic_field'), sug.oldValue, sug.newValue, sug.unit || '');
        suggestionBlock = `<div class="dw-suggestion">${esc(text)}</div>
          <div class="dw-actions">
            <button class="lib-save-btn" data-action="profile-dialin-accept-next">${t('profile_dialin_accept_next')}</button>
            <div class="dw-override-row">
              <input type="number" step="0.1" id="pdwOverrideInput" placeholder="${sug.newValue}">
              <button class="lib-btn-sm" data-action="profile-dialin-override">${t('dialin_wizard_override')}</button>
            </div>
          </div>`;
      } else {
        suggestionBlock = `<div class="dw-suggestion">${esc(t(sug.reason))}</div>
          <div class="dw-actions"><button class="lib-save-btn" data-action="profile-dialin-accept-next">${t('profile_dialin_accept_next')}</button></div>`;
      }
    }

    return `<div class="dw-round">
      <div class="dw-round-label">${t('dialin_wizard_round_label', roundNum)}</div>
      <div class="dw-score-row">
        <div class="dw-score-chip" style="background:${_scoreColor(rr.score)}">${rr.score ?? '–'}</div>
      </div>
      <div class="pdw-symptom-label">${t('profile_dialin_symptom_prompt')}</div>
      <div class="pdw-symptom-row">${symptomButtons}</div>
      ${suggestionBlock}
      <button class="lib-btn-sm del" data-action="profile-dialin-end">${t('dialin_wizard_end')}</button>
      ${chips}
    </div>`;
  }

  const candidate = s.candidateShotId ? S.shots.find(sh => sh.id === s.candidateShotId) : null;

  return `<div class="dw-round">
    <div class="dw-round-label">${t('dialin_wizard_round_label', roundNum)}</div>
    <div class="pdw-profile-name">${esc(s.profileName)}</div>
    ${candidate ? `
      <div class="dw-candidate">
        <div class="dw-candidate-title">${t('dialin_wizard_candidate_title')}</div>
        ${_miniShotChart(candidate)}
        <div class="dw-candidate-actions">
          <button class="lib-save-btn" data-action="profile-dialin-confirm-shot" data-id="${candidate.id}" data-match="1">${t('dialin_wizard_candidate_confirm')}</button>
          <button class="lib-btn-sm" data-action="profile-dialin-confirm-shot" data-id="${candidate.id}" data-match="0">${t('dialin_wizard_candidate_reject')}</button>
        </div>
      </div>` : `<div class="dw-waiting">${t('dialin_wizard_waiting')}</div>`}
    <button class="lib-btn-sm del" data-action="profile-dialin-end">${t('dialin_wizard_end')}</button>
    ${chips}
  </div>`;
}

function _renderSummary(s) {
  const best = _bestRound(s.rounds);
  const title = s.status === 'converged' ? t('dialin_wizard_converged_title') : t('dialin_wizard_summary_title');
  const reasonText = s.status === 'converged' && s.rounds.length ? t(profileDialinConvergenceReason(s.rounds)) : '';
  return `<div class="dw-summary">
    <div class="dw-summary-title">${title}</div>
    ${reasonText ? `<div class="dw-summary-reason">${esc(reasonText)}</div>` : ''}
    ${best ? `<div class="dw-summary-best">
      <div class="dw-score-chip" style="background:${_scoreColor(best.score)}">${best.score}</div>
      <div>${t('profile_dialin_summary_best')}</div>
    </div>` : ''}
    <div class="dw-actions">
      ${best ? `<button class="lib-btn-sm" data-action="goto-shot" data-id="${best.shotId}">${t('dialin_wizard_goto_shot')}</button>` : ''}
      <button class="lib-btn-sm" data-action="profile-dialin-close">${t('dialin_wizard_continue')}</button>
    </div>
    ${_renderChips(s.rounds)}
  </div>`;
}

function _renderChips(rounds) {
  if (!rounds?.length) return '';
  return `<div class="dw-chip-strip">${rounds.map(r =>
    `<div class="dw-chip" style="border-color:${_scoreColor(r.score)}">${esc(t('profile_dialin_symptom_' + r.symptom))} → ${r.score ?? '–'}</div>`
  ).join('')}</div>`;
}

function _bestRound(rounds) {
  return [...(rounds || [])].filter(r => r.score != null).sort((a, b) => b.score - a.score)[0] || null;
}

function _scoreColor(score) {
  if (score == null) return '#52525b';
  if (score >= 80) return '#22c55e';
  if (score >= 60) return '#eab308';
  return '#ef4444';
}
