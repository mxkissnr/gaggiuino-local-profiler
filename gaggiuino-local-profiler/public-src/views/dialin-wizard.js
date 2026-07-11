// Guided Dial-In wizard (#310) — a step-by-step "set grind → pull shot →
// evaluate → next grind" loop, built on top of the existing passive dial-in
// helpers (calcGrindAdvice etc. in ./shots/grind.js) and the existing
// annotate flow (POST api/shots/:id/annotate). The wizard itself never
// writes shot data directly — it only prefills the same annotate payload
// the manual panel would send.
//
// Session state (S.dialinSession) is client-only and mirrored to
// localStorage.glp_dialin_session (see state.js) so a reload mid-session
// doesn't lose progress. It only ever references real shot ids; annotation
// data lives on the shot itself via the normal annotate endpoint.
import { S }                     from '../state.js';
import { t }                     from '../i18n.js';
import { apiFetch }              from '../api.js';
import { esc, detectChanneling, calcBrewRatio } from '../utils.js';
import { getShotData, calcShotScore } from './shots/utils.js';
import { calcBestGrindCombosForBean, _miniShotChart, _parseGrindNum } from './shots/grind.js';
import { calcNextGrindSuggestion, isConverged } from '../dialin-convergence.js';
import { renderSidebar, updateSidebarHighlighting } from '../components/sidebar.js';

const POLL_MS = 3000;
let _pollTimer = null;

function _persist() {
  if (S.dialinSession) localStorage.setItem('glp_dialin_session', JSON.stringify(S.dialinSession));
  else localStorage.removeItem('glp_dialin_session');
}

function _startPoll() {
  _stopPoll();
  _pollTimer = setInterval(() => {
    if (!S.dialinSession || S.dialinSession.status !== 'active') return;
    renderDialinWizard();
  }, POLL_MS);
}

function _stopPoll() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
}

// ── Open / close ────────────────────────────────────────────────────────

// prefill: { beanName, grinderName, dose, startGrind, recipeId }
export function openDialinWizard(prefill = {}) {
  if (!S.dialinSession || S.dialinSession.status !== 'active') {
    const bean = prefill.beanName
      ? S.coffeeLibrary?.beans?.find(b => b.name === prefill.beanName)
      : null;
    const startGrind = prefill.startGrind ?? _suggestStartGrind(prefill.beanName, prefill.grinderName);
    S.dialinSession = {
      id: Date.now(),
      startedAt: Date.now(),
      bean: prefill.beanName || '',
      grinder: prefill.grinderName || bean?.knownGrindSettings?.[0]?.grinder || '',
      dose: prefill.dose ?? '',
      targetRatio: bean?.brewRatio ? _parseRatio(bean.brewRatio) : 2,
      recipeId: prefill.recipeId ?? null,
      startGrind: startGrind ?? '',
      rounds: [],
      pendingGrind: startGrind ?? '',
      candidateShotId: null,
      reviewRound: null,
      awaitingShotSince: null,
      status: 'setup',
    };
    _persist();
  }
  document.getElementById('dialinWizardModal').classList.add('open');
  document.getElementById('dialinWizardModal').style.display = 'flex';
  renderDialinWizard();
  _startPoll();
}

// Bean-card entry point (library.js's start-dialin-from-bean button) —
// prefills the bean and, if known, the grinder from bean.knownGrindSettings.
export function startDialinFromBean(beanId) {
  const bean = S.coffeeLibrary?.beans?.find(b => b.id === beanId);
  if (!bean) return;
  openDialinWizard({
    beanName: bean.name,
    grinderName: bean.knownGrindSettings?.[0]?.grinder || '',
  });
}

export function closeDialinWizard() {
  document.getElementById('dialinWizardModal').classList.remove('open');
  document.getElementById('dialinWizardModal').style.display = 'none';
  _stopPoll();
}

function _parseRatio(brewRatio) {
  const m = String(brewRatio || '').trim().match(/^1\s*:\s*([\d.]+)$/);
  const n = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 2;
}

// Starting-grind heuristic (plan §1): best historical (grinder, grind)
// combo for the bean, else the bean's known-good grind for this grinder,
// else the most recent shot on this grinder, else empty.
function _suggestStartGrind(beanName, grinderName) {
  if (beanName) {
    const combos = calcBestGrindCombosForBean(beanName, S.shots);
    if (combos?.length) {
      const combo = grinderName
        ? combos.find(c => c.grinder.toLowerCase() === grinderName.toLowerCase()) || combos[0]
        : combos[0];
      if (combo) return combo.grindSetting;
    }
    const bean = S.coffeeLibrary?.beans?.find(b => b.name === beanName);
    const known = bean?.knownGrindSettings?.find(k =>
      !grinderName || k.grinder.toLowerCase() === grinderName.toLowerCase());
    if (known) return _parseGrindNum(known.grindSetting);
  }
  if (grinderName) {
    const last = [...S.shots]
      .filter(s => (s.annotation?.grinder || '').toLowerCase() === grinderName.toLowerCase())
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    const g = _parseGrindNum(last?.annotation?.grindSetting);
    if (g !== null) return g;
  }
  return null;
}

// ── Round evaluation ────────────────────────────────────────────────────

function _evalShot(shot) {
  const data  = getShotData(shot);
  const secs  = (shot.duration || 0) / 10;
  const pTimes = data.pressure.map(p => p.x);
  const pAll   = data.pressure.map(p => p.y);
  const channeling = detectChanneling(pTimes, pAll);
  const ratio = calcBrewRatio(shot, data);
  const score = calcShotScore(shot, data);
  return { secs, channeling, ratio, score };
}

// ── Actions (data-action wiring, see main.js) ──────────────────────────

// Setup step's "Start round 1" reuses the same action as "accept & move
// to the next round" — both mean "lock in the current grind and start
// waiting for a shot".
export function dialinAcceptNext() {
  const s = S.dialinSession;
  if (!s) return;

  if (s.status === 'setup') {
    s.bean        = document.getElementById('dwBean')?.value.trim() || '';
    s.grinder     = document.getElementById('dwGrinder')?.value.trim() || '';
    s.dose        = parseFloat(document.getElementById('dwDose')?.value) || null;
    s.targetRatio = parseFloat(document.getElementById('dwRatio')?.value) || 2;
    s.pendingGrind = document.getElementById('dwStartGrind')?.value.trim() || '';
    s.startGrind   = s.pendingGrind;
    if (!s.bean || !s.pendingGrind) return;
    s.status = 'active';
    s.awaitingShotSince = Math.floor(Date.now() / 1000);
    _persist();
    renderDialinWizard();
    return;
  }

  if (!s.reviewRound) return;
  s.rounds.push(s.reviewRound);
  const suggestion = calcNextGrindSuggestion(s.rounds);
  s.reviewRound = null;
  s.candidateShotId = null;
  if (isConverged(s.rounds)) {
    s.status = 'converged';
    _persist();
    renderDialinWizard();
    return;
  }
  s.pendingGrind = suggestion.nextGrind ?? s.pendingGrind;
  s.awaitingShotSince = Math.floor(Date.now() / 1000);
  _persist();
  renderDialinWizard();
}

export function dialinOverride() {
  const s = S.dialinSession;
  if (!s || !s.reviewRound) return;
  const input = document.getElementById('dwOverrideInput');
  const val = input?.value.trim();
  if (!val) { input?.focus(); return; }
  s.rounds.push(s.reviewRound);
  s.reviewRound = null;
  s.candidateShotId = null;
  s.pendingGrind = val;
  s.awaitingShotSince = Math.floor(Date.now() / 1000);
  _persist();
  renderDialinWizard();
}

export function dialinEnd() {
  const s = S.dialinSession;
  if (!s) return;
  if (s.reviewRound) { s.rounds.push(s.reviewRound); s.reviewRound = null; }
  s.status = 'ended';
  s.candidateShotId = null;
  _persist();
  renderDialinWizard();
}

// isMatch: '1' confirms the candidate shot as this round's dial-in shot,
// '0' dismisses it (Max sometimes pulls shots for guests mid-session — no
// silent auto-matching, see plan).
export async function dialinConfirmShot(shotId, isMatch) {
  const s = S.dialinSession;
  if (!s || s.status !== 'active') return;

  if (!isMatch) {
    s.dismissedShotIds = s.dismissedShotIds || [];
    s.dismissedShotIds.push(shotId);
    s.candidateShotId = null;
    _persist();
    renderDialinWizard();
    return;
  }

  const shot = S.shots.find(sh => sh.id === shotId);
  if (!shot) return;

  const payload = {
    coffee: s.bean, grinder: s.grinder, grindSetting: String(s.pendingGrind),
    dose: s.dose || null, recipeId: s.recipeId || null,
  };
  try {
    const r = await apiFetch(`api/shots/${shotId}/annotate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (r.ok) {
      const idx = S.shots.findIndex(sh => sh.id === shotId);
      if (idx !== -1) S.shots[idx].annotation = { ...S.shots[idx].annotation, ...payload };
      renderSidebar();
      updateSidebarHighlighting();
    }
  } catch { /* keep going even if the annotate call fails */ }

  const evald = _evalShot(S.shots.find(sh => sh.id === shotId) || shot);
  s.reviewRound = {
    grindSetting: _parseGrindNum(s.pendingGrind) ?? parseFloat(s.pendingGrind) ?? 0,
    shotId, score: evald.score, seconds: evald.secs, ratio: evald.ratio, channeling: evald.channeling,
  };
  s.reviewRound.suggestion = calcNextGrindSuggestion([...s.rounds, s.reviewRound]);
  s.candidateShotId = null;
  _persist();
  renderDialinWizard();
}

export async function dialinSaveKnownGrind() {
  const s = S.dialinSession;
  if (!s) return;
  const bean = S.coffeeLibrary?.beans?.find(b => b.name === s.bean);
  const best = _bestRound(s.rounds);
  if (!bean || !best) return;
  const r = await apiFetch(`api/library/bean/${bean.id}/known-grind`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grinder: s.grinder, grindSetting: best.grindSetting }),
  });
  if (r.ok) {
    const updated = await r.json();
    const idx = S.coffeeLibrary.beans.findIndex(b => b.id === bean.id);
    if (idx !== -1) S.coffeeLibrary.beans[idx] = updated;
    window.showToast?.(t('dialin_wizard_save_known_done'));
    renderDialinWizard();
  }
}

export function dialinClose() {
  closeDialinWizard();
}

function _bestRound(rounds) {
  return [...(rounds || [])]
    .filter(r => r.score != null)
    .sort((a, b) => b.score - a.score)[0] || null;
}

// ── Rendering ────────────────────────────────────────────────────────────

export function renderDialinWizard() {
  const s = S.dialinSession;
  const body = document.getElementById('dwBody');
  if (!body) return;
  if (!s) { body.innerHTML = ''; return; }

  if (s.status === 'setup')                       { body.innerHTML = _renderSetup(s); return; }
  if (s.status === 'converged' || s.status === 'ended') { body.innerHTML = _renderSummary(s); return; }

  // active
  if (!s.candidateShotId && !s.reviewRound) _checkForCandidate(s);
  body.innerHTML = _renderRound(s);
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

function _renderSetup(s) {
  const beans = S.coffeeLibrary?.beans || [];
  return `<div class="dw-setup">
    <div class="lib-form-field">
      <label>${t('dialin_wizard_setup_bean')}</label>
      <input type="text" id="dwBean" list="dwBeanList" value="${esc(s.bean)}">
      <datalist id="dwBeanList">${beans.map(b => `<option value="${esc(b.name)}">`).join('')}</datalist>
    </div>
    <div class="lib-form-field">
      <label>${t('dialin_wizard_setup_grinder')}</label>
      <input type="text" id="dwGrinder" value="${esc(s.grinder)}">
    </div>
    <div class="lib-form-field">
      <label>${t('dialin_wizard_setup_dose')}</label>
      <input type="number" step="0.1" min="0" id="dwDose" value="${s.dose ?? ''}">
    </div>
    <div class="lib-form-field">
      <label>${t('dialin_wizard_setup_ratio')}</label>
      <input type="number" step="0.1" min="0" id="dwRatio" value="${s.targetRatio ?? 2}">
    </div>
    <div class="lib-form-field">
      <label>${t('dialin_wizard_setup_start_grind')}</label>
      <input type="text" id="dwStartGrind" value="${esc(String(s.pendingGrind ?? ''))}">
    </div>
  </div>
  <div class="lib-form-actions">
    <button class="lib-save-btn" data-action="dialin-accept-next">${t('dialin_wizard_setup_start_btn')}</button>
  </div>`;
}

function _renderRound(s) {
  const roundNum = s.rounds.length + 1;
  const chips = _renderChips(s.rounds);

  if (s.reviewRound) {
    const rr  = s.reviewRound;
    const sug = rr.suggestion;
    const sugText = (sug.type === 'finer' || sug.type === 'coarser')
      ? t(sug.reason, rr.grindSetting, sug.nextGrind)
      : t(sug.reason);
    return `<div class="dw-round">
      <div class="dw-round-label">${t('dialin_wizard_round_label', roundNum)}</div>
      <div class="dw-score-row">
        <div class="dw-score-chip" style="background:${_scoreColor(rr.score)}">${rr.score ?? '–'}</div>
        <div class="dw-score-meta">${rr.seconds.toFixed(0)} s${rr.ratio ? ` · 1:${rr.ratio.toFixed(1)}` : ''}${rr.channeling ? ` · ${t('grind_channeling_full')}` : ''}</div>
      </div>
      <div class="dw-suggestion">${esc(sugText)}</div>
      <div class="dw-actions">
        <button class="lib-save-btn" data-action="dialin-accept-next">${t('dialin_wizard_accept_next')}</button>
        <div class="dw-override-row">
          <input type="text" id="dwOverrideInput" placeholder="${t('dialin_wizard_override')}">
          <button class="lib-btn-sm" data-action="dialin-override">${t('dialin_wizard_override')}</button>
        </div>
        <button class="lib-btn-sm del" data-action="dialin-end">${t('dialin_wizard_end')}</button>
      </div>
      ${chips}
    </div>`;
  }

  const candidate = s.candidateShotId ? S.shots.find(sh => sh.id === s.candidateShotId) : null;

  return `<div class="dw-round">
    <div class="dw-round-label">${t('dialin_wizard_round_label', roundNum)}</div>
    <div class="dw-grind-display">${esc(String(s.pendingGrind ?? ''))}</div>
    ${candidate ? `
      <div class="dw-candidate">
        <div class="dw-candidate-title">${t('dialin_wizard_candidate_title')}</div>
        ${_miniShotChart(candidate)}
        <div class="dw-candidate-actions">
          <button class="lib-save-btn" data-action="dialin-confirm-shot" data-id="${candidate.id}" data-match="1">${t('dialin_wizard_candidate_confirm')}</button>
          <button class="lib-btn-sm" data-action="dialin-confirm-shot" data-id="${candidate.id}" data-match="0">${t('dialin_wizard_candidate_reject')}</button>
        </div>
      </div>` : `<div class="dw-waiting">${t('dialin_wizard_waiting')}</div>`}
    <button class="lib-btn-sm del" data-action="dialin-end">${t('dialin_wizard_end')}</button>
    ${chips}
  </div>`;
}

function _renderSummary(s) {
  const best = _bestRound(s.rounds);
  const title = s.status === 'converged' ? t('dialin_wizard_converged_title') : t('dialin_wizard_summary_title');
  const reasonText = s.status === 'converged' && s.rounds.length
    ? t(calcNextGrindSuggestion(s.rounds).reason) : '';
  return `<div class="dw-summary">
    <div class="dw-summary-title">${title}</div>
    ${reasonText ? `<div class="dw-summary-reason">${esc(reasonText)}</div>` : ''}
    ${best ? `<div class="dw-summary-best">
      <div class="dw-score-chip" style="background:${_scoreColor(best.score)}">${best.score}</div>
      <div>${t('dialin_wizard_summary_best')}: ${esc(String(best.grindSetting))} · ${best.seconds.toFixed(0)} s</div>
    </div>` : ''}
    <div class="dw-actions">
      ${best ? `<button class="lib-save-btn" data-action="dialin-save-known-grind">${t('dialin_wizard_save_known')}</button>` : ''}
      ${best ? `<button class="lib-btn-sm" data-action="goto-shot" data-id="${best.shotId}">${t('dialin_wizard_goto_shot')}</button>` : ''}
      <button class="lib-btn-sm" data-action="dialin-close">${t('dialin_wizard_continue')}</button>
    </div>
    ${_renderChips(s.rounds)}
  </div>`;
}

function _renderChips(rounds) {
  if (!rounds?.length) return '';
  return `<div class="dw-chip-strip">${rounds.map(r =>
    `<div class="dw-chip" style="border-color:${_scoreColor(r.score)}">${esc(String(r.grindSetting))} → ${r.score ?? '–'}</div>`
  ).join('')}</div>`;
}

function _scoreColor(score) {
  if (score == null) return '#52525b';
  if (score >= 80) return '#22c55e';
  if (score >= 60) return '#eab308';
  return '#ef4444';
}
