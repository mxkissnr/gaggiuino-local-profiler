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

// `focusMode` and `pointsOfInterest` are missing from lib.dom's
// MediaTrackCapabilities even though Chromium-based WebViews report them.
interface FocusCapabilities {
  focusMode?: string[];
  pointsOfInterest?: unknown;
}

// ImageCapture is only reached through `window` (absent on WebViews that do
// not ship it), so it is described by the one method this code calls.
interface StillCamera {
  takePhoto: () => Promise<Blob | null>;
}

type StillCameraCtor = new (track: MediaStreamTrack) => StillCamera;

// Tap-to-focus goes back to continuous autofocus afterwards, so the preview
// does not stay locked on a point that has since gone out of frame.
const SINGLE_SHOT_HOLD_MS = 2000;
const FOCUS_RING_MS = 600;

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
let _focusTimer: ReturnType<typeof setTimeout> | null = null;

function videoTrack(stream: MediaStream | null): MediaStreamTrack | null {
  return stream?.getVideoTracks()[0] ?? null;
}

// getCapabilities() is absent on older WebViews, hence the runtime check.
function focusCapabilities(track: MediaStreamTrack | null): FocusCapabilities | null {
  const reader = track as unknown as { getCapabilities?: () => FocusCapabilities } | null;
  return reader && typeof reader.getCapabilities === 'function' ? reader.getCapabilities() : null;
}

function hasFocusMode(track: MediaStreamTrack | null, mode: string): boolean {
  return focusCapabilities(track)?.focusMode?.includes(mode) === true;
}

// Point-of-interest focus is only reachable through `advanced`, which asks for
// what the camera can do without ever rejecting the whole constraint set.
function focusConstraint(spec: Record<string, unknown>): MediaTrackConstraints {
  return { advanced: [spec] };
}

function releaseStream(): void {
  if (!_stream) return;
  for (const track of _stream.getTracks()) track.stop();
  _stream = null;
}

export function closeCameraModal(): void {
  _invocation += 1;
  if (_focusTimer !== null) {
    clearTimeout(_focusTimer);
    _focusTimer = null;
  }
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
  _keyboard = attachDialogKeyboard(el.modal, closeCameraModal, { initialFocus: el.shutter });
  const controls = new AbortController();
  _controls = controls;
  el.shutter.addEventListener('click', () => { void captureCameraFrame(); }, { signal: controls.signal });
  el.cancel.addEventListener('click', closeCameraModal, { signal: controls.signal });
  el.video.addEventListener('pointerdown', (event: PointerEvent) => { tapToFocus(el, event); }, { signal: controls.signal });
  let stream: MediaStream;
  try {
    // Without a size request phones hand out a 640x480 stream, which is the
    // blurry-photo cause here. `ideal` never rejects a smaller camera.
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
    });
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
  attachPreview(el, stream);
}

// Kept out of the async opener so the module-level `_stream` write does not
// read as a race with closeCameraModal() (require-atomic-updates); the stale
// check above is what actually guards it.
function attachPreview(el: CameraModalElements, stream: MediaStream): void {
  _stream = stream;
  el.video.srcObject = stream;
  el.video.classList.remove('photo-video-off');
  applyContinuousFocus(stream);
}

// Continuous autofocus keeps the preview sharp without a tap; cameras that
// only offer single-shot focus simply skip it.
function applyContinuousFocus(stream: MediaStream): void {
  const track = videoTrack(stream);
  if (!track || !hasFocusMode(track, 'continuous')) return;
  void track.applyConstraints(focusConstraint({ focusMode: 'continuous' }))
    .catch(() => { /* this camera refused the constraint */ });
}

function supportsTapFocus(track: MediaStreamTrack | null): boolean {
  const caps = focusCapabilities(track);
  return caps?.pointsOfInterest !== undefined || caps?.focusMode?.includes('single-shot') === true;
}

function tapToFocus(el: CameraModalElements, event: PointerEvent): void {
  const track = videoTrack(_stream);
  if (!track || !supportsTapFocus(track)) return;
  const point = normalisedPoint(el.video, event.clientX, event.clientY);
  if (!point) return;
  showFocusRing(el, event.clientX, event.clientY);
  void track.applyConstraints(focusConstraint({ pointsOfInterest: [point], focusMode: 'single-shot' }))
    .then(() => {
      if (!hasFocusMode(track, 'continuous')) return;
      if (_focusTimer !== null) clearTimeout(_focusTimer);
      _focusTimer = setTimeout(() => {
        _focusTimer = null;
        void track.applyConstraints(focusConstraint({ focusMode: 'continuous' }))
          .catch(() => { /* the camera went away with the modal */ });
      }, SINGLE_SHOT_HOLD_MS);
    })
    .catch(() => { /* camera refused the point; it keeps whatever focus it had */ });
}

// Maps a tap on the preview to the 0..1 point the camera wants. The video is
// painted with object-fit, so the visible box is cropped or letterboxed inside
// the element and that offset has to be undone first.
function normalisedPoint(video: HTMLVideoElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = video.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const frameWidth = video.videoWidth || rect.width;
  const frameHeight = video.videoHeight || rect.height;
  const fit = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
    ? window.getComputedStyle(video).objectFit
    : 'cover';
  const scale = fit === 'contain'
    ? Math.min(rect.width / frameWidth, rect.height / frameHeight)
    : Math.max(rect.width / frameWidth, rect.height / frameHeight);
  const paintWidth = frameWidth * scale;
  const paintHeight = frameHeight * scale;
  const x = clamp01((clientX - rect.left - (rect.width - paintWidth) / 2) / paintWidth);
  const y = clamp01((clientY - rect.top - (rect.height - paintHeight) / 2) / paintHeight);
  return { x, y };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

// Decoration only: without somewhere to append it the focus request still goes
// through, so a missing host never blocks the tap.
function showFocusRing(el: CameraModalElements, clientX: number, clientY: number): void {
  const host = el.video.parentElement;
  if (!host) return;
  const rect = el.video.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.className = 'photo-focus-ring';
  ring.style.left = `${clientX - rect.left}px`;
  ring.style.top = `${clientY - rect.top}px`;
  host.appendChild(ring);
  setTimeout(() => ring.remove(), FOCUS_RING_MS);
}

async function captureCameraFrame(): Promise<void> {
  const el = cameraModalElements();
  const input = _input;
  if (!el || !input) return;
  const photo = await takePhoto(_stream);
  // Both paths hand back the region the preview showed, never the whole frame:
  // ImageCapture's full sensor frame is cropped below, the canvas grab is
  // cropped from the stream. Without any crop the untouched photo is still
  // preferable to no photo at all.
  const cropped = photo ? await cropToPreview(photo, el.video) : null;
  const blob = cropped ?? photo ?? (await grabFrame(el.video));
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

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Region of a `sourceW × sourceH` image that `object-fit: cover` paints inside
// a `boxW × boxH` element: a centred crop of the box's aspect ratio, i.e. the
// part of the frame the preview actually shows.
export function coverRegion(sourceW: number, sourceH: number, boxW: number, boxH: number): Rect {
  if (!(sourceW > 0) || !(sourceH > 0) || !(boxW > 0) || !(boxH > 0)) {
    return { x: 0, y: 0, width: sourceW, height: sourceH };
  }
  const scale = Math.max(boxW / sourceW, boxH / sourceH);
  const width = Math.min(sourceW, boxW / scale);
  const height = Math.min(sourceH, boxH / scale);
  return { x: (sourceW - width) / 2, y: (sourceH - height) / 2, width, height };
}

// On-screen box of the preview; a hidden or not-yet-laid-out element falls back
// to the stream's own size so the crop is at worst a no-op.
function previewBox(video: HTMLVideoElement): Rect {
  const rect = video.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return { x: 0, y: 0, width: rect.width, height: rect.height };
  return { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight };
}

// The saved file is the previewed region of the photo itself: a photo whose
// aspect differs from the stream (ImageCapture returns the full sensor frame)
// is cropped to the preview box's shape, scaled about the centre the way cover
// does — never stretched.
async function cropToPreview(photo: Blob, video: HTMLVideoElement): Promise<Blob | null> {
  const image = await decodeImage(photo);
  if (!image) return null;
  try {
    const box = previewBox(video);
    const region = coverRegion(image.width, image.height, box.width, box.height);
    return await drawRegion(image, region);
  } finally {
    image.close();
  }
}

// createImageBitmap is missing on older WebViews; a browser that has it gets
// the photo cropped, the others keep the untouched frame.
async function decodeImage(blob: Blob): Promise<ImageBitmap | null> {
  const host = typeof window === 'undefined'
    ? undefined
    : window as unknown as { createImageBitmap?: (source: Blob) => Promise<ImageBitmap> };
  if (!host || typeof host.createImageBitmap !== 'function') return null;
  try {
    return await host.createImageBitmap(blob);
  } catch {
    return null;
  }
}

function drawRegion(source: CanvasImageSource, region: Rect): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(region.width);
  canvas.height = Math.round(region.height);
  const ctx = canvas.width && canvas.height ? canvas.getContext('2d') : null;
  if (!ctx) return Promise.resolve(null);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

// ImageCapture reads the sensor at its full resolution and lets the camera run
// its own focus and exposure, which a canvas frame grab cannot do. Not every
// WebView ships it, and what it fails at falls back to the canvas path.
async function takePhoto(stream: MediaStream | null): Promise<Blob | null> {
  const track = videoTrack(stream);
  const ctor = typeof window === 'undefined'
    ? undefined
    : (window as unknown as { ImageCapture?: StillCameraCtor }).ImageCapture;
  if (!track || typeof ctor !== 'function') return null;
  try {
    return await new ctor(track).takePhoto();
  } catch {
    return null;
  }
}

function grabFrame(video: HTMLVideoElement): Promise<Blob | null> {
  if (!video.videoWidth || !video.videoHeight) return Promise.resolve(null);
  const box = previewBox(video);
  return drawRegion(video, coverRegion(video.videoWidth, video.videoHeight, box.width, box.height));
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
