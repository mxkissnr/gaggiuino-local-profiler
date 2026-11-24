// #2210: Settings > Appearance > Home country. The choice lives in the shared
// UI prefs (every device, every backup); the coffee world map reads it through
// resolveHomeCountry(). The select's two fixed options (Automatic = '', None =
// 'none') come from the markup with their data-i18n labels; this module adds
// the countries after them, named in the current UI language.
import { S } from '../state/index.js';
import { countryName, HOME_COUNTRY_NUM, localeFor } from '../constants.js';
import { getUiPref, setUiPref } from '../ui-prefs.js';
import { switchMode } from '../components/mode.js';
import { openSettingsPage } from './settings-page.js';
import { HOME_COUNTRY_PREF, isHomeCountryCode, refreshWorldMapHome } from '../views/analytics/world-map.js';

const SELECT_ID = 'settingsHomeCountry';
const MAP_LINK_ID = 'worldMapSetHome';
const FIXED_OPTIONS = 2;

/** The map's home countries as [code, name], sorted by name in `lang`. */
export function homeCountryOptions(lang: string): [string, string][] {
  const collator = new Intl.Collator(localeFor(lang));
  return Object.keys(HOME_COUNTRY_NUM)
    .map((code): [string, string] => [code, countryName(code, lang)])
    .sort((a, b) => collator.compare(a[1], b[1]));
}

/** The select value for a stored setting: '' (Automatic), 'none' or a code. */
export function homeCountrySelectValue(pref: unknown): string {
  if (pref === 'none') return 'none';
  return isHomeCountryCode(pref) ? pref : '';
}

function _select(): HTMLSelectElement | null {
  return document.getElementById(SELECT_ID) as HTMLSelectElement | null;
}

/** (Re)fills the country options after the two fixed ones and selects the stored choice. */
export function renderHomeCountrySelect(): void {
  const select = _select();
  if (!select) return;
  while (select.options.length > FIXED_OPTIONS) select.remove(FIXED_OPTIONS);
  for (const [code, name] of homeCountryOptions(S.currentLang)) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    select.appendChild(option);
  }
  select.value = homeCountrySelectValue(getUiPref<unknown>(HOME_COUNTRY_PREF));
}

/** The map's "Set home country" link: Settings > Appearance, focus on the select. */
export function openHomeCountrySetting(): void {
  switchMode('settings');
  openSettingsPage('appearance');
  _select()?.focus();
}

/** Applies a stored choice that changed elsewhere (server load, live-sync). */
export function syncHomeCountrySetting(): void {
  const select = _select();
  if (select) select.value = homeCountrySelectValue(getUiPref<unknown>(HOME_COUNTRY_PREF));
  refreshWorldMapHome();
}

/** Boot: fills the select and wires it and the map link. */
export function wireHomeCountrySetting(): void {
  renderHomeCountrySelect();
  const select = _select();
  if (select) select.addEventListener('change', () => setUiPref(HOME_COUNTRY_PREF, select.value));
  document.getElementById(MAP_LINK_ID)?.addEventListener('click', openHomeCountrySetting);
}
