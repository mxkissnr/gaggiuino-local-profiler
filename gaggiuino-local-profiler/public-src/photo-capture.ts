// #1836: every photo field reuses one hidden <input type="file">. Only the
// `capture` attribute makes a phone open the camera instead of the gallery, so
// it is set per tap and cleared again by the "choose photo" button — otherwise
// one camera tap would make every later pick open the camera too.
//
// The Home Assistant Companion app's Android WebView ignores `capture` and
// opens the gallery anyway, so a camera tap streams the live camera into a
// modal — the getUserMedia path the barcode scanner already uses — and hands
// the shot to the input as a File the existing change handlers accept. Devices
// without a usable live camera keep the old `capture` tap.
import { attachDialogKeyboard } from './components/dialog-a11y.js';
import type { DialogKeyboardHandle } from './components/dialog-a11y.js';

export interface PhotoInputOptions {
  /** Open the camera instead of the gallery/file chooser. */
  camera: boolean;
}

export function openPhotoInput(input: HTMLInputElement, opts: PhotoInputOptions): void {
  if (!opts.camera) {
    input.removeAttribute('capture');
    input.click();
    return;
  }
  if (!canUseLiveCamera()) {
    openCaptureFallback(input);
    return;
  }
  void openCameraModal(input);
}

function canUseLiveCamera(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext === true
    && typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

// The phone's own camera app through `capture` — needs no getUserMedia and no
// secure context, so it stays the fallback for every device without one.
function openCaptureFallback(input: HTMLInputElement): void {
  input.setAttribute('capture', 'environment');
  input.click();
}

interface CameraModalElements {
  modal: HTMLElement;
  video: HTMLVideoElement;
  shutter: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

function cameraModalElements(): CameraModalElements | null {
  if (typeof document === 'undefined') return null;
  const modal = document.getElementById('photoCameraModal');
  const video = document.getElementById('photoCameraVideo') as HTMLVideoElement | null;
  const shutter = document.getElementById('photoCameraShutter') as HTMLButtonElement | null;
  const cancel = document.getElementById('photoCameraCancelBtn') as HTMLButtonElement | null;
  if (!modal || !video || !shutter || !cancel) return null;
  return { modal, video, shutter, cancel };
}

// One camera modal at a time: `_invocation` invalidates an open that is still
// waiting for the permission prompt once the modal has been closed.
let _invocation = 0;
let _stream: MediaStream | null = null;
let _input: HTMLInputElement | null = null;
let _controls: AbortController | null = null;
let _keyboard: DialogKeyboardHandle | null = null;

function releaseStream(): void {
  if (!_stream) return;
  for (const track of _stream.getTracks()) track.stop();
  _stream = null;
}

export function closeCameraModal(): void {
  _invocation += 1;
  releaseStream();
  _controls?.abort();
  _controls = null;
  _keyboard?.release();
  _keyboard = null;
  const el = cameraModalElements();
  if (el) {
    el.video.srcObject = null;
    el.video.classList.add('photo-video-off');
    el.modal.classList.remove('open');
  }
  _input = null;
}

export async function openCameraModal(input: HTMLInputElement): Promise<void> {
  const el = cameraModalElements();
  if (!el) {
    openCaptureFallback(input);
    return;
  }
  _invocation += 1;
  const invocation = _invocation;
  // A second tap while a preview is already up replaces that one instead of
  // stacking a second set of listeners (and a second Escape registration).
  _keyboard?.release();
  _keyboard = null;
  _controls?.abort();
  _controls = null;
  releaseStream();
  _input = input;
  el.video.srcObject = null;
  el.video.classList.add('photo-video-off');
  el.modal.classList.add('open');
  _keyboard = attachDialogKeyboard(el.modal, closeCameraModal);
  const controls = new AbortController();
  _controls = controls;
  el.shutter.addEventListener('click', () => { void captureCameraFrame(); }, { signal: controls.signal });
  el.cancel.addEventListener('click', closeCameraModal, { signal: controls.signal });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (error) {
    console.error('Photo camera failed:', error);
    // Cancelled while the permission prompt was up: the user already backed
    // out, so do not reopen the phone's camera app on top of that.
    if (invocation !== _invocation) return;
    closeCameraModal();
    openCaptureFallback(input);
    return;
  }
  // Cancelled or Escaped while the permission prompt was up: this invocation
  // is stale, so release the stream it just obtained instead of showing it.
  if (invocation !== _invocation) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  _stream = stream;
  el.video.srcObject = stream;
  el.video.classList.remove('photo-video-off');
}

async function captureCameraFrame(): Promise<void> {
  const el = cameraModalElements();
  const input = _input;
  if (!el || !input) return;
  const { video } = el;
  const width = video.videoWidth;
  const height = video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = width && height ? canvas.getContext('2d') : null;
  if (!ctx) {
    closeCameraModal();
    openCaptureFallback(input);
    return;
  }
  ctx.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  closeCameraModal();
  if (!blob) {
    openCaptureFallback(input);
    return;
  }
  // A picked file is exactly what every existing change handler already
  // handles (upload, crop, sticker cut-out), so the camera adds no new path.
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'camera.jpg', { type: 'image/jpeg' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
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
