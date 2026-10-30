// Boot step (#1615): the shot annotation panel's static wiring -- star
// rating, bean autofill, auto-save on the annotation fields. Moved verbatim
// out of main.ts's DOMContentLoaded handler; run through runStep() so a
// missing element only skips this step.
import { S } from '../state/index.js';
import type { Bean } from '../api/types.js';
import { tHtml } from '../i18n.js';
import { html } from '../utils.js';
import { renderStars, scheduleAutoSave, flushAutoSave, updateDegassing, calcBeanAgeAtShot,
         suggestGrindDoseForBean, _renderFrozenPortionPills } from '../views/shots.js';
import { attachAutocomplete } from '../components/autocomplete.js';
import { BEAN_ICON_SVG } from '../icons.js';
import { addMixRow, isMixActive } from '../views/shots/annotation-mix.js';

export function wireAnnotationPanel(): void {
  const starRating = document.getElementById('starRating');
  if (starRating) {
    starRating.addEventListener('mouseover', e => {
      const star = (e.target as HTMLElement).closest<HTMLElement>('.star');
      if (!star) return;
      const val = parseInt(star.dataset.val ?? '');
      starRating.querySelectorAll<HTMLElement>('.star').forEach(s => {
        s.classList.toggle('hovered', parseInt(s.dataset.val ?? '') <= val);
      });
    });
    starRating.addEventListener('mouseout', () => {
      starRating.querySelectorAll('.star').forEach(s => s.classList.remove('hovered'));
    });
    starRating.addEventListener('click', e => {
      const star = (e.target as HTMLElement).closest<HTMLElement>('.star');
      if (!star) return;
      const val = parseInt(star.dataset.val ?? '');
      S.currentRating = S.currentRating === val ? 0 : val;
      renderStars(S.currentRating);
      scheduleAutoSave();
    });
  }

  // ── annCoffee: auto-fill roast date + show bean age hint ───────────────
  const annCoffee = document.getElementById('annCoffee') as HTMLInputElement | null;
  if (annCoffee) {
    annCoffee.addEventListener('change', () => {
      const name = annCoffee.value.trim();
      const hintEl = document.getElementById('beanAgeHint');
      if (!name || !S.coffeeLibrary) { if (hintEl) hintEl.style.display = 'none'; _renderFrozenPortionPills(null, Date.now(), null); return; }

      const bean = S.coffeeLibrary.beans?.find((b): b is Bean => b.name === name);
      if (!bean) { if (hintEl) hintEl.style.display = 'none'; _renderFrozenPortionPills(null, Date.now(), null); return; }

      // Prefill grinder/grind setting/dose from this bean's own history
      // (best scored combo, then known-good grind, then its last shot) —
      // never the literal previous shot, which may have used a different bean.
      const suggested = suggestGrindDoseForBean(name, S.coffeeLibrary, S.shots, { beanId: bean.id });
      const grinderEl = document.getElementById('annGrinder') as HTMLInputElement | null;
      const grindEl   = document.getElementById('annGrindSetting') as HTMLInputElement | null;
      const doseEl    = document.getElementById('annDose') as HTMLInputElement | null;
      if (suggested.grinder      && grinderEl) grinderEl.value = suggested.grinder;
      if (suggested.grindSetting && grindEl)   grindEl.value   = String(suggested.grindSetting);
      // #1837: in a mix the dose is the rows' sum, so a bean change must not
      // overwrite it with this bean's own suggestion.
      if (suggested.dose && doseEl && !isMixActive()) doseEl.value = String(suggested.dose);

      // Find roast date from the active bag at shot time
      const shot   = S.primaryShotId ? S.shots?.find(s => s.id === S.primaryShotId) : null;
      const shotMs = shot ? shot.timestamp * 1000 : Date.now();
      const bags   = Array.isArray(bean.bags) ? bean.bags : [];
      let roastDate = bean.roastDate;
      if (bags.length) {
        const activeBag = bags
          .filter(b => (b.openedAt || 0) <= shotMs)
          .sort((a, b) => (b.openedAt as number) - (a.openedAt as number))[0];
        if (activeBag?.roastDate) roastDate = activeBag.roastDate;
      }

      // Update degassing tracker from library roast date
      updateDegassing(roastDate || '');

      // Bean changed — the frozen-portion choices (if any) belong to the
      // previously selected bean's bag, never carry over. Reset to unset.
      _renderFrozenPortionPills(name, shotMs, null);

      // Show bean age hint
      const ageDays = calcBeanAgeAtShot(name, shot?.timestamp, bean.id);
      if (hintEl && ageDays != null) {
        hintEl.innerHTML = html`${BEAN_ICON_SVG} ${tHtml('bean_age_at_shot', ageDays)}`;
        hintEl.style.display = '';
      } else if (hintEl) {
        hintEl.style.display = 'none';
      }
    });
  }
  // #430: no more explicit Save button — auto-save on input, flushed
  // immediately on blur (leaving the field) and on page hide/mode-switch
  // (below) so a pending debounced save is never silently dropped.
  ['annCoffee','annGrinder','annGrindSetting','annDose','annTds','annNotes'].forEach(id => {
    const el = document.getElementById(id)!;
    el.addEventListener('input', scheduleAutoSave);
    el.addEventListener('blur', flushAutoSave);
  });
  attachAutocomplete(document.getElementById('annGrinder') as HTMLInputElement | null, () => S.coffeeLibrary.grinders.map(g => g.name));
  // #1837: "Add another bean" splits the dose over a second (to fourth) bean,
  // turning the dose field into the read-only sum of the rows.
  document.getElementById('annMixAddBtn')?.addEventListener('click', addMixRow);
  document.getElementById('annBasket')!.addEventListener('change', scheduleAutoSave);
  document.getElementById('annPuckScreen')!.addEventListener('change', scheduleAutoSave);
  document.getElementById('annRecipe')?.addEventListener('change', scheduleAutoSave);
}
