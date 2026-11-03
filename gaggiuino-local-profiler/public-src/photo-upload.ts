// The one client of the photo route contract shared by every photo field
// (#1845). A route answers with the updated entity JSON and takes three
// request shapes:
//   POST <route>                         — a new photo (drops any original);
//   POST <route>?original=1&crop=x,y,w,h — the uncropped original of the
//                                          photo just stored, plus its crop;
//   POST <route>?crop=x,y,w,h            — re-crop the stored original.
// All three answer with the entity, so the caller can replace its row.
import { apiFetch } from './api/fetch.js';
import type { ImageCrop } from './api/types.js';
import { t } from './i18n.js';
import { openCropEditor, cropQuery, isValidCrop } from './components/image-crop.js';
import type { CropEditorOptions, CropEditorResult } from './components/image-crop.js';

/** The crop-editor settings a photo field picks, e.g. `{ shape: 'square' }`. */
export type PhotoCropShape = Pick<CropEditorOptions, 'shape' | 'aspect'>;

/** A new photo plus, when known, the uncropped original and the crop that produced it. */
export type NewPhoto = Pick<CropEditorResult, 'blob' | 'original'> & { crop: ImageCrop | null };

/**
 * Upload `photo` as the photo behind `imageUrl`: the main image first, then —
 * when the uncropped original and the crop that produced it are known — the
 * original with its crop, so the photo can be re-cropped later.
 */
export async function saveNewPhoto(imageUrl: string, photo: NewPhoto): Promise<Response> {
  const main = await apiFetch(imageUrl, {
    method: 'POST',
    headers: { 'Content-Type': photo.blob.type },
    body: photo.blob,
  });
  if (!main.ok) return main;
  if (photo.original === null || photo.crop === null) {
    console.warn('photo-upload: no uncropped original, the photo cannot be re-cropped later');
    return main;
  }
  const stored = await apiFetch(`${imageUrl}?original=1&crop=${cropQuery(photo.crop)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: photo.original,
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
 * dialog is cancelled or another adjustment is already running. `finish` (a
 * step that turns the cropped image into the final one, e.g. the sticker
 * cut-out) re-saves the result as a new photo plus the same original.
 */
export async function adjustPhoto(
  imageUrl: string,
  imageCrop: unknown,
  shape: PhotoCropShape,
  finish?: (cropped: Blob) => Promise<Blob | null>,
): Promise<Response | null> {
  if (adjusting) return null;
  adjusting = true;
  try {
    if (finish) {
      // The stored main image is the finished cut-out: cropping it again would
      // flatten its transparency to JPEG, so there is no older-photo fallback.
      if (!isValidCrop(imageCrop)) return null;
      const stored = await apiFetch(`${imageUrl}?original=1`, { cache: 'no-cache' });
      if (!stored.ok) return stored;
      const original = await stored.blob();
      const result = await openCropEditor(original, { ...shape, initialCrop: imageCrop });
      if (!result) return null;
      const finished = await finish(result.blob);
      if (!finished) return null;
      // The finished image is a new photo (the server drops the old original),
      // then the fetched original is re-saved with the new crop — not
      // `result.original`, so it is not re-encoded on every adjust.
      return saveNewPhoto(imageUrl, { blob: finished, crop: result.crop, original });
    }
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
    // The dialog shows the already-cropped image, so the user can only cut it
    // tighter — say so, or the missing widened area looks like a bug.
    const result = await openCropEditor(await current.blob(), { ...shape, hint: t('crop_editor_legacy_hint') });
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
