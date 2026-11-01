// Boot step (#1615): the shot detail's toolbar -- exports, share card,
// chart tabs and fullscreen, quick clone, shot photo. Moved verbatim out of
// main.ts's DOMContentLoaded handler; run through runStep() so a missing
// element only skips this step.

import { quickClone, uploadShotImage, removeShotImage, openShotPhotoLightbox, switchChartTab,
         openChartFullscreen, closeChartFullscreen, switchFsTab, exportAllCSV, exportShot, exportProfile,
         shareCard } from '../views/shots.js';
import { openPhotoInput, showCameraButtons } from '../photo-capture.js';

// #957: shot curve data is fetched lazily per shot (list rows are
// metadata-only). Views reach the cache through these window globals, same
// as they already do for getShotData / calcShotScore.

export function wireShotDetail(): void {
  document.getElementById('exportAllCsvBtn')!.addEventListener('click', () => { void exportAllCSV(); });
  document.getElementById('exportShotBtn')!.addEventListener('click', () => { void exportShot(); });
  document.getElementById('exportProfileBtn')!.addEventListener('click', () => { void exportProfile(); });
  // Share-card format picker: toggle dropdown, pick format on option click
  document.getElementById('shareCardBtn')!.addEventListener('click', () => {
    const menu = document.getElementById('cardFmtMenu')!;
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  });
  document.getElementById('cardFmtMenu')!.addEventListener('click', e => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>('.card-fmt-opt');
    if (!opt) return;
    document.getElementById('cardFmtMenu')!.style.display = 'none';
    void shareCard(opt.dataset.format);
  });
  document.addEventListener('click', e => {
    if (!document.getElementById('cardFmtWrap')!.contains(e.target as Node))
      document.getElementById('cardFmtMenu')!.style.display = 'none';
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
