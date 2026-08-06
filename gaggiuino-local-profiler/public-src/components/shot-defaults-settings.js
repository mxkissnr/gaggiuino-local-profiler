// Settings → "Shot logging defaults" card (#654): lets the user configure
// optional default values (Drink Type, Coffee/Bean, Basket, Puck Screen,
// Grinder, Dose) that get auto-prefilled into a brand-new shot's annotation
// panel — see views/shots/annotation.js's _applyShotDefaults(), which is the
// only place that actually applies them. This module only loads/saves the
// settings themselves and keeps S.shotDefaults (loaded once at app init by
// loadShotDefaults()) in sync after a save.
import { apiFetch } from '../api.js';
import { S } from '../state.js';
import { t } from '../i18n.js';
import { esc } from '../utils.js';
import { loadShotDefaults, loadDrinkMenu } from '../views/shots/annotation.js';

export function renderShotDefaultsSettingsCard() {
  const d = S.shotDefaults || {};

  const drinkSelect = document.getElementById('sdDrinkType');
  if (drinkSelect) {
    const options = S.drinkMenu || [];
    drinkSelect.innerHTML = `<option value="">${esc(t('sd_none'))}</option>` +
      options.map(m => `<option value="${esc(m.id)}"${d.drinkType === m.id ? ' selected' : ''}>${esc(m.emoji)} ${esc(m.name)}</option>`).join('');
  }

  const coffeeSelect = document.getElementById('sdCoffee');
  if (coffeeSelect) {
    const beans = S.coffeeLibrary?.beans || [];
    coffeeSelect.innerHTML = `<option value="">${esc(t('sd_none'))}</option>` +
      beans.map(b => `<option value="${esc(b.name)}" data-bean-id="${b.id}"${d.coffee === b.name ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  }

  const basketSelect = document.getElementById('sdBasket');
  if (basketSelect) {
    const baskets = S.coffeeLibrary?.baskets || [];
    basketSelect.innerHTML = `<option value="">${esc(t('ann_basket_none'))}</option>` +
      baskets.map(b => `<option value="${b.id}"${d.basketId === b.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  }

  const puckSelect = document.getElementById('sdPuckScreen');
  if (puckSelect) {
    const puckScreens = S.coffeeLibrary?.puckScreens || [];
    puckSelect.innerHTML = `<option value="">${esc(t('ann_puckscreen_none'))}</option>` +
      puckScreens.map(p => `<option value="${p.id}"${d.puckScreenId === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  }

  const grinderInput = document.getElementById('sdGrinder');
  if (grinderInput) grinderInput.value = d.grinder || '';

  const doseInput = document.getElementById('sdDose');
  if (doseInput) doseInput.value = d.dose ?? '';
}

// #526-style race: loadDrinkMenu() is also fired unawaited from main.js's
// init sequence (for the annotation panel's drink pills) — awaiting it again
// here is a cheap no-op once it's already resolved, and guarantees this
// card's drink-type options aren't rendered off the still-empty S.drinkMenu
// default when this runs first. The coffeeLibrary half of the same race
// (beans/baskets/puckScreens) is covered by the re-render loadLibrary()
// itself does — see views/library.js.
export async function loadShotDefaultsSettingsCard() {
  await Promise.all([loadShotDefaults(), loadDrinkMenu()]);
  renderShotDefaultsSettingsCard();
}

export async function saveShotDefaultsSettings() {
  const coffeeSelect = document.getElementById('sdCoffee');
  const beanIdAttr   = coffeeSelect?.selectedOptions[0]?.dataset.beanId;

  const body = {
    drinkType:    document.getElementById('sdDrinkType')?.value || null,
    coffee:       coffeeSelect?.value || null,
    beanId:       beanIdAttr ? parseInt(beanIdAttr, 10) : null,
    basketId:     parseInt(document.getElementById('sdBasket')?.value, 10) || null,
    puckScreenId: parseInt(document.getElementById('sdPuckScreen')?.value, 10) || null,
    grinder:      document.getElementById('sdGrinder')?.value.trim() || '',
    dose:         parseFloat(document.getElementById('sdDose')?.value) || null,
  };

  const r = await apiFetch('api/shots/defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.ok) S.shotDefaults = await r.json();

  const btn = document.getElementById('shotDefaultsSaveBtn');
  if (btn) {
    btn.textContent = t('sd_saved');
    setTimeout(() => { btn.textContent = t('sd_save'); }, 2000);
  }
}
