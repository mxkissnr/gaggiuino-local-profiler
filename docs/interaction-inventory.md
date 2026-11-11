# Interaction rule inventory (#1962)

Every existing control that breaks a rule in the "Interaction rules" section of [DESIGN.md](DESIGN.md), with the slice that migrates it. A slice removes its rows when it migrates them. This file and the test that checks it are deleted once the table is empty.

"Slice" is a slice of #1962 (`S<n>`), `exempt: <why it does not break the rule>`, or `open: <decision the maintainer still has to make>`. "Anchor" is a literal string that must occur in the file. test/interaction-inventory.test.ts checks every row: the file exists and the anchor occurs in it. For "Dates" and "Numbers" (min, max, step) it also scans public-src and fails if a file has more or fewer violations than rows, and for "Confirming" it compares the rows with eslint-suppressions.json. "Saving" applies to records in the library and on shots. A settings card is a form with a save button, which the "Switches" rule expects.

| Rule | File | Anchor | Slice |
|---|---|---|---|
| Dates | public-src/views/dialin.ts | `.toLocaleDateString(locale, { day:` | S12 |
| Errors | public-src/views/dialin-wizard.ts | `if (!val) { input?.focus(); return; }` | S12 |
| Errors | public-src/views/profile-dialin-wizard.ts | `if (!Number.isFinite(val)) { input?.focus(); return; }` | S12 |
| Numbers | public-src/views/dialin-wizard.ts | `id="dwDose"` | S12 |
| Numbers | public-src/views/dialin-wizard.ts | `id="dwRatio"` | S12 |
| Numbers | public-src/views/profile-dialin-wizard.ts | `id="pdwOverrideInput"` | S12 |
| States | public-src/views/analytics.ts | `export function initAnalytics` | S12 |
| States | public-src/views/dialin.ts | `tHtml('dialin_empty')` | S12 |
| Dates | public-src/views/live.ts | `.toLocaleDateString(localeFor(S.currentLang), { da` | S13 |
| States | public-src/views/library.ts | `export async function loadLibrary` | S13 |
| States | public-src/views/orders.ts | `export async function loadOrdersView` | S13 |
| Errors | public-src/views/library/baskets.ts | `getElementById('basketFormName') as HTMLInputElement).focus(); return;` | S14 |
| Errors | public-src/views/library/puck-screens.ts | `getElementById('puckScreenFormName') as HTMLInputElement).focus(); return;` | S14 |
| Errors | public-src/views/library/recipes.ts | `getElementById('recipeFormName') as HTMLInputElement).focus(); return;` | S14 |
| Saving | public-src/index.html | `id="saveBasketBtn"` | S14 |
| Saving | public-src/index.html | `id="savePuckScreenBtn"` | S14 |
| Saving | public-src/index.html | `id="saveRecipeBtn"` | S14 |
| Saving | public-src/views/library/bean-card.ts | `save-edit-frozen-form` | exempt: inline form re-renders on save, so it keeps its save button |
| Errors | public-src/views/library/bean-form-sheet.ts | `_field('beanFormName').focus(); return;` | S16 |
| Errors | public-src/views/library/grinders.ts | `_input('grinderFormName').focus(); return;` | S16 |
| Errors | public-src/views/shots/annotation.ts | `if (!r.ok) return;` | S16 |
| Choosing | public-src/index.html | `id="beanFormSpecies"` | S16 |
| Choosing | public-src/index.html | `id="beanFormCategory"` | S16 |
| Choosing | public-src/index.html | `id="beanFormRoastType"` | S16 |
| Saving | public-src/index.html | `id="saveGrinderBtn"` | S16 |
| Saving | public-src/index.html | `id="saveBeanBtn"` | S16 |
| Saving | public-src/views/library/bags.ts | `save-edit-bag` | exempt: inline form re-renders on save, so it keeps its save button |
| Saving | public-src/views/library/bags.ts | `save-bag-stock-edit` | exempt: inline form re-renders on save, so it keeps its save button |
| Dates | public-src/views/shots/annotation.ts | `.toLocaleDateString(locale, { day:` | S16 |
| Saving | public-src/index.html | `id="machineFormSaveBtn"` | exempt: writes connection settings of a live machine, so it keeps its save button |
| Saving | public-src/index.html | `data-action="gm-editor-save"` | exempt: writes to the machine, so it keeps its save button |
| Saving | public-src/index.html | `id="sendProfileToMachineBtn"` | exempt: writes to the machine, so it keeps its save button |
| Choosing | public-src/views/library/recipes.ts | `getElementById('recipeFormProfile')` | exempt: a recipe may name a profile that is not on a connected machine |
| Dates | public-src/components/machine-backups.ts | `new Intl.RelativeTimeFormat(locale, { numeric:` | exempt: relative time |
| Dates | public-src/components/sidebar.ts | `.toLocaleDateString(locale, { weekday:` | exempt: group heading |
| Dates | public-src/components/sidebar.ts | `.toLocaleDateString(locale, { month:` | exempt: group heading |
| Dates | public-src/components/sidebar.ts | `.toLocaleTimeString(localeFor(S.currentLang), { ho` | exempt: clock time |
| Dates | public-src/components/status.ts | `.toLocaleTimeString(localeFor(S.currentLang), { ho` | exempt: clock time |
| Dates | public-src/views/achievements.ts | `.toLocaleTimeString(locale, { hour:` | exempt: clock time |
| Dates | public-src/views/analytics-facts.ts | `.toLocaleDateString(locale, { weekday:` | exempt: weekday name |
| Dates | public-src/views/analytics.ts | `.toLocaleDateString(locale, { month:` | exempt: chart axis tick |
| Dates | public-src/views/analytics.ts | `.toLocaleDateString(locale, { day:` | exempt: chart axis tick |
| Dates | public-src/views/analytics.ts | `.toLocaleDateString(locale, { weekday:` | exempt: weekday name |
| Dates | public-src/views/analytics/calendar.ts | `.toLocaleTimeString(locale, { hour:` | exempt: clock time |
| Dates | public-src/views/analytics/calendar.ts | `.toLocaleDateString(locale, { month:` | exempt: month tick |
| Dates | public-src/views/analytics/calendar.ts | `.toLocaleDateString(locale, { weekday:` | exempt: weekday name |
| Dates | public-src/views/analytics/world-map.ts | `.toLocaleString(locale))} km</span></div>`);` | exempt: number, not a date |
| Dates | public-src/views/shots/index.ts | `.toLocaleDateString(locale, { day:` | exempt: chart axis tick |
