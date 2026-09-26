// Guided Dial-In wizard (#310) — a step-by-step "set grind → pull shot →
// evaluate → next grind" loop, built on top of the existing passive dial-in
// helpers (calcGrindAdvice etc. in ./shots/grind.js) and the existing
// annotate flow (POST api/shots/:id/annotate). The wizard itself never
// writes shot data directly — it only prefills the same annotate payload
// the manual panel would send.
//
// Session state (S.dialinSession) is client-only and mirrored to
// localStorage.glp_dialin_session (see state/index.ts) so a reload mid-session
// doesn't lose progress. It only ever references real shot ids; annotation
// data lives on the shot itself via the normal annotate endpoint.
import { S }                     from '../state/index.js';
import { t }                     from '../i18n.js';
import { saveBeanKnownGrind } from '../api/library.js';
import { annotateShot }          from '../api/shots.js';
import type { ShotAnnotation }   from '../api/types.js';
import { esc, detectChanneling, calcBrewRatio, scoreColor } from '../utils.js';
import { calcShotScore } from './shots/utils.js';
import type { ShotLike } from './shots/utils.js';
import { getShotCurve } from '../shot-curves.js';
import { mapShotDatapoints } from '../utils.js';
import { calcBestGrindCombosForBean, _miniShotChart, _parseGrindNum } from './shots/grind.js';
import { normalizeGrindToNow } from '../grind-zero.js';
import { calcNextGrindSuggestion, isConverged } from '../dialin-convergence.js';
import type { DialinSuggestion } from '../dialin-convergence.js';
import { renderSidebar, updateSidebarHighlighting } from '../components/sidebar.js';

// state/index.ts types the session as Record<string, unknown> and shot rows
// as metadata-only ShotMeta; these aliases name the fields this wizard
// actually reads/writes, same pattern as views/shots/annotation.ts.
interface DialinShotAnnotation {
  coffee?: string | null;
  beanId?: number | null;
  grinder?: string | null;
  grindSetting?: string | number | null;
  dose?: string | number | null;
}

interface DialinShotRow extends ShotLike {
  duration?: number | null;
  _trashed?: boolean;
  annotation?: DialinShotAnnotation | null;
}

interface DialinReviewRound {
  grindSetting: number;
  shotId: number;
  score: number | null;
  seconds: number;
  ratio: number | null;
  channeling: boolean;
  suggestion?: DialinSuggestion;
}

interface DialinSession {
  id: number;
  startedAt: number;
  bean: string;
  beanId: number | null;
  grinder: string;
  dose: string | number | null;
  targetRatio: number;
  recipeId: number | null;
  startGrind: number | string | null;
  rounds: DialinReviewRound[];
  pendingGrind: number | string | null;
  candidateShotId: number | null;
  reviewRound: DialinReviewRound | null;
  awaitingShotSince: number | null;
  status: string;
  dismissedShotIds?: number[];
}

interface DialinPrefill {
  beanName?: string;
  beanId?: number | null;
  grinderName?: string;
  dose?: string | number;
  startGrind?: number | string | null;
  recipeId?: number | null;
}

const POLL_MS = 3000;
let _pollTimer: ReturnType<typeof setInterval> | null = null;

function _session(): DialinSession | null {
  return S.dialinSession as unknown as DialinSession | null;
}

function _shots(): DialinShotRow[] {
  return S.shots;
}

function _persist(): void {
  if (S.dialinSession) localStorage.setItem('glp_dialin_session', JSON.stringify(S.dialinSession));
  else localStorage.removeItem('glp_dialin_session');
}

function _startPoll(): void {
  _stopPoll();
  _pollTimer = setInterval(() => {
    if (!S.dialinSession || S.dialinSession.status !== 'active') return;
    renderDialinWizard();
  }, POLL_MS);
}

function _stopPoll(): void {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
}

// ── Open / close ────────────────────────────────────────────────────────

// prefill: { beanName, beanId, grinderName, dose, startGrind, recipeId }
export function openDialinWizard(prefill: DialinPrefill = {}): void {
  if (!S.dialinSession || S.dialinSession.status !== 'active') {
    const bean = prefill.beanId != null
      ? S.coffeeLibrary?.beans?.find(b => b.id === prefill.beanId)
      : (prefill.beanName ? S.coffeeLibrary?.beans?.find(b => b.name === prefill.beanName) : null);
    // #456: beanId (#310's session field) carries the stable link forward to
    // the final annotate payload in dialinConfirmShot below.
    const beanId = prefill.beanId ?? (bean?.id as number | undefined) ?? null;
    const startGrind = prefill.startGrind ?? _suggestStartGrind(prefill.beanName, prefill.grinderName, beanId);
    S.dialinSession = {
      id: Date.now(),
      startedAt: Date.now(),
      bean: prefill.beanName || '',
      beanId,
      grinder: prefill.grinderName || (bean?.knownGrindSettings as { grinder?: string }[] | undefined)?.[0]?.grinder || '',
      dose: prefill.dose ?? '',
      targetRatio: bean?.brewRatio ? _parseRatio(bean.brewRatio as string | number | null | undefined) : 2,
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
  const modal = document.getElementById('dialinWizardModal') as HTMLElement;
  modal.classList.add('open');
  modal.style.display = 'flex';
  renderDialinWizard();
  _startPoll();
}

// Bean-card entry point (library.js's start-dialin-from-bean button) —
// prefills the bean (and its id, #456) and, if known, the grinder from
// bean.knownGrindSettings.
export function startDialinFromBean(beanId: number): void {
  const bean = S.coffeeLibrary?.beans?.find(b => b.id === beanId);
  if (!bean) return;
  openDialinWizard({
    beanName: bean.name as string,
    beanId: bean.id as number,
    grinderName: (bean.knownGrindSettings as { grinder?: string }[] | undefined)?.[0]?.grinder || '',
  });
}

export function closeDialinWizard(): void {
  const modal = document.getElementById('dialinWizardModal') as HTMLElement;
  modal.classList.remove('open');
  modal.style.display = 'none';
  _stopPoll();
}

function _parseRatio(brewRatio: string | number | null | undefined): number {
  const m = String(brewRatio || '').trim().match(/^1\s*:\s*([\d.]+)$/);
  const n = m ? parseFloat(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 2;
}

// Starting-grind heuristic (plan §1): best historical (grinder, grind)
// combo for the bean, else the bean's known-good grind for this grinder,
// else the most recent shot on this grinder, else empty.
function _suggestStartGrind(beanName: string | undefined, grinderName: string | undefined, beanId: number | null): number | null {
  if (beanName) {
    const combos = calcBestGrindCombosForBean(beanName, _shots(), beanId);
    if (combos?.length) {
      const combo = grinderName
        ? combos.find(c => c.grinder.toLowerCase() === grinderName.toLowerCase()) || combos[0]
        : combos[0];
      if (combo) return combo.grindSetting;
    }
    const bean = beanId != null
      ? S.coffeeLibrary?.beans?.find(b => b.id === beanId)
      : S.coffeeLibrary?.beans?.find(b => b.name === beanName);
    const known = (bean?.knownGrindSettings as { grinder: string; grindSetting?: string | number }[] | undefined)?.find(k =>
      !grinderName || k.grinder.toLowerCase() === grinderName.toLowerCase());
    if (known) return _parseGrindNum(known.grindSetting);
  }
  if (grinderName) {
    const last = [..._shots()]
      .filter(s => (s.annotation?.grinder || '').toLowerCase() === grinderName.toLowerCase())
      .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))[0];
    const raw = _parseGrindNum(last?.annotation?.grindSetting);
    const g = normalizeGrindToNow(S.coffeeLibrary?.grinders, grinderName, raw, last?.timestamp != null ? last.timestamp * 1000 : undefined) ?? null;
    if (g !== null) return g;
  }
  return null;
}

// ── Round evaluation ────────────────────────────────────────────────────

async function _evalShot(shot: DialinShotRow): Promise<{ secs: number; channeling: boolean; ratio: number | null; score: number | null }> {
  const data  = mapShotDatapoints(await getShotCurve(shot.id)); // #957: curve is lazy per shot
  const secs  = (shot.duration || 0) / 10;
  const pTimes = data.pressure.map(p => p.x);
  const pAll   = data.pressure.map(p => p.y);
  const channeling = detectChanneling(pTimes, pAll);
  // calcBrewRatio declares the annotation dose as a string, but the API stores
  // a number here (which is why it parseFloat()s it) — keep passing the real value.
  const ratio = calcBrewRatio(shot as unknown as { annotation?: { dose?: string | null } | null }, data);
  const score = calcShotScore(shot);
  return { secs, channeling, ratio, score };
}

// ── Actions (data-action wiring, see main.js) ──────────────────────────

// Setup step's "Start round 1" reuses the same action as "accept & move
// to the next round" — both mean "lock in the current grind and start
// waiting for a shot".
export function dialinAcceptNext(): void {
  const s = _session();
  if (!s) return;

  if (s.status === 'setup') {
    s.bean        = (document.getElementById('dwBean') as HTMLInputElement | null)?.value.trim() || '';
    // #456: #dwBean is a free-text input with a datalist (not a native
    // select), so there's no data-bean-id to read off — re-derive by exact
    // name match against the current library, same as the annotation
    // panel's select does at selection time. A freehand-typed name that
    // doesn't match any bean correctly gets no id.
    s.beanId = (S.coffeeLibrary?.beans?.find(b => b.name === s.bean)?.id as number | undefined) ?? null;
    // #322: grinder is a <select> when the library has grinders (with an
    // "other…" option falling back to the free-text #dwGrinderOther input),
    // otherwise a plain text #dwGrinder input — same fallback as before.
    {
      const grinderEl = document.getElementById('dwGrinder') as HTMLInputElement | HTMLSelectElement | null;
      if (grinderEl?.tagName === 'SELECT') {
        s.grinder = grinderEl.value === '__other__'
          ? ((document.getElementById('dwGrinderOther') as HTMLInputElement | null)?.value.trim() || '')
          : grinderEl.value;
      } else {
        s.grinder = grinderEl?.value.trim() || '';
      }
    }
    s.dose        = parseFloat((document.getElementById('dwDose') as HTMLInputElement | null)?.value as string) || null;
    s.targetRatio = parseFloat((document.getElementById('dwRatio') as HTMLInputElement | null)?.value as string) || 2;
    s.pendingGrind = (document.getElementById('dwStartGrind') as HTMLInputElement | null)?.value.trim() || '';
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

export function dialinOverride(): void {
  const s = _session();
  if (!s || !s.reviewRound) return;
  const input = document.getElementById('dwOverrideInput') as HTMLInputElement | null;
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

export function dialinEnd(): void {
  const s = _session();
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
export async function dialinConfirmShot(shotId: number, isMatch: boolean): Promise<void> {
  const s = _session();
  if (!s || s.status !== 'active') return;

  if (!isMatch) {
    s.dismissedShotIds = s.dismissedShotIds || [];
    s.dismissedShotIds.push(shotId);
    s.candidateShotId = null;
    _persist();
    renderDialinWizard();
    return;
  }

  const shot = _shots().find(sh => sh.id === shotId);
  if (!shot) return;

  const payload = {
    coffee: s.bean, beanId: s.beanId ?? null, grinder: s.grinder, grindSetting: String(s.pendingGrind),
    dose: s.dose || null, recipeId: s.recipeId || null,
  };
  try {
    const r = await annotateShot(shotId, payload as unknown as ShotAnnotation);
    if (r.ok) {
      const rows = _shots();
      const idx = rows.findIndex(sh => sh.id === shotId);
      if (idx !== -1) rows[idx].annotation = { ...rows[idx].annotation, ...payload };
      renderSidebar();
      updateSidebarHighlighting();
    }
  } catch { /* keep going even if the annotate call fails */ }

  const evald = await _evalShot(_shots().find(sh => sh.id === shotId) || shot);
  s.reviewRound = {
    grindSetting: _parseGrindNum(s.pendingGrind) ?? parseFloat(s.pendingGrind as string) ?? 0,
    shotId, score: evald.score, seconds: evald.secs, ratio: evald.ratio, channeling: evald.channeling,
  };
  s.reviewRound.suggestion = calcNextGrindSuggestion([...s.rounds, s.reviewRound]);
  s.candidateShotId = null;
  _persist();
  renderDialinWizard();
}

export async function dialinSaveKnownGrind(): Promise<void> {
  const s = _session();
  if (!s) return;
  const bean = s.beanId != null
    ? S.coffeeLibrary?.beans?.find(b => b.id === s.beanId)
    : S.coffeeLibrary?.beans?.find(b => b.name === s.bean);
  const best = _bestRound(s.rounds);
  if (!bean || !best) return;
  // api/library.ts declares grindSetting as string, but the untyped .js sent
  // the round's numeric value straight through — keep the wire body identical.
  const updated = await saveBeanKnownGrind(bean.id as number, { grinder: s.grinder, grindSetting: best.grindSetting as unknown as string });
  if (updated) {
    const idx = S.coffeeLibrary.beans.findIndex(b => b.id === bean.id);
    if (idx !== -1) S.coffeeLibrary.beans[idx] = updated;
    window.showToast?.(t('dialin_wizard_save_known_done'));
    renderDialinWizard();
  }
}

export function dialinClose(): void {
  closeDialinWizard();
}

function _bestRound(rounds: DialinReviewRound[]): DialinReviewRound | null {
  return [...(rounds || [])]
    .filter(r => r.score != null)
    .sort((a, b) => (b.score as number) - (a.score as number))[0] || null;
}

// ── Rendering ────────────────────────────────────────────────────────────

export function renderDialinWizard(): void {
  const s = _session();
  const body = document.getElementById('dwBody');
  if (!body) return;
  if (!s) { body.innerHTML = ''; return; }

  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  if (s.status === 'setup')                       { body.innerHTML = _renderSetup(s); return; }
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  if (s.status === 'converged' || s.status === 'ended') { body.innerHTML = _renderSummary(s); return; }

  // active
  if (!s.candidateShotId && !s.reviewRound) _checkForCandidate(s);
  // #957: the candidate's mini-chart needs its curve — fetch it, then
  // re-render so the thumbnail fills in (it shows a placeholder until then).
  if (s.candidateShotId && window.getRawCurve && !window.getRawCurve(s.candidateShotId)) {
    const pendingId = s.candidateShotId;
    void getShotCurve(pendingId).then(() => {
      if (S.dialinSession?.candidateShotId === pendingId) renderDialinWizard();
    });
  }
  // codeql[js/xss-through-dom] false positive: esc()/escapeHtml() already applied, see #760
  body.innerHTML = _renderRound(s);
}

function _checkForCandidate(s: DialinSession): void {
  if (!s.awaitingShotSince) return;
  const dismissed = new Set(s.dismissedShotIds || []);
  const already   = new Set((s.rounds || []).map(r => r.shotId));
  const candidate = [..._shots()]
    .filter(sh => !sh._trashed && (sh.timestamp as number) >= s.awaitingShotSince! && !dismissed.has(sh.id as number) && !already.has(sh.id as number))
    .sort((a, b) => (a.timestamp as number) - (b.timestamp as number))[0];
  if (candidate) s.candidateShotId = candidate.id as number;
}

// #322: grinder field is a select of library grinders (matching lib.grinders)
// when any exist, preselecting the prefilled/known grinder — with an
// "other…" option that reveals a free-text fallback input, since not every
// grinder is necessarily in the library yet. Falls back to a plain text
// input (as before) when the library has no grinders at all.
function _renderGrinderField(s: DialinSession): string {
  const grinders = S.coffeeLibrary?.grinders || [];
  if (!grinders.length) {
    return `<input type="text" id="dwGrinder" value="${esc(s.grinder)}">`;
  }
  const knownNames = new Set(grinders.map(g => g.name));
  const isOther = !!s.grinder && !knownNames.has(s.grinder);
  return `
    <select id="dwGrinder" data-action="dialin-grinder-select">
      ${grinders.map(g => `<option value="${esc(g.name as string)}"${!isOther && s.grinder === g.name ? ' selected' : ''}>${esc(g.name as string)}</option>`).join('')}
      <option value="__other__"${isOther ? ' selected' : ''}>${t('dialin_wizard_grinder_other')}</option>
    </select>
    <input type="text" id="dwGrinderOther" placeholder="${t('dialin_wizard_grinder_other_ph')}"
      style="${isOther ? '' : 'display:none'};margin-top:6px" value="${isOther ? esc(s.grinder) : ''}">`;
}

// Toggles the free-text fallback input's visibility when the grinder select
// changes — wired via the document-level [data-action] change delegation.
export function dialinGrinderChange(): void {
  const select = document.getElementById('dwGrinder');
  const other  = document.getElementById('dwGrinderOther');
  if (!select || !other || select.tagName !== 'SELECT') return;
  other.style.display = (select as HTMLSelectElement).value === '__other__' ? '' : 'none';
}

function _renderSetup(s: DialinSession): string {
  const beans = S.coffeeLibrary?.beans || [];
  return `<div class="dw-setup">
    <div class="lib-form-field">
      <label>${t('dialin_wizard_setup_bean')}</label>
      <input type="text" id="dwBean" list="dwBeanList" value="${esc(s.bean)}">
      <datalist id="dwBeanList">${beans.map(b => `<option value="${esc(b.name as string)}">`).join('')}</datalist>
    </div>
    <div class="lib-form-field">
      <label>${t('dialin_wizard_setup_grinder')}</label>
      ${_renderGrinderField(s)}
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

function _renderRound(s: DialinSession): string {
  const roundNum = s.rounds.length + 1;
  const chips = _renderChips(s.rounds);

  if (s.reviewRound) {
    const rr  = s.reviewRound;
    const sug = rr.suggestion as DialinSuggestion;
    const sugText = (sug.type === 'finer' || sug.type === 'coarser')
      ? t(sug.reason, rr.grindSetting, sug.nextGrind)
      : t(sug.reason);
    return `<div class="dw-round">
      <div class="dw-round-label">${t('dialin_wizard_round_label', roundNum)}</div>
      <div class="dw-score-row">
        <div class="dw-score-chip" style="background:${scoreColor(rr.score)}">${rr.score ?? '–'}</div>
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

  const candidate = s.candidateShotId ? _shots().find(sh => sh.id === s.candidateShotId) : null;

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

function _renderSummary(s: DialinSession): string {
  const best = _bestRound(s.rounds);
  const title = s.status === 'converged' ? t('dialin_wizard_converged_title') : t('dialin_wizard_summary_title');
  const reasonText = s.status === 'converged' && s.rounds.length
    ? t(calcNextGrindSuggestion(s.rounds).reason) : '';
  return `<div class="dw-summary">
    <div class="dw-summary-title">${title}</div>
    ${reasonText ? `<div class="dw-summary-reason">${esc(reasonText)}</div>` : ''}
    ${best ? `<div class="dw-summary-best">
      <div class="dw-score-chip" style="background:${scoreColor(best.score)}">${best.score}</div>
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

function _renderChips(rounds: DialinReviewRound[]): string {
  if (!rounds?.length) return '';
  return `<div class="dw-chip-strip">${rounds.map(r =>
    `<div class="dw-chip" style="border-color:${scoreColor(r.score)}">${esc(String(r.grindSetting))} → ${r.score ?? '–'}</div>`
  ).join('')}</div>`;
}
