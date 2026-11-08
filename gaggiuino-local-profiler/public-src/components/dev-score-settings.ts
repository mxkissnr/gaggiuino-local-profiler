// #1922: the two dev-channel score experiments — which registered score model
// the app shows, and blind rating. Dev-channel builds only: GET /api/status
// carries `devBuild` and `scoreModels` there and neither key exists on a
// stable build, so a stable client never sees a model to pick. Both choices
// live in the shared ui-prefs store (ui-prefs.ts), so they follow the
// developer to another device. `dev.score_model` is the same key the Go side
// reads (devScoreModelPrefKey in go/cmd/server/main.go); blind rating is
// CSS-driven through a body class, so toggling it needs no re-render.
import { flushUiPrefsOnLeave, getUiPref, setUiPref } from '../ui-prefs.js';

export const SCORE_MODEL_PREF = 'dev.score_model';
export const BLIND_RATING_PREF = 'dev.blind_rating';
export const BLIND_RATING_CLASS = 'glp-blind-rating';
export const CLASSIC_SCORE_MODEL = 'classic';

// null until /api/status has answered: unknown is treated as dev below, so the
// score is not flashed for a moment before the first status response.
let _devBuild: boolean | null = null;

/**
 * Whether scores and verdicts are hidden until the shot has a rating. A stable
 * build never honours a stored pref (one restored from a dev backup would
 * otherwise hide scores on a real install); before the first status answer the
 * pref alone decides, so nothing flashes.
 */
export function blindRatingActive(devBuild: boolean | null, pref: unknown): boolean {
  return pref === true && devBuild !== false;
}

/** Toggles the body class the blind-rating CSS rules hang off. */
export function applyBlindRating(): void {
  const body = typeof document === 'undefined' ? null : document.body;
  if (!body) return;
  body.classList.toggle(BLIND_RATING_CLASS, blindRatingActive(_devBuild, getUiPref(BLIND_RATING_PREF)));
}

/**
 * The stored model id, but only while the server still lists it: a preference
 * left over from a removed model (or a non-string in the kv row) falls back to
 * classic instead of a select that cannot represent it.
 */
export function selectedScoreModel(models: readonly string[], stored: unknown): string {
  return typeof stored === 'string' && models.includes(stored) ? stored : CLASSIC_SCORE_MODEL;
}

/**
 * Records the picked model and reloads. A reload is the simplest way to get
 * every view rescored from the server; other open devices pick the change up
 * on their next reload (the pref is shared, the rescore is not pushed).
 */
export async function onScoreModelChange(id: string, reload: () => void = () => location.reload()): Promise<void> {
  setUiPref(SCORE_MODEL_PREF, id);
  await flushUiPrefsOnLeave();
  reload();
}

/**
 * Wires the dev-only controls to the status payload. Called from every status
 * poll, so it must stay idempotent: the option list is rebuilt only when the
 * server's model list actually changed, and never under an open dropdown.
 * Both elements arrive with the markup slice — until then this is only the
 * blind-rating class.
 */
export function applyDevScoreSettings(devBuild: boolean, models: readonly string[] | undefined): void {
  _devBuild = devBuild;
  applyBlindRating();
  if (!devBuild || typeof document === 'undefined') return;

  const select = document.getElementById('devScoreModel') as HTMLSelectElement | null;
  if (select) {
    const list = models ?? [CLASSIC_SCORE_MODEL];
    const key = list.join('\u0000');
    if (select.dataset.models !== key && document.activeElement !== select) {
      select.dataset.models = key;
      const frag = document.createDocumentFragment();
      for (const id of list) frag.append(new Option(id, id));
      select.replaceChildren(frag);
    }
    select.value = selectedScoreModel(list, getUiPref(SCORE_MODEL_PREF));
    select.onchange = () => { void onScoreModelChange(select.value); };
  }

  const box = document.getElementById('devBlindRating') as HTMLInputElement | null;
  if (box) {
    box.checked = getUiPref(BLIND_RATING_PREF) === true;
    box.onchange = () => {
      setUiPref(BLIND_RATING_PREF, box.checked);
      applyBlindRating();
    };
  }
}
