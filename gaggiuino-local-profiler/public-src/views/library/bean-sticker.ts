import { S } from '../../state/index.js';
import { t } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { invalidateBeanImage } from '../../bean-image.js';
import { apiFetch } from '../../api/transport.js';
import { openImageCropEditor } from '../../components/image-crop.js';
import { _beanList } from './bean-shared.js';
import type { BeanListRow } from './bean-shared.js';
import * as libraryView from '../library.js';

// Circular with library.ts (it re-exports this module): only ever touched at
// call time, never read at module load.
const library = libraryView;

// Photo chosen while *creating* a bean: the crop result can't be uploaded yet
// (no id), so it waits here until saveBeanInternal has created the bean.
let _stagedBeanImageBlob: Blob | null = null;

// The bean form reads and clears the staged create-mode photo through these.
export function stagedBeanImage(): Blob | null { return _stagedBeanImageBlob; }
export function clearStagedBeanImage(): void { _stagedBeanImageBlob = null; }

export async function stageNewBeanImage(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  const blob = await openImageCropEditor(file, { shape: 'square', aspect: 'portrait' });
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  if (!blob) return;
  _stagedBeanImageBlob = blob;
  const hint = document.getElementById('beanFormImageStaged');
  if (hint) hint.style.display = '';
  void updateStickerButton();
}

// Shared post-upload step: store the server's updated bean row, drop the
// cached blob URL and redraw the list. Returns false — after the same generic
// alert this flow always showed — when the upload failed.
async function _uploadBeanImageBlob(id: number, blob: Blob): Promise<boolean> {
  const r = await libraryApi.uploadBeanImage(id, blob);
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    alert(t('error_generic', err.error || r.statusText));
    return false;
  }
  const saved = (await r.json()) as BeanListRow;
  const idx = _beanList().findIndex(b => b.id === id);
  if (idx !== -1) _beanList()[idx] = saved;
  invalidateBeanImage(id);
  library.renderBeanList();
  return true;
}

export async function uploadBeanImage(id: number, input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  const blob = await openImageCropEditor(file, { shape: 'square', aspect: 'portrait' });
  // eslint-disable-next-line require-atomic-updates -- `input` is a per-call function parameter (the DOM element passed in), not shared state
  input.value = '';
  if (!blob) return;
  const ok = await _uploadBeanImageBlob(id, blob);
  if (ok) void updateStickerButton();
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

// The "cut out as sticker" button appears only when the deployment ships the
// cut-out models and there is a photo to cut: an existing photo in edit mode,
// or a staged blob while creating.
export async function updateStickerButton(): Promise<void> {
  const btn = document.getElementById('beanFormStickerBtn') as HTMLButtonElement | null;
  if (!btn) return;
  const id = S.beanEditId;
  const hasPhoto = id != null
    ? !!_beanList().find(b => b.id === id)?.image
    : _stagedBeanImageBlob != null;
  if (!hasPhoto) { btn.style.display = 'none'; return; }
  let available = false;
  try {
    const { isStickerCutoutAvailable } = await stickerSegmentModule();
    available = await isStickerCutoutAvailable();
  } catch { /* probe failed: stay with the initial "not available" */ }
  // Re-read after the await: the form may have been closed or its photo
  // changed while the availability probe was in flight.
  const stillId = S.beanEditId;
  const stillHasPhoto = stillId != null
    ? !!_beanList().find(b => b.id === stillId)?.image
    : _stagedBeanImageBlob != null;
  btn.style.display = available && stillHasPhoto ? '' : 'none';
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
    let photo: Blob | null;
    if (id != null) {
      const r = await apiFetch(`api/library/bean/${id}/image`);
      if (!r.ok) {
        const err = (await r.json().catch(() => ({}))) as { error?: string };
        alert(t('error_generic', err.error || r.statusText));
        return;
      }
      photo = await r.blob();
    } else {
      photo = _stagedBeanImageBlob;
    }
    if (!photo) return;
    const { openStickerEditor } = await stickerEditorModule();
    const png = await openStickerEditor(photo);
    if (!png) return;
    if (id != null) {
      const uploaded = await _uploadBeanImageBlob(id, png);
      if (uploaded) window.showToast?.(t('sticker_done'));
    } else {
      // eslint-disable-next-line require-atomic-updates -- single-flight: the disabled-button guard above prevents overlapping runs
      _stagedBeanImageBlob = png;
      const hint = document.getElementById('beanFormImageStaged');
      if (hint) hint.style.display = '';
      void updateStickerButton();
    }
  } finally {
    btn?.removeAttribute('disabled');
  }
}
