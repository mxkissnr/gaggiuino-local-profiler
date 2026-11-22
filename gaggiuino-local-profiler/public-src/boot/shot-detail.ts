// Boot step (#1615): the shot detail's toolbar -- exports, share card,
// chart tabs and fullscreen, quick clone, shot photo. Moved verbatim out of
// main.ts's DOMContentLoaded handler; run through runStep() so a missing
// element only skips this step.
// #2152: the top app bar. Compare and Share open a sheet, the downloads sit
// in the overflow menu, and the rows marked data-shot-notes-open (All notes,
// the bean and grinder rows) open the note fields in the detail sheet.

import { quickClone, uploadShotImage, removeShotImage, openShotPhotoLightbox, switchChartTab,
         openChartFullscreen, closeChartFullscreen, switchFsTab, exportAllCSV, exportShot, exportProfile } from '../views/shots.js';
import { onShotCompareClick, openShotNotes, openShotShare } from '../views/shots/detail-page.js';
import { openPhotoInput, showCameraButtons } from '../photo-capture.js';

// #957: shot curve data is fetched lazily per shot (list rows are
// metadata-only). Views reach the cache through these window globals, same
// as they already do for getShotData / calcShotScore.

export function wireShotDetail(): void {
  document.getElementById('exportAllCsvBtn')!.addEventListener('click', () => { void exportAllCSV(); });
  document.getElementById('exportShotBtn')!.addEventListener('click', () => { void exportShot(); });
  document.getElementById('exportProfileBtn')!.addEventListener('click', () => { void exportProfile(); });
  // The overflow menu folds after a pick and on a click anywhere else.
  const more = document.getElementById('shotMore') as HTMLDetailsElement;
  more.addEventListener('click', e => {
    if ((e.target as HTMLElement).closest('.lib-sheet-menu-item')) more.open = false;
  });
  document.addEventListener('click', e => {
    if (more.open && !more.contains(e.target as Node)) more.open = false;
  });
  const shareBtn = document.getElementById('shareCardBtn')!;
  shareBtn.addEventListener('click', () => openShotShare(shareBtn));
  const compareBtn = document.getElementById('shotCompareBtn')!;
  compareBtn.addEventListener('click', () => onShotCompareClick(compareBtn));
  document.getElementById('chart-area')!.addEventListener('click', e => {
    if ((e.target as HTMLElement).closest('[data-shot-notes-open]')) openShotNotes();
  });
  document.getElementById('tabZeit')!.addEventListener('click', () => switchChartTab('zeit'));
  document.getElementById('tabPQ')!.addEventListener('click', () => switchChartTab('pq'));
  document.getElementById('expandChartBtn')!.addEventListener('click', openChartFullscreen);
  document.getElementById('fsTabZeit')!.addEventListener('click', () => switchFsTab('zeit'));
  document.getElementById('fsTabPQ')!.addEventListener('click', () => switchFsTab('pq'));
  document.getElementById('closeFullscreenBtn')!.addEventListener('click', closeChartFullscreen);
  document.getElementById('quickCloneBtn')!.addEventListener('click', quickClone);
  document.getElementById('annPhotoPickBtn')!.addEventListener('click', () => openPhotoInput(document.getElementById('annPhotoInput') as HTMLInputElement, { camera: false }));
  document.getElementById('annPhotoCameraBtn')!.addEventListener('click', () => openPhotoInput(document.getElementById('annPhotoInput') as HTMLInputElement, { camera: true }));
  showCameraButtons(['annPhotoCameraBtn']);
  document.getElementById('annPhotoInput')!.addEventListener('change', function (this: HTMLInputElement) { void uploadShotImage(this); });
  document.getElementById('annPhotoRemoveBtn')!.addEventListener('click', () => { void removeShotImage(); });
  document.getElementById('annPhotoThumb')!.addEventListener('click', openShotPhotoLightbox);
}
