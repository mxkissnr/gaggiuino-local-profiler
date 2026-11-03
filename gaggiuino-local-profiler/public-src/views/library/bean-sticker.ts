import { S } from '../../state/index.js';
import { t } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { invalidateBeanImage } from '../../bean-image.js';
import { apiFetch } from '../../api/transport.js';
import { openCropEditor, isValidCrop } from '../../components/image-crop.js';
import { cropAndUploadPhoto, adjustPhoto, saveNewPhoto, savedPhotoRow } from '../../photo-upload.js';
import type { NewPhoto, PhotoCropShape } from '../../photo-upload.js';
import { _beanList } from './bean-shared.js';
import type { BeanListRow } from './bean-shared.js';
import * as libraryView from '../library.js';

// Circular with library.ts (it re-exports this module): only ever touched at
// call time, never read at module load.
const library = libraryView;

// Same 3:4 crop the bean photo always had.
const BEAN_PHOTO: PhotoCropShape = { shape: 'square', aspect: 'portrait' };

// Photo chosen while *creating* a bean: the crop result can't be uploaded yet
// (no id), so it waits here until saveBeanInternal has created the bean. The
// cropped blob, its crop and the uncropped original all wait together, so the
// save path can store the original too. A staged cut-out also carries `sticker`.
let _stagedBeanImage: NewPhoto | null = null;

// The bean form reads and clears the staged create-mode photo through these.
export function stagedBeanImage(): NewPhoto | null { return _stagedBeanImage; }
export function clearStagedBeanImage(): void { _stagedBeanImage = null; }

export async function stageNewBeanImage(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  const staged = await openCropEditor(file, { ...BEAN_PHOTO });
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  if (!staged) return;
  _stagedBeanImage = staged;
  const hint = document.getElementById('beanFormImageStaged');
  if (hint) hint.style.display = '';
  void updateStickerButton();
}

// Shared post-upload step: store the server's updated bean row, drop the
// cached blob URL and redraw the list. Returns false — after the same generic
// alert this flow always showed — when the upload failed.
async function _storeBeanPhoto(id: number, r: Response): Promise<boolean> {
  const saved = await savedPhotoRow<BeanListRow>(r);
  if (!saved) return false;
  const idx = _beanList().findIndex(b => b.id === id);
  if (idx !== -1) _beanList()[idx] = saved;
  invalidateBeanImage(id);
  library.renderBeanList();
  void updateStickerButton();
  return true;
}

export async function uploadBeanImage(id: number, input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  const r = await cropAndUploadPhoto(libraryApi.libraryImageUrl('bean', id), file, BEAN_PHOTO);
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  if (!r) return;
  await _storeBeanPhoto(id, r);
}

// The cut-out editor and its onnxruntime runtime are heavy, so the bean form
// reaches them only through dynamic imports — the first-load bundle stays
// free of both. editor.ts (openStickerEditor) and segment.ts
// (isStickerCutoutAvailable) are this epic's earlier slices, already shipped
// on dev; this slice only wires them into the bean form and consumes both
// unchanged, so neither file is edited here.
// this module consumes only isStickerCutoutAvailable() from segment.ts; the
// model work (autoCutout/tapMask/resetCutout) is editor.ts's concern. Moving
// that work into a worker therefore leaves this call site unchanged.
function stickerEditorModule() {
  return import('../../components/sticker/editor.js');
}
function stickerSegmentModule() {
  return import('../../components/sticker/segment.js');
}

// Whether the bean form offers the Crop photo action: just the bean's row, and
// for a sticker additionally its stored original plus the cut-out models.
// A sticker is decided by the bean's `imageSticker` flag (#1884), not by the
// file type, so a PNG product photo from a shop import is a normal photo. A
// sticker main image is the finished PNG cut-out, so re-cropping it needs the
// original behind it; without one (or without the models) there is nothing to
// crop and the button stays hidden.
function _beanPhotoAdjustable(cutoutAvailable: boolean): boolean {
  const id = S.beanEditId;
  if (id == null) return false;
  const row = _beanList().find(b => b.id === id);
  if (!row?.image) return false;
  if (row.imageSticker !== true) return true;
  return isValidCrop(row.imageCrop) && cutoutAvailable;
}

// Drives both photo buttons of the bean form. The cut-out button
// (`beanFormStickerBtn`) appears only when the deployment ships the cut-out
// models and there is a photo to cut: an existing photo in edit mode, or a
// staged blob while creating. The other button keeps the earlier
// `beanFormImageAdjustBtn` name — the boot step and views/library.ts wire it
// by that id — and now shows the Crop photo action.
export async function updateStickerButton(): Promise<void> {
  const adjustBtn = document.getElementById('beanFormImageAdjustBtn') as HTMLButtonElement | null;
  // Set before the cut-out probe and before the sticker-button check below, so
  // a JPEG bean shows it at once and a missing sticker button never skips it; a
  // sticker waits for the probe's answer further down.
  if (adjustBtn) adjustBtn.style.display = _beanPhotoAdjustable(false) ? '' : 'none';
  const btn = document.getElementById('beanFormStickerBtn') as HTMLButtonElement | null;
  if (!btn) return;
  const id = S.beanEditId;
  const hasPhoto = id != null
    ? !!_beanList().find(b => b.id === id)?.image
    : _stagedBeanImage != null;
  if (!hasPhoto) { btn.style.display = 'none'; return; }
  let available = false;
  try {
    const { isStickerCutoutAvailable } = await stickerSegmentModule();
    available = await isStickerCutoutAvailable();
  } catch { /* probe failed: stay with the initial "not available" */ }
  // Re-read after the await: the form may have been closed or its photo
  // changed while the availability probe was in flight. Both helpers read
  // S.beanEditId at call time, so this covers the Adjust button too.
  if (adjustBtn) adjustBtn.style.display = _beanPhotoAdjustable(available) ? '' : 'none';
  const stillId = S.beanEditId;
  const stillHasPhoto = stillId != null
    ? !!_beanList().find(b => b.id === stillId)?.image
    : _stagedBeanImage != null;
  btn.style.display = available && stillHasPhoto ? '' : 'none';
}

/**
 * Re-crop the bean's photo. A JPEG is re-cropped from its stored original (or,
 * when it has none, opened on the current image and saved with an original);
 * a sticker crop runs first and the sticker editor turns the cropped area into
 * the new PNG photo, so the original survives the re-crop.
 *
 * Imported straight from here by bean-form-sheet.ts: views/library.ts only
 * re-exports the form's own entry points, so its list stays untouched.
 */
export async function adjustBeanImage(): Promise<void> {
  const id = S.beanEditId;
  if (id == null) return;
  const row = _beanList().find(b => b.id === id);
  if (!row?.image) return;
  const url = libraryApi.libraryImageUrl('bean', id);
  const sticker = row.imageSticker === true;
  const r = await adjustPhoto(url, row.imageCrop, BEAN_PHOTO, sticker
    ? async (cropped) => (await stickerEditorModule()).openStickerEditor(cropped)
    : undefined);
  if (!r) return;
  const stored = await _storeBeanPhoto(id, r);
  if (stored && sticker) window.showToast?.(t('sticker_done'));
}

/**
 * Cut the bean's photo out as a transparent sticker and replace the stored
 * photo with it. Edit mode uploads right away; create mode swaps the staged
 * blob in place so the regular save path uploads it.
 */
export async function cutOutBeanSticker(): Promise<void> {
  const btn = document.getElementById('beanFormStickerBtn') as HTMLButtonElement | null;
  if (btn?.disabled) return;
  btn?.setAttribute('disabled', '');
  try {
    const id = S.beanEditId;
    const url = id != null ? libraryApi.libraryImageUrl('bean', id) : '';
    let photo: Blob | null;
    if (id != null) {
      const r = await apiFetch(url);
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))) as { error?: string };
        alert(t('error_generic', err.error || r.statusText));
        return;
      }
      photo = await r.blob();
    } else {
      photo = _stagedBeanImage?.blob ?? null;
    }
    if (!photo) return;
    const { openStickerEditor } = await stickerEditorModule();
    const png = await openStickerEditor(photo);
    if (!png) return;
    if (id != null) {
      const row = _beanList().find(b => b.id === id);
      const crop = row && isValidCrop(row.imageCrop) ? row.imageCrop : null;
      // The new photo drops the stored original, so fetch it first; then it is
      // re-saved with the existing crop, keeping a cropped sticker re-croppable.
      let original: Blob | null = null;
      if (crop) {
        const stored = await apiFetch(`${url}?original=1`, { cache: 'no-cache' });
        if (stored.ok) original = await stored.blob();
      }
      const uploaded = await _storeBeanPhoto(id, await saveNewPhoto(url, { blob: png, crop, original, sticker: true }));
      if (uploaded) window.showToast?.(t('sticker_done'));
    } else {
      // Replace only the blob and mark it as a sticker: the crop and uncropped
      // original stay staged, so saveBeanInternal still posts the whole result.
      // eslint-disable-next-line require-atomic-updates -- single-flight: the disabled-button guard above prevents overlapping runs
      if (_stagedBeanImage) _stagedBeanImage = { ..._stagedBeanImage, blob: png, sticker: true };
      const hint = document.getElementById('beanFormImageStaged');
      if (hint) hint.style.display = '';
      void updateStickerButton();
    }
  } finally {
    btn?.removeAttribute('disabled');
  }
}
