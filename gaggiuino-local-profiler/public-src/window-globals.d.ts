// Ambient declarations for the cross-module entry points main.js wires onto
// `window` (kept off direct imports to avoid circular deps). i18n.ts declares
// the translation/view entry points in its own `declare global` block; these
// are the remaining ones the components/ tree calls.
interface Window {
  loadData?: () => void | Promise<void>;
  loadLibrary?: () => void | Promise<void>;
  showToast?: (message: string) => void;
  calcShotScore?: (shot: unknown) => number | null;
  flushAutoSave?: () => void;
  switchMode?: (mode: string) => void;
  connectLiveStream?: () => void;
  disconnectLiveStream?: () => void;
  updateFlapCounter?: (count: number) => void;
  trashShot?: (id: number) => void;
  selectShot?: (id: number) => void;
  startOrdersPolling?: () => void;
  stopOrdersPolling?: () => void;
  renderMachinesList?: () => void;
  populateRefSelector?: () => void;
  loadOrdersView?: () => void;
  loadMaintenanceView?: () => void;
  loadAchievementsView?: () => void;
  setAccentTheme?: (key: string) => void;
  initAnalytics?: () => void;
  renderDialin?: () => void;
  renderBeanList?: () => void;
  renderGrinderList?: () => void;
  ensureCurves?: (ids: number[]) => Promise<void>;
  getShotDataById?: (id: number) => { pressure?: { x: number; y: number }[] } | null;
  getRawCurve?: (id: number | null | undefined) => unknown;
  getShotCurve?: (id: number | null | undefined) => Promise<unknown>;
  onAllShotMetaLoaded?: (() => void) | null;
  goToShot?: (id: number) => void;
}
