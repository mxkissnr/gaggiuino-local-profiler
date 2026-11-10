# Interaction rule inventory (#1962)

Every existing control that breaks a rule in the "Interaction rules" section of [DESIGN.md](DESIGN.md), with the slice that migrates it. A slice removes its rows when it migrates them. This file and the test that checks it are deleted once the table is empty.

"Slice" is a slice of #1962 (`S<n>`), `exempt: <why it does not break the rule>`, or `open: <decision the maintainer still has to make>`. "Anchor" is a literal string that must occur in the file. test/interaction-inventory.test.ts checks every row: the file exists and the anchor occurs in it. For "Dates" and "Numbers" (min, max, step) it also scans public-src and fails if a file has more or fewer violations than rows, and for "Confirming" it compares the rows with eslint-suppressions.json. "Saving" applies to records in the library and on shots. A settings card is a form with a save button, which the "Switches" rule expects.

| Rule | File | Anchor | Slice |
|---|---|---|---|
| Choosing | public-src/index.html | `id="basketFormWallType"` | S3 |
| Choosing | public-src/index.html | `id="basketFormShape"` | S3 |
| Choosing | public-src/index.html | `id="puckScreenFormThickness"` | S3 |
| Choosing | public-src/index.html | `id="dialinCount"` | S3 |
| Choosing | public-src/index.html | `id="machineFormType"` | S3 |
| Choosing | public-src/index.html | `id="machineFormReleaseChannel"` | S3 |
| Choosing | public-src/views/library.ts | `id="libShelfSort"` | S3 |
| Confirming | public-src/components/machine-backups.ts | `return confirm(` | S4 |
| Confirming | public-src/components/machine-backups.ts | `confirm(t('mbk_delete_confirm'))` | S4 |
| Confirming | public-src/components/machine-backups.ts | `confirm(t('mbk_download_secrets_confirm'))` | S4 |
| Confirming | public-src/components/machines-settings.ts | `confirm(t(confirmKey))` | S4 |
| Errors | public-src/components/machine-backups.ts | `showToast(t('mbk_keep_range'))` | S4 |
| Choosing | public-src/components/machine-backups.ts | `mbk-select mbk-schedule` | S4 |
| Dates | public-src/components/machine-backups.ts | `new Intl.DateTimeFormat(locale, { dateStyle:` | S4 |
| States | public-src/components/machines-settings.ts | `settings card just stays empty` | S4 |
| Confirming | public-src/components/backup-modal.ts | `alert(t('backup_invalid'))` | S5 |
| Confirming | public-src/components/backup-modal.ts | `alert(t('backup_error', (e as Error).message))` | S5 |
| Confirming | public-src/components/backup-modal.ts | `alert(t('backup_invalid'))` | S5 |
| Confirming | public-src/components/backup-modal.ts | `alert(t('backup_error', (e as Error).message))` | S5 |
| Confirming | public-src/components/backup-modal.ts | `alert(res.imagesFailed && res.imagesFailed > 0` | S5 |
| Confirming | public-src/views/shots/export.ts | `alert(t('profile_export_no_data'))` | S5 |
| Confirming | public-src/views/shots/export.ts | `alert(t('error_generic', (e as Error).message))` | S5 |
| Confirming | public-src/views/shots/index.ts | `alert(t('error_generic', (e as Error).message))` | S5 |
| Confirming | public-src/views/shots/index.ts | `alert(t('error_generic', (e as Error).message))` | S5 |
| Confirming | public-src/views/shots/index.ts | `confirm(t('confirm_perm_delete', id))` | S5 |
| Confirming | public-src/views/shots/index.ts | `alert(t('error_generic', (e as Error).message))` | S5 |
| Errors | public-src/views/shots/index.ts | `catch { /* ignore */ }` | S5 |
| Dates | public-src/views/shots/export.ts | `.toLocaleString(localeFor(S.currentLang));` | S5 |
| Confirming | public-src/views/library/import.ts | `alert(t('lib_url_unsupported'))` | S6 |
| Confirming | public-src/views/library/import.ts | `alert(t('lib_url_error'))` | S6 |
| Confirming | public-src/views/library/import.ts | `alert(t('lib_url_error'))` | S6 |
| Confirming | public-src/views/library/import.ts | `alert(t('lib_import_settings_invalid_domain'))` | S6 |
| Errors | public-src/views/library/import.ts | `if (!r.ok) return;` | S6 |
| Switches | public-src/views/library/import.ts | `data-provider-id="${esc(p.id)}"` | S6 |
| Errors | public-src/views/gaggimate-profile-editor.ts | `t('gm_toast_name_required')` | S6 |
| Choosing | public-src/views/gaggimate-profile-editor.ts | `function _phaseTypeSelect` | S6 |
| Numbers | public-src/views/gaggimate-profile-editor.ts | `id="gm-std-vol-${esc(i)}"` | S6 |
| Numbers | public-src/views/gaggimate-profile-editor.ts | `id="gm-pro-pressure-${esc(i)}"` | S6 |
| Numbers | public-src/views/gaggimate-profile-editor.ts | `id="gm-pro-flow-${esc(i)}"` | S6 |
| Numbers | public-src/views/gaggimate-profile-editor.ts | `id="gm-pro-ramp-duration-${esc(i)}"` | S6 |
| Numbers | public-src/views/gaggimate-profile-editor.ts | `<input type="number" class="lib-input" style="width:80px"` | S6 |
| Confirming | public-src/views/library/baskets.ts | `confirm(t('lib_confirm_delete_basket'))` | S7 |
| Confirming | public-src/views/library/grinders.ts | `confirm(t('lib_grinder_confirm_reset_burrs'))` | S7 |
| Confirming | public-src/views/library/grinders.ts | `confirm(t('lib_confirm_delete_grinder'))` | S7 |
| Confirming | public-src/views/library/milk.ts | `confirm(t('lib_milk_delete') + '?')` | S7 |
| Confirming | public-src/views/library/puck-screens.ts | `confirm(t('lib_confirm_delete_puckscreen'))` | S7 |
| Confirming | public-src/views/library/recipes.ts | `confirm(t('lib_confirm_delete_recipe'))` | S7 |
| Errors | public-src/views/library/baskets.ts | `if (!saved) return;` | S7 |
| Errors | public-src/views/library/baskets.ts | `if (!r.ok) return;` | S7 |
| Errors | public-src/views/library/grinders.ts | `if (!first) return;` | S7 |
| Errors | public-src/views/library/grinders.ts | `if (!saved) return;` | S7 |
| Errors | public-src/views/library/grinders.ts | `if (!r.ok) return;` | S7 |
| Errors | public-src/views/library/milk.ts | `if (!saved) return;` | S7 |
| Errors | public-src/views/library/milk.ts | `if (!saved) return;` | S7 |
| Errors | public-src/views/library/milk.ts | `if (!r.ok) return;` | S7 |
| Errors | public-src/views/library/puck-screens.ts | `if (!saved) return;` | S7 |
| Errors | public-src/views/library/puck-screens.ts | `if (!r.ok) return;` | S7 |
| Errors | public-src/views/library/recipes.ts | `if (!saved) return;` | S7 |
| Errors | public-src/views/library/recipes.ts | `if (!r.ok) return;` | S7 |
| Numbers | public-src/views/library/milk.ts | `id="milkRestock_${esc(m.id)}"` | S7 |
| Numbers | public-src/views/library/recipes.ts | `<input class="lib-step-dur" type="number" min="0" step="1"` | S7 |
| Dates | public-src/views/library/grinders.ts | `.toLocaleDateString();` | S7 |
| Confirming | public-src/views/library-profile-editor.ts | `confirm(t('profile_confirm_delete'))` | S8 |
| Confirming | public-src/views/library-profile-editor.ts | `confirm(t('profile_confirm_send'))` | S8 |
| Confirming | public-src/views/maintenance.ts | `confirm(t('maint_confirm_delete_custom', task.replace('custom_', '')))` | S8 |
| Confirming | public-src/views/maintenance.ts | `confirm(t('maint_log_confirm_delete'))` | S8 |
| Confirming | public-src/views/orders.ts | `confirm(t('orders_confirm_delete_item'))` | S8 |
| Confirming | public-src/views/orders.ts | `confirm(t('orders_confirm_clear_history'))` | S8 |
| Confirming | public-src/views/orders.ts | `confirm(t('orders_kiosk_link_rotate_confirm'))` | S8 |
| Errors | public-src/views/library-profile-editor.ts | `getElementById('profileFormName') as HTMLInputElement).focus(); return` | S8 |
| Errors | public-src/views/orders.ts | `Save failed` | S8 |
| Errors | public-src/views/maintenance.ts | `catch { /* ignore */ }` | S8 |
| Errors | public-src/views/maintenance.ts | `catch { /* ignore */ }` | S8 |
| Errors | public-src/views/maintenance.ts | `catch { /* ignore */ }` | S8 |
| Errors | public-src/views/maintenance.ts | `catch { /* ignore */ }` | S8 |
| Errors | public-src/views/maintenance.ts | `catch { /* ignore */ }` | S8 |
| Errors | public-src/views/maintenance.ts | `catch { /* ignore */ }` | S8 |
| Errors | public-src/views/maintenance.ts | `catch { /* ignore */ }` | S8 |
| Errors | public-src/views/maintenance.ts | `catch { /* ignore */ }` | S8 |
| Errors | public-src/views/maintenance.ts | `catch { /* ignore */ }` | S8 |
| Errors | public-src/views/maintenance.ts | `catch { /* ignore */ }` | S8 |
| Choosing | public-src/views/library-profile-editor.ts | `class="pp-type"` | S8 |
| Choosing | public-src/views/library-profile-editor.ts | `class="pp-target-curve"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-target-start"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-target-end"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-target-time"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-target-volume"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-restriction"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-water-temp"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-stop-time"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-stop-pressure-above"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-stop-pressure-below"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-stop-flow-above"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-stop-flow-below"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-stop-weight"` | S8 |
| Numbers | public-src/views/library-profile-editor.ts | `id="profilePhase${esc(i)}-stop-water-pumped"` | S8 |
| Numbers | public-src/views/maintenance-sheet.ts | `<input type="number" min="1" max="10000" value="${esc(d.th` | S8 |
| Numbers | public-src/views/maintenance-sheet.ts | `<input type="number" min="1" max="3650" value="${esc(d.thr` | S8 |
| Numbers | public-src/views/maintenance-sheet.ts | `<input type="number" min="1" max="100000" value="${esc(d.t` | S8 |
| Numbers | public-src/views/maintenance-sheet.ts | `id="customTaskShots"` | S8 |
| Numbers | public-src/views/maintenance-sheet.ts | `id="customTaskDays"` | S8 |
| Numbers | public-src/views/orders.ts | `id="etaCustom_${esc(o.id)}"` | S8 |
| Numbers | public-src/views/orders.ts | `id="milkMl_${esc(item.id)}"` | S8 |
| Dates | public-src/views/maintenance-sheet.ts | `.toLocaleDateString(locale, { day:` | S8 |
| Dates | public-src/views/maintenance.ts | `.toLocaleDateString(locale, { day:` | S8 |
| Dates | public-src/views/orders.ts | `.toLocaleDateString(localeFor(S.currentLang), { da` | S8 |
| Dates | public-src/views/achievements.ts | `.toLocaleDateString(locale, { day:` | S9 |
| Dates | public-src/views/achievements.ts | `.toLocaleDateString(localeFor(lang), { day:` | S9 |
| Dates | public-src/views/analytics-facts.ts | `.toLocaleDateString(locale, _dateOpts(d, { day:` | S9 |
| Dates | public-src/views/analytics-facts.ts | `.toLocaleDateString(locale, _dateOpts(d, { weekday` | S9 |
| Dates | public-src/views/analytics.ts | `.toLocaleString(locale, { day:` | S9 |
| Dates | public-src/views/analytics.ts | `.toLocaleDateString(locale, { day:` | S9 |
| Dates | public-src/views/analytics/calendar.ts | `.toLocaleDateString(locale, { weekday:` | S9 |
| Dates | public-src/views/analytics/calendar.ts | `.toLocaleDateString(locale, { weekday:` | S9 |
| Dates | public-src/views/analytics/shared.ts | `.toLocaleDateString(locale, { day:` | S9 |
| Dates | public-src/views/dialin.ts | `.toLocaleDateString(locale, { day:` | S12 |
| Numbers | public-src/index.html | `id="annDose"` | S10 |
| Numbers | public-src/index.html | `id="grinderFormZeroPoint"` | S10 |
| Numbers | public-src/index.html | `id="recipeFormDose"` | S10 |
| Numbers | public-src/index.html | `id="recipeFormYield"` | S10 |
| Numbers | public-src/index.html | `id="recipeFormTime"` | S10 |
| Numbers | public-src/index.html | `id="recipeFormWaterG"` | S10 |
| Numbers | public-src/index.html | `id="recipeFormIceG"` | S10 |
| Numbers | public-src/index.html | `id="milkFormStock"` | S10 |
| Numbers | public-src/index.html | `id="profileFormCoffeeIn"` | S10 |
| Numbers | public-src/index.html | `id="profileFormCoffeeOut"` | S10 |
| Numbers | public-src/index.html | `id="profileFormRatio"` | S10 |
| Numbers | public-src/index.html | `id="profileFormWeight"` | S10 |
| Numbers | public-src/index.html | `id="lsDose"` | S10 |
| Numbers | public-src/index.html | `id="sdDose"` | S10 |
| Numbers | public-src/index.html | `id="mqttPort"` | S10 |
| Number comma | public-src/index.html | `type="number"` | S10 |
| Switches | public-src/boot/popups.ts | `id="popupsEnabled"` | S10 |
| Switches | public-src/boot/popups.ts | `id="popupsWhatsNew"` | S10 |
| Switches | public-src/boot/popups.ts | `id="popupsAchievements"` | S10 |
| Switches | public-src/components/bottom-nav.ts | `checkbox.type = 'checkbox'` | S10 |
| Switches | public-src/index.html | `id="devBlindRating"` | S10 |
| Switches | public-src/index.html | `id="machineControlEnabled"` | S10 |
| Number units | public-src/i18n/en.ts | `lib_milk_restock:` | S7 |
| Number units | public-src/i18n/en.ts | `profile_stop_pressure_above:` | S11 |
| Number units | public-src/i18n/en.ts | `profile_stop_pressure_below:` | S11 |
| Number units | public-src/i18n/en.ts | `profile_stop_flow_above:` | S11 |
| Number units | public-src/i18n/en.ts | `profile_stop_flow_below:` | S11 |
| Number units | public-src/i18n/en.ts | `profile_phase_target_start:` | S11 |
| Number units | public-src/i18n/en.ts | `profile_phase_target_end:` | S11 |
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
| Confirming | public-src/views/library/bean-card.ts | `confirm(t('lib_bag_delete_confirm'))` | S15 |
| Confirming | public-src/views/library/bean-card.ts | `alert(t('bean_qr_error'))` | S15 |
| Confirming | public-src/views/library/bean-form-sheet.ts | `confirm(t('lib_confirm_delete_bean'))` | S15 |
| Confirming | public-src/views/library/bean-sticker.ts | `alert(t('error_generic', err.error` | S15 |
| Errors | public-src/views/library/bags.ts | `if (!saved) return;` | S15 |
| Errors | public-src/views/library/bags.ts | `if (!saved) return false;` | S15 |
| Errors | public-src/views/library/bean-card.ts | `if (!saved) return;` | S15 |
| Errors | public-src/views/library/bean-card.ts | `if (!saved) return;` | S15 |
| Errors | public-src/views/library/bean-card.ts | `if (!saved) return;` | S15 |
| Errors | public-src/views/library/bean-card.ts | `if (!saved) return;` | S15 |
| Errors | public-src/views/library/bean-card.ts | `if (!saved) return;` | S15 |
| Errors | public-src/views/library/bean-form-sheet.ts | `if (!r.ok) return;` | S15 |
| Errors | public-src/views/library/bean-sheet.ts | `if (!saved) return;` | S15 |
| Saving | public-src/views/library/bean-card.ts | `save-edit-frozen-form` | exempt: inline form re-renders on save, so it keeps its save button |
| Numbers | public-src/views/library/bags.ts | `id="bagStockEditInput${esc(bg.id)}"` | S15 |
| Numbers | public-src/views/library/bags.ts | `id="editBagStock${esc(bg.id)}"` | S15 |
| Numbers | public-src/views/library/bags.ts | `id="editBagPrice${esc(bg.id)}"` | S15 |
| Numbers | public-src/views/library/bean-card.ts | `id="editFrozenWeight${esc(fp.id)}"` | S15 |
| Numbers | public-src/views/library/bean-card.ts | `id="newBagStock${esc(b.id)}"` | S15 |
| Numbers | public-src/views/library/bean-card.ts | `id="freezePortionCount${esc(b.id)}"` | S15 |
| Numbers | public-src/views/library/bean-card.ts | `id="freezePortionWeight${esc(b.id)}"` | S15 |
| Dates | public-src/views/library/bean-card.ts | `.toLocaleDateString(locale, { day:` | S15 |
| Dates | public-src/views/library/bean-card.ts | `.toLocaleDateString(locale, { day:` | S15 |
| Dates | public-src/views/library/bean-card.ts | `.toLocaleDateString(locale, { day:` | S15 |
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
