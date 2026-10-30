// #1836: every photo field reuses one hidden <input type="file">. Only the
// `capture` attribute makes a phone open the camera instead of the gallery, so
// it is set per tap and cleared again by the "choose photo" button — otherwise
// one camera tap would make every later pick open the camera too.

export interface PhotoInputOptions {
  /** Open the camera instead of the gallery/file chooser. */
  camera: boolean;
}

export function openPhotoInput(input: HTMLInputElement, opts: PhotoInputOptions): void {
  if (opts.camera) input.setAttribute('capture', 'environment');
  else input.removeAttribute('capture');
  input.click();
}

// Touch devices get a second "Take photo" button; a desktop webcam capture has
// no meaningful use here, so the button stays hidden there.
export function canTakePhoto(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

// Reveals the camera buttons (markup keeps them display:none) when the device
// has a camera worth opening from the app.
export function showCameraButtons(ids: readonly string[]): void {
  if (!canTakePhoto()) return;
  for (const id of ids) {
    const btn = document.getElementById(id);
    if (btn) btn.style.display = '';
  }
}
