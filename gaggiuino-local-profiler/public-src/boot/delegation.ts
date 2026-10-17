// Boot step (#1615): document-level click/change delegation for every
// data-action element in dynamically rendered content. Moved verbatim out of
// main.ts's DOMContentLoaded handler; run through runStep() so a failure only
// skips this step.
import { S } from '../state/index.js';
import { toggleMonthGroup, clearBeanFilter } from '../components/sidebar.js';
import { switchMode, goToShot } from '../components/mode.js';
import { loadData, restoreShot, permanentDeleteShot, selectDrinkType, selectMilkType, selectFrozenPortion } from '../views/shots.js';
import { openCalendarDayDetail, setBeanShelfSort, expandBeanShelf, openBeanShelfDetail,
         setDialinProgressionBean, openFactDetail, shuffleFacts } from '../views/analytics.js';
import { markMaintDone, saveMaintThreshold, setMaintMode, setMaintScope, deleteMaintLogEntry,
         openGuidedMaint, closeGuidedMaint, submitGuidedMaint, updateGuidedMaintDoneState,
         toggleMaintDisabled, addCustomMaintTask, deleteCustomMaintTask, renameCustomMaintTask } from '../views/maintenance.js';
import { openFlavorWheel, closeFlavorWheel, zoomFlavorWheelTo, highlightFlavorWheelNode } from '../components/flavor-wheel.js';
import { highlightSheetFlavor } from '../components/flavor-mini-wheel.js';
import { closeDetailSheet } from '../components/detail-sheet.js';
import { requestCloseBeanForm, editBean, deleteBean, toggleBeanActive, editGrinder, deleteGrinder,
         resetGrinderBurrs, deleteGrinderZeroPointEntry, toggleBeanQR, openNewBagForm, closeNewBagForm,
         saveNewBag, deleteBag, openEditBag, closeEditBag, saveEditBag, openBagStockEdit, closeBagStockEdit,
         saveBagStock, markBagEmpty, togglePastBags, openBeanSheet, closeBeanSheet, requestCloseBeanSheet,
         toggleBagCard, openFreezeForm, closeFreezeForm, saveFreezePortions, thawPortion, filterShotsByBean,
         openEditFrozenForm, closeEditFrozenForm, saveEditFrozenForm, editRecipe, deleteRecipe,
         removeRecipeStep, _submitManualScan, restockMilk, deleteMilk, editBasket, deleteBasket,
         editPuckScreen, deletePuckScreen } from '../views/library.js';
import { editProfile, duplicateProfile, deleteMachineProfile, createProfileFromBean, removeProfilePhase } from '../views/library-profile-editor.js';
import { openGaggiMateProfileEditor, duplicateGaggiMateProfile, openNewGaggiMateProfile, handleGmEditorAction } from '../views/gaggimate-profile-editor.js';
import { openDialinWizard, startDialinFromBean, dialinGrinderChange, dialinConfirmShot, dialinAcceptNext,
         dialinOverride, dialinEnd, dialinSaveKnownGrind, dialinClose } from '../views/dialin-wizard.js';
import { startProfileDialinFromList, profileDialinClose, profileDialinToggleSymptom, profileDialinAcceptNext,
         profileDialinOverride, profileDialinEnd, profileDialinConfirmShot } from '../views/profile-dialin-wizard.js';
import { switchActiveMachine, setDefaultMachine } from '../components/machines-settings.js';
import { closeSetupWizard, setupWizardGetStarted, setupWizardSkipToDemo } from '../views/setup-wizard.js';
import { closeEasterEggPanel } from '../components/topbar-machine-icon.js';
import { toggleFlush, confirmBrewFromDialog, cancelBrewFromDialog } from '../components/machine-control.js';
import { isActiveMachineGaggiMate } from './library.js';

export function wireDelegation(): void {
  // ── Global click delegation for dynamic content ────────────────────────
  document.body.addEventListener('click', e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el) return;
    const action = el.dataset.action!;
    const numId = () => Number(el.dataset.id);
    const strId = (): string => el.dataset.id as string;
    // GaggiMate profile editor actions all share one prefix — route by that
    // instead of listing all 18 action names as switch cases.
    if (action.startsWith('gm-')) { handleGmEditorAction(action, el); return; }
    switch (action) {
      case 'open-new-bag':       openNewBagForm(numId()); break;
      case 'close-new-bag':      closeNewBagForm(numId()); break;
      case 'save-new-bag':       void saveNewBag(numId()); break;
      case 'toggle-month-group':  toggleMonthGroup(strId()); break;
      case 'delete-bag':         void deleteBag(Number(el.dataset.beanId), Number(el.dataset.bagId)); break;
      case 'open-edit-bag':        openEditBag(Number(el.dataset.bagId)); break;
      case 'close-edit-bag':       closeEditBag(); break;
      case 'save-edit-bag':        void saveEditBag(Number(el.dataset.beanId), Number(el.dataset.bagId)); break;
      case 'open-bag-stock-edit':  openBagStockEdit(Number(el.dataset.bagId)); break;
      case 'close-bag-stock-edit': closeBagStockEdit(); break;
      case 'save-bag-stock-edit':  void saveBagStock(Number(el.dataset.beanId), Number(el.dataset.bagId)); break;
      case 'mark-bag-empty':       void markBagEmpty(Number(el.dataset.beanId), Number(el.dataset.bagId)); break;
      case 'toggle-bag-card':      toggleBagCard(Number(el.dataset.bagId)); break;
      case 'toggle-past-bags':     togglePastBags(numId()); break;
      case 'open-bean-sheet':     openBeanSheet(numId()); break;
      case 'close-bean-sheet':    requestCloseBeanSheet(); break;
    case 'close-bean-form-sheet': requestCloseBeanForm(); break;
      case 'open-freeze-form':   openFreezeForm(numId()); break;
      case 'close-freeze-form':  closeFreezeForm(numId()); break;
      case 'save-freeze-form':   void saveFreezePortions(numId()); break;
      case 'thaw-portion':       void thawPortion(Number(el.dataset.beanId), Number(el.dataset.portionId)); break;
      case 'open-edit-frozen-form':  openEditFrozenForm(Number(el.dataset.portionId)); break;
      case 'close-edit-frozen-form': closeEditFrozenForm(Number(el.dataset.portionId)); break;
      case 'save-edit-frozen-form':  void saveEditFrozenForm(numId(), Number(el.dataset.portionId)); break;
      case 'filter-by-bean':     closeBeanSheet(); filterShotsByBean(numId()); break;
      case 'clear-bean-filter':  clearBeanFilter(); break;
      case 'toggle-bean-qr':     toggleBeanQR(numId()); break;
      // #1500: manual barcode entry in the scan modal submits through this
      // delegation (no inline handler under the CSP); preventDefault keeps
      // the form from navigating the page on click or Enter.
      case 'scan-manual-submit': e.preventDefault(); _submitManualScan(); break;
      // #1536: the photo fallback opens the phone's camera app (a `capture`
      // file input), which needs no secure context, so it also works over http.
      case 'scan-take-photo': (document.getElementById('scanPhotoInput') as HTMLInputElement | null)?.click(); break;
      case 'edit-bean':          editBean(numId()); break;
      case 'delete-bean':        void deleteBean(numId()); break;
      case 'toggle-bean-active': void toggleBeanActive(numId()); break;
      case 'edit-grinder':       editGrinder(numId()); break;
      case 'delete-grinder':     void deleteGrinder(numId()); break;
      case 'reset-grinder-burrs': void resetGrinderBurrs(numId()); break;
      case 'delete-grinder-zero-point': void deleteGrinderZeroPointEntry(numId(), Number(el.dataset.since)); break;
      case 'edit-recipe':        editRecipe(numId()); break;
      case 'delete-recipe':      void deleteRecipe(numId()); break;
      case 'remove-recipe-step': removeRecipeStep(Number(el.dataset.idx)); break;
      case 'delete-milk':        void deleteMilk(numId()); break;
      case 'restock-milk':       void restockMilk(numId()); break;
      case 'edit-basket':        editBasket(numId()); break;
      case 'delete-basket':      void deleteBasket(numId()); break;
      case 'edit-puckscreen':    editPuckScreen(numId()); break;
      case 'delete-puckscreen':  void deletePuckScreen(numId()); break;
      case 'edit-profile':
        if (isActiveMachineGaggiMate()) void openGaggiMateProfileEditor(strId());
        else void editProfile(String(numId()));
        break;
      case 'duplicate-profile':
        if (isActiveMachineGaggiMate()) void duplicateGaggiMateProfile(strId());
        else void duplicateProfile(String(numId()));
        break;
      case 'delete-profile':        void deleteMachineProfile(strId()); break;
      case 'remove-profile-phase':  removeProfilePhase(Number(el.dataset.idx)); break;
      case 'create-profile-from-bean':
        closeBeanSheet();
        if (isActiveMachineGaggiMate()) openNewGaggiMateProfile();
        else createProfileFromBean(numId());
        break;
      case 'restore-shot':       void restoreShot(numId()); break;
      case 'perm-delete-shot':   void permanentDeleteShot(numId()); break;
      case 'select-drink':       selectDrinkType(strId()); break;
      case 'select-milk':        selectMilkType(strId()); break;
      case 'select-frozen-portion': selectFrozenPortion(strId()); break;
      case 'reload-data':        void loadData(); break;
      // #807: the "why is this empty" notices (in-view block and app-wide
      // banner, components/api-port-notice.ts) both link here.
      case 'goto-settings':      switchMode('settings'); break;
      case 'set-maint-mode':     void setMaintMode(el.dataset.task!, el.dataset.mode!, el.dataset.machineId, el.dataset.currentShots, el.dataset.currentDays, el.dataset.currentG); break;
      case 'mark-maint-done':    void markMaintDone(el.dataset.task!, el.dataset.machineId); break;
      case 'open-guided-maint':  openGuidedMaint(el.dataset.task!, el.dataset.machineId!); break;
      case 'toggle-maint-disabled': void toggleMaintDisabled(el.dataset.task!, el.dataset.machineId, el.dataset.disabled === 'true'); break;
      case 'add-custom-maint-task':  void addCustomMaintTask(el.dataset.machineId); break;
      case 'delete-custom-maint-task': void deleteCustomMaintTask(el.dataset.task!, el.dataset.machineId); break;
      case 'guided-maint-done':  void submitGuidedMaint(); break;
      case 'guided-maint-cancel': closeGuidedMaint(); break;
      case 'set-maint-scope':    setMaintScope(el.dataset.scope!); break;
      case 'toggle-maint-detail': el.closest('.maint-card')?.classList.toggle('expanded'); break;
      case 'set-bean-shelf-sort': setBeanShelfSort(el.dataset.sort === 'shots' ? 'shots' : 'score'); break;
      case 'expand-bean-shelf':   expandBeanShelf(); break;
      case 'analytics-bean':      openBeanShelfDetail(el.dataset.name!, el); break;
      case 'analytics-fact':      openFactDetail(el.dataset.fact!, el); break;
      case 'analytics-facts-shuffle': shuffleFacts(); break;
      case 'open-bean-shelf-in-library':
        closeDetailSheet();
        switchMode('library');
        openBeanSheet(numId());
        break;
      case 'analytics-day':      openCalendarDayDetail(el.dataset.day!, el); break;
      case 'open-flavor-wheel':   void openFlavorWheel(numId()); break;
      case 'close-flavor-wheel':  closeFlavorWheel(); break;
      case 'zoom-flavor-wheel':   zoomFlavorWheelTo(strId()); break;
      case 'highlight-flavor':        highlightSheetFlavor(el.dataset.flavorNode || null, el); break;
      case 'highlight-flavor-wheel':  highlightFlavorWheelNode(el.dataset.nodeId || null); break;
      case 'delete-maint-log':   void deleteMaintLogEntry(numId()); break;
      case 'goto-shot':          goToShot(numId()); break;
      case 'toggle-comp-grind':  document.getElementById('grindAdviceComparative')?.classList.toggle('expanded'); break;
      case 'start-dialin':           openDialinWizard(); break;
      case 'start-dialin-from-bean': closeBeanSheet(); startDialinFromBean(numId()); break;
      case 'dialin-confirm-shot':    void dialinConfirmShot(numId(), el.dataset.match === '1'); break;
      case 'dialin-accept-next':     dialinAcceptNext(); break;
      case 'dialin-override':        dialinOverride(); break;
      case 'dialin-end':             dialinEnd(); break;
      case 'dialin-save-known-grind': void dialinSaveKnownGrind(); break;
      case 'dialin-close':           dialinClose(); break;
      case 'start-profile-dialin':      void startProfileDialinFromList(strId()); break;
      case 'profile-dialin-symptom':    profileDialinToggleSymptom(el.dataset.symptom); break;
      case 'profile-dialin-confirm-shot': profileDialinConfirmShot(numId(), el.dataset.match === '1'); break;
      case 'profile-dialin-accept-next':  void profileDialinAcceptNext(); break;
      case 'profile-dialin-override':     void profileDialinOverride(); break;
      case 'profile-dialin-end':          profileDialinEnd(); break;
      case 'profile-dialin-close':        profileDialinClose(); break;
      case 'setup-wizard-close':          closeSetupWizard(); break;
      case 'setup-wizard-get-started':    setupWizardGetStarted(); break;
      case 'setup-wizard-skip-demo':      void setupWizardSkipToDemo(); break;
      case 'close-easter-egg':            closeEasterEggPanel(); break;
      // #1324: opt-in GaggiMate machine control.
      case 'machine-flush-toggle':        void toggleFlush(); break;
      case 'brew-confirm-start':          void confirmBrewFromDialog(); break;
      case 'brew-confirm-cancel':         void cancelBrewFromDialog(); break;
      // #1449: the Live tab's "not available for this machine" banner offers
      // to make the currently selected machine the default. Reuses the existing
      // setDefaultMachine() from components/machines-settings.ts unchanged -- it
      // already reloads the machine list, and loadMachines() ->
      // applyActiveMachineChange() reconnects the Live tab (window.connectLiveStream()
      // when S.currentMode === 'live'), so no new reload logic lives here.
      case 'live-set-default-machine':
        if (typeof S.activeMachineId === 'number') void setDefaultMachine(S.activeMachineId);
        break;
    }
  });

  document.body.addEventListener('change', e => {
    if ((e.target as HTMLElement).classList?.contains('guided-maint-check')) { updateGuidedMaintDoneState(); return; }
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'save-maint-threshold') {
      void saveMaintThreshold(el.dataset.task!, el.dataset.field!, (el as HTMLInputElement).value, el.dataset.machineId);
    }
    if (el.dataset.action === 'rename-maint-label') {
      void renameCustomMaintTask(el.dataset.task!, (el as HTMLInputElement).value, el.dataset.machineId);
    }
    if (el.dataset.action === 'dialin-grinder-select') {
      dialinGrinderChange();
    }
    if (el.dataset.action === 'switch-machine') {
      switchActiveMachine((el as HTMLInputElement).value);
    }
    if (el.dataset.action === 'dialin-progression-bean-change') {
      setDialinProgressionBean((el as HTMLInputElement).value);
    }
  });
}
