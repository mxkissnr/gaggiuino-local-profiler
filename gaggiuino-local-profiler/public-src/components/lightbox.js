// Reusable fullscreen image lightbox (#287). Given an image URL, shows a
// dark overlay with the image centered and scaled to fit the viewport.
// Closeable via backdrop click, the close (×) button, or Escape.
import { t } from '../i18n.js';

export function openLightbox(url) {
  if (!url) return;

  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.innerHTML = `
    <button type="button" class="lightbox-close" aria-label="${t('lightbox_close')}">✕</button>
    <img class="lightbox-img" src="${url}" alt="">`;
  document.body.appendChild(overlay);

  function close() {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.lightbox-close').addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);
}
