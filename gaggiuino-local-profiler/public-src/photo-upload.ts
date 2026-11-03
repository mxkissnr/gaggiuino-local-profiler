// The one client of the photo route contract shared by every photo field
// (#1845). A route answers with the updated entity JSON and takes three
// request shapes:
//   POST <route>                         — a new photo (drops any original);
//   POST <route>?original=1&crop=x,y,w,h — the uncropped original of the
//                                          photo just stored, plus its crop;
//   POST <route>?crop=x,y,w,h            — re-crop the stored original.
// All three answer with the entity, so the caller can replace its row.
import { apiFetch } from './api/fetch.js';
import { t } from './i18n.js';
import { openCropEditor, cropQuery, isValidCrop } from './components/image-crop.js';
import type { CropEditorOptions, CropEditorResult } from './components/image-crop.js';

/** The crop-editor settings a photo field picks, e.g. `{ shape: 'square' }`. */
export type PhotoCropShape = Pick<CropEditorOptions, 'shape' | 'aspect'>;

async function saveNewPhoto(imageUrl: string, result: CropEditorResult): Promise<Response> {
  const main = await apiFetch(imageUrl, {
    method: 'POST',
    headers: { 'Content-Type': result.blob.type },
    body: result.blob,
  });
  if (!main.ok) return main;
  if (result.original === null) {
    console.warn('photo-upload: no uncropped original, the photo cannot be re-cropped later');
    return main;
  }
  const stored = await apiFetch(`${imageUrl}?original=1&crop=${cropQuery(result.crop)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: result.original,
  });
  if (stored.ok) return stored;
  console.warn(`photo-upload: storing the original failed (${stored.status}), the photo is saved without one`);
  return main;
}

/**
 * Crop `file` and upload it as the photo behind `imageUrl`, keeping the
 * uncropped original for a later re-crop. Null when the dialog is cancelled.
 */
export async function cropAndUploadPhoto(imageUrl: string, file: Blob, shape: PhotoCropShape): Promise<Response | null> {
  const result = await openCropEditor(file, { ...shape });
  if (!result) return null;
  return saveNewPhoto(imageUrl, result);
}

let adjusting = false;

/**
 * Reopen the crop dialog on the photo behind `imageUrl` at its stored crop.
 * A photo that predates the original storage (or lost it) is opened on the
 * current image and then saved as a new photo plus original. Null when the
 * dialog is cancelled or another adjustment is already running.
 */
export async function adjustPhoto(imageUrl: string, imageCrop: unknown, shape: PhotoCropShape): Promise<Response | null> {
  if (adjusting) return null;
  adjusting = true;
  try {
    if (isValidCrop(imageCrop)) {
      const original = await apiFetch(`${imageUrl}?original=1`, { cache: 'no-cache' });
      if (original.ok) {
        const result = await openCropEditor(await original.blob(), { ...shape, initialCrop: imageCrop });
        if (!result) return null;
        return apiFetch(`${imageUrl}?crop=${cropQuery(result.crop)}`, { method: 'POST' });
      }
    }
    const current = await apiFetch(imageUrl, { cache: 'no-cache' });
    if (!current.ok) return current;
    const result = await openCropEditor(await current.blob(), { ...shape });
    if (!result) return null;
    return saveNewPhoto(imageUrl, result);
  } finally {
    adjusting = false;
  }
}

/**
 * The entity JSON of a successful photo response; on a failed one shows the
 * server's `error` (or the status text) and returns null.
 */
export async function savedPhotoRow<T>(r: Response): Promise<T | null> {
  if (r.ok) return (await r.json()) as T;
  const { error } = (await r.json().catch(() => ({}))) as { error?: string };
  alert(t('error_generic', error || r.statusText));
  return null;
}
