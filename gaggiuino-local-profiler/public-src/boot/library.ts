// Boot step (#1615): the library's tabs and entity forms, the profile
// editor, the scan modal and the flavor wheel backdrop. Moved verbatim out
// of main.ts's DOMContentLoaded handler; run through runStep() so a missing
// element only skips this step.
import { S } from '../state/index.js';
import { closeFlavorWheel } from '../components/flavor-wheel.js';
import { switchLibTab, openBeanForm, discardBeanForm, saveBean, saveBeanNoBag, saveBeanAddBag,
         uploadBeanImage, stageNewBeanImage, cutOutBeanSticker, openGrinderForm, closeGrinderForm,
         saveGrinder, uploadGrinderImage, openRecipeForm, closeRecipeForm, saveRecipe, addRecipeStep,
         toggleUrlImport, importFromUrl, toggleImportSettings, addCustomShopifyDomain, openScanModal,
         closeScanModal, _handleScanPhoto, openMilkForm, closeMilkForm, saveMilk, openBasketForm,
         closeBasketForm, saveBasket, uploadBasketImage, openPuckScreenForm, closePuckScreenForm,
         savePuckScreen, uploadPuckScreenImage } from '../views/library.js';
import { closeProfileForm, openNewProfileForm, applyBeanSuggestion, addProfilePhase, sendProfileToMachine,
         renderProfilePreviewChart } from '../views/library-profile-editor.js';
import { openNewGaggiMateProfile } from '../views/gaggimate-profile-editor.js';

// Profile creation/editing branches to the GaggiMate editor instead of the
// Gaggiuino one for GaggiMate machines — checked here and by the click delegation.
export function isActiveMachineGaggiMate(): boolean {
  return (S.machines || []).find(m => m.id === S.activeMachineId)?.type === 'gaggimate';
}

export function wireLibrary(): void {
  document.getElementById('libTabBeans')!.addEventListener('click', () => switchLibTab('beans'));
  document.getElementById('libTabGrinders')!.addEventListener('click', () => switchLibTab('grinders'));
  document.getElementById('libTabRecipes')!.addEventListener('click', () => switchLibTab('recipes'));
  document.getElementById('libTabMilk')!.addEventListener('click', () => switchLibTab('milk'));
  document.getElementById('libTabProfiles')!.addEventListener('click', () => switchLibTab('profiles'));
  // Cancel is an explicit discard: close without the unsaved-changes prompt.
  document.getElementById('closeBeanFormBtn')!.addEventListener('click', discardBeanForm);
  document.getElementById('saveBeanBtn')!.addEventListener('click', () => { void saveBean(); });
  document.getElementById('saveBeanNoBagBtn')!.addEventListener('click', () => { void saveBeanNoBag(); });
  document.getElementById('saveBeanAddBagBtn')!.addEventListener('click', () => { void saveBeanAddBag(); });
  document.getElementById('beanAddTrigger')!.addEventListener('click', () => openBeanForm());
  document.getElementById('openScanModalBtn')!.addEventListener('click', () => { void openScanModal(); });
  document.getElementById('toggleUrlImportBtn')!.addEventListener('click', toggleUrlImport);
  document.getElementById('urlImportInput')!.addEventListener('keydown', e => { if (e.key === 'Enter') void importFromUrl(); });
  document.getElementById('importFromUrlBtn')!.addEventListener('click', () => { void importFromUrl(); });
  document.getElementById('toggleImportSettingsBtn')!.addEventListener('click', () => { void toggleImportSettings(); });
  document.getElementById('importSettingsAddDomainBtn')!.addEventListener('click', () => { void addCustomShopifyDomain(); });
  document.getElementById('importSettingsDomainInput')!.addEventListener('keydown', e => { if (e.key === 'Enter') void addCustomShopifyDomain(); });
  document.getElementById('closeGrinderFormBtn')!.addEventListener('click', closeGrinderForm);
  document.getElementById('saveGrinderBtn')!.addEventListener('click', () => { void saveGrinder(); });
  document.getElementById('grinderAddTrigger')!.addEventListener('click', () => openGrinderForm());
  document.getElementById('grinderFormImagePickBtn')!.addEventListener('click', () => document.getElementById('grinderFormImage')!.click());
  document.getElementById('grinderFormImage')!.addEventListener('change', function (this: HTMLInputElement) {
    if (S.grinderEditId) void uploadGrinderImage(S.grinderEditId, this);
  });
  document.getElementById('beanFormImagePickBtn')!.addEventListener('click', () => document.getElementById('beanFormImage')!.click());
  document.getElementById('beanFormImage')!.addEventListener('change', function (this: HTMLInputElement) {
    // #1329 part 2: creating stages the cropped photo until the bean is saved.
    if (S.beanEditId) void uploadBeanImage(S.beanEditId, this);
    else void stageNewBeanImage(this);
  });
  document.getElementById('beanFormStickerBtn')!.addEventListener('click', () => { void cutOutBeanSticker(); });
  document.getElementById('addRecipeStepBtn')!.addEventListener('click', addRecipeStep);
  document.getElementById('closeRecipeFormBtn')!.addEventListener('click', closeRecipeForm);
  document.getElementById('saveRecipeBtn')!.addEventListener('click', () => { void saveRecipe(); });
  document.getElementById('recipeAddTrigger')!.addEventListener('click', () => openRecipeForm());
  document.getElementById('closeMilkFormBtn')!.addEventListener('click', closeMilkForm);
  document.getElementById('saveMilkBtn')!.addEventListener('click', () => { void saveMilk(); });
  document.getElementById('milkAddTrigger')!.addEventListener('click', openMilkForm);
  document.getElementById('libTabBaskets')!.addEventListener('click', () => switchLibTab('baskets'));
  document.getElementById('libTabPuckScreens')!.addEventListener('click', () => switchLibTab('puckscreens'));
  document.getElementById('closeBasketFormBtn')!.addEventListener('click', closeBasketForm);
  document.getElementById('saveBasketBtn')!.addEventListener('click', () => { void saveBasket(); });
  document.getElementById('basketAddTrigger')!.addEventListener('click', () => openBasketForm());
  document.getElementById('basketFormImagePickBtn')!.addEventListener('click', () => document.getElementById('basketFormImage')!.click());
  document.getElementById('basketFormImage')!.addEventListener('change', function (this: HTMLInputElement) {
    if (S.basketEditId) void uploadBasketImage(S.basketEditId, this);
  });
  document.getElementById('closePuckScreenFormBtn')!.addEventListener('click', closePuckScreenForm);
  document.getElementById('savePuckScreenBtn')!.addEventListener('click', () => { void savePuckScreen(); });
  document.getElementById('puckScreenAddTrigger')!.addEventListener('click', () => openPuckScreenForm());
  document.getElementById('puckScreenFormImagePickBtn')!.addEventListener('click', () => document.getElementById('puckScreenFormImage')!.click());
  document.getElementById('puckScreenFormImage')!.addEventListener('change', function (this: HTMLInputElement) {
    if (S.puckScreenEditId) void uploadPuckScreenImage(S.puckScreenEditId, this);
  });
  document.getElementById('profileAddTrigger')!.addEventListener('click', () => {
    if (isActiveMachineGaggiMate()) openNewGaggiMateProfile();
    else openNewProfileForm();
  });
  document.getElementById('closeProfileFormBtn')!.addEventListener('click', closeProfileForm);
  document.getElementById('cancelProfileFormBtn')!.addEventListener('click', closeProfileForm);
  document.getElementById('addProfilePhaseBtn')!.addEventListener('click', addProfilePhase);
  document.getElementById('profileApplySuggestionBtn')!.addEventListener('click', applyBeanSuggestion);
  document.getElementById('sendProfileToMachineBtn')!.addEventListener('click', () => { void sendProfileToMachine(); });
  // Live preview: any field/phase edit re-synthesizes the chart from the
  // current DOM state (same DOM-as-state source of truth as _collectPhases()).
  document.getElementById('profileEditorModal')!.addEventListener('input', renderProfilePreviewChart);
  document.getElementById('profileEditorModal')!.addEventListener('change', renderProfilePreviewChart);
  document.getElementById('closeScanModalBtn')!.addEventListener('click', closeScanModal);
  // #1536: a picked photo is read with the same decoder as the live loop, so it
  // works when the camera is unavailable (e.g. plain http). Clearing the value
  // afterwards lets the same picture be chosen again.
  const scanPhotoInput = document.getElementById('scanPhotoInput') as HTMLInputElement | null;
  if (scanPhotoInput) {
    const input = scanPhotoInput;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) void _handleScanPhoto(file);
    });
  }
  // Tapping the dimmed backdrop (not the modal content itself) closes it —
  // there was no way back out of the flavor wheel on mobile without this.
  document.getElementById('flavorWheelModal')?.addEventListener('click', e => {
    if ((e.target as HTMLElement).id === 'flavorWheelModal') closeFlavorWheel();
  });
}
