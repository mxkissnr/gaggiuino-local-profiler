// Shared session/polling plumbing for the two dial-in wizards (#1622).
//
// The grind wizard (views/dialin-wizard.ts, #310) and the profile wizard
// (views/profile-dialin-wizard.ts, #313) serve different purposes and keep
// their own session shapes and renderers, but the persist/poll/candidate
// machinery around the session was near line-for-line identical. This module
// holds that shared part; each wizard instantiates the factory with its own
// state slot, localStorage key and override-input id.
//
// The localStorage keys are deliberately unchanged from the pre-consolidation
// copies so an in-progress dial-in survives the update.
import { S } from '../state/index.js';
import { textEntryFocused } from '../live-sync.js';
import { esc, html, joinHtml, scoreColor } from '../utils.js';
import type { Html } from '../utils.js';

const POLL_MS = 3000;

export interface WizardSessionConfig {
  // Which slot on S holds the session; both are typed Record<string, unknown>
  // in state/index.ts and narrowed by the caller's TSession.
  stateKey: 'dialinSession' | 'profileDialinSession';
  storageKey: string;
  // The manual-override <input> the poll must not re-render over.
  overrideInputId: string;
  // Renderer the poll tick calls when a re-render is safe.
  onTick: () => void;
}

export interface WizardSession<TSession, TShot> {
  session(): TSession | null;
  shots(): TShot[];
  persist(): void;
  startPoll(): void;
  stopPoll(): void;
  overrideHasValue(): boolean;
}

export function createWizardSession<TSession extends Record<string, unknown>, TShot>(
  { stateKey, storageKey, overrideInputId, onTick }: WizardSessionConfig,
): WizardSession<TSession, TShot> {
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const stopPoll = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  // A manual override value the user has typed but not yet committed: the poll
  // must not re-render the wizard over it.
  const overrideHasValue = (): boolean => {
    const input = document.getElementById(overrideInputId) as HTMLInputElement | null;
    return input !== null && input.value !== '';
  };

  const startPoll = (): void => {
    stopPoll();
    pollTimer = setInterval(() => {
      const s = S[stateKey];
      if (!s || s.status !== 'active') return;
      if (textEntryFocused() || overrideHasValue()) return;
      onTick();
    }, POLL_MS);
  };

  return {
    session: () => S[stateKey] as TSession | null,
    shots: () => S.shots as unknown as TShot[],
    persist: () => {
      const s = S[stateKey];
      if (s) localStorage.setItem(storageKey, JSON.stringify(s));
      else localStorage.removeItem(storageKey);
    },
    startPoll,
    stopPoll,
    overrideHasValue,
  };
}

// ── Shared round helpers ───────────────────────────────────────────────────

export interface WizardCandidateSession {
  awaitingShotSince: number | null;
  dismissedShotIds?: number[];
  rounds: { shotId: number }[];
  candidateShotId: number | null;
}

export interface WizardShot {
  id?: number;
  timestamp?: number;
  _trashed?: boolean;
}

// The oldest not-yet-dismissed shot newer than awaitingShotSince becomes the
// candidate round — identical selection rule in both wizards.
export function checkForCandidate<TSession extends WizardCandidateSession>(
  s: TSession,
  shots: readonly WizardShot[],
): void {
  if (!s.awaitingShotSince) return;
  const dismissed = new Set(s.dismissedShotIds || []);
  const already = new Set((s.rounds || []).map(r => r.shotId));
  const candidate = [...shots]
    .filter(sh => !sh._trashed && (sh.timestamp as number) >= s.awaitingShotSince! && !dismissed.has(sh.id as number) && !already.has(sh.id as number))
    .sort((a, b) => (a.timestamp as number) - (b.timestamp as number))[0];
  if (candidate) s.candidateShotId = candidate.id as number;
}

export interface WizardScoredRound {
  score: number | null;
}

export function bestRound<TRound extends WizardScoredRound>(rounds: readonly TRound[] | null | undefined): TRound | null {
  const best = [...(rounds || [])]
    .filter(r => r.score != null)
    .sort((a, b) => (b.score as number) - (a.score as number))[0];
  return best ?? null;
}

// The chip strip differs only in its label expression (grind number vs taste
// symptom), so the caller supplies that as `label`.
export function renderChips<TRound extends WizardScoredRound>(
  rounds: readonly TRound[] | null | undefined,
  label: (round: TRound) => Html,
): Html {
  if (!rounds?.length) return html``;
  return html`<div class="dw-chip-strip">${joinHtml(rounds.map(r =>
    html`<div class="dw-chip" style="border-color:${esc(scoreColor(r.score))}">${label(r)} → ${esc(r.score ?? '–')}</div>`
  ))}</div>`;
}
