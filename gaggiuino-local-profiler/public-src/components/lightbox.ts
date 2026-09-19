// Reusable fullscreen image lightbox (#287). Given an image URL, shows a
// dark overlay with the image centered and scaled to fit the viewport.
// Closeable via backdrop click, the close (×) button, or Escape.
import { t } from '../i18n.js';
import { CLOSE_ICON_SVG } from '../icons.js';

export function openLightbox(url: string | null | undefined): void {
  if (!url) return;

  // Built via createElement + property assignment, not innerHTML string
  // interpolation (#369, CodeQL) — `url` is never parsed as HTML this way,
  // regardless of its contents, even though every current caller only ever
  // passes a browser-normalized blob URL read off an <img>.src.
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lightbox-close';
  closeBtn.setAttribute('aria-label', t('lightbox_close'));
  closeBtn.innerHTML = CLOSE_ICON_SVG;

  const img = document.createElement('img');
  img.className = 'lightbox-img';
  img.src = url;
  img.alt = '';

  overlay.appendChild(closeBtn);
  overlay.appendChild(img);
  document.body.appendChild(overlay);

  function close(): void {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);
}
