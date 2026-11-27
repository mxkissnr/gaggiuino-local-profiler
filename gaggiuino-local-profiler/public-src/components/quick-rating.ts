// #2226: the quick rating strip: five stars, a one-line hint of what the
// stars mean and the four taste-tag chips (#1957). The live view shows it after
// a shot ends, the shot list on the newest shot while it has no rating. This
// module only builds the markup; clicks reach quickRateShot() in the shots
// annotation module through the document click delegation.
import { t } from '../i18n.js';
import { esc, html, joinHtml } from '../utils.js';
import type { Html } from '../utils.js';
import { STAR_ICON_SVG } from '../icons.js';
import { TASTE_TAGS, TASTE_TAG_LABELS, tasteTagOf } from '../views/shots/grind.js';

export interface QuickRatingShot {
  id: number;
  timestamp: number;
  // unknown, so the shot rows of the state module (index-signature typed) pass as they are.
  annotation?: unknown;
}

type QuickRatingAnnotation = { rating?: unknown; tasteTag?: unknown } | null | undefined;

/** The stored star rating when it is a whole number from 1 to 5, else 0 (unrated). */
export function quickRatingValue(annotation: unknown): number {
  const n = Number((annotation as QuickRatingAnnotation)?.rating);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 0;
}

/** The newest shot's id (latest timestamp, then highest id) when it has no rating, else null. */
export function newestUnratedShotId(shots: readonly QuickRatingShot[]): number | null {
  let newest: QuickRatingShot | undefined;
  for (const s of shots) {
    if (!newest || s.timestamp > newest.timestamp || (s.timestamp === newest.timestamp && s.id > newest.id)) newest = s;
  }
  return newest && quickRatingValue(newest.annotation) === 0 ? newest.id : null;
}

/** The strip for one shot; withDismiss adds the Later/Done button (live view only). */
export function quickRatingHtml(shot: QuickRatingShot, withDismiss: boolean): Html {
  const rating = quickRatingValue(shot.annotation);
  const tag = tasteTagOf(shot.annotation as QuickRatingAnnotation);
  const id = esc(shot.id);
  const stars = joinHtml([1, 2, 3, 4, 5].map(n =>
    html`<button type="button" class="star${n <= rating ? html` active` : html``}" data-action="quick-rate" data-id="${id}" data-val="${esc(n)}" aria-label="${esc(t('ann_rating_star', n))}" aria-pressed="${esc(String(n === rating))}">${STAR_ICON_SVG}</button>`));
  const chips = joinHtml(TASTE_TAGS.map(tg =>
    html`<button type="button" class="chip" aria-pressed="${esc(String(tg === tag))}" data-action="quick-taste" data-id="${id}" data-val="${esc(tg)}">${esc(t(TASTE_TAG_LABELS[tg]))}</button>`));
  const dismiss = withDismiss
    ? html`<button type="button" class="btn btn--quiet quick-rating-dismiss" data-action="quick-rate-dismiss">${esc(rating ? t('quick_rating_done') : t('quick_rating_later'))}</button>`
    : html``;
  return html`<div class="quick-rating" role="group" aria-label="${esc(t('quick_rating_title'))}" data-shot-id="${id}">
    <div class="quick-rating-head">
      <span class="settings-row-title">${esc(t('quick_rating_title'))}</span>
      <div class="star-rating" role="group" aria-label="${esc(t('sort_rating'))}">${stars}</div>
    </div>
    <p class="settings-card-desc quick-rating-hint">${esc(t('quick_rating_hint'))}</p>
    <div class="quick-rating-tags" role="group" aria-label="${esc(t('profile_dialin_symptom_prompt'))}">${chips}${dismiss}</div>
  </div>`;
}
