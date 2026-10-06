// #1374/#1488: drag a bottom sheet down to close it on phones, and move it like
// Home Assistant's more-info sheet: it slides up on open, follows the finger
// from anywhere in the content while that content sits at the top, fades the
// backdrop with the drag, judges a flick by its recent velocity and slides back
// out from wherever it is when it closes. Desktop side panels and
// `prefers-reduced-motion: reduce` keep the old instant behaviour.

const DISMISS_FRACTION = 0.25;
const DISMISS_MIN_PX = 80;
const DISMISS_VELOCITY_PX_PER_MS = 0.5;
const FLICK_WINDOW_MS = 100;
// Movement before a press becomes a drag. Below it the gesture stays a tap, so
// the head's menu and close buttons keep working.
const DRAG_START_SLOP_PX = 6;
const SPRING_BACK_MS = 200;
// An upward pull only rubber-bands this far (and damped), so the sheet never
// leaves a gap above the bottom edge.
const RUBBER_BAND_MAX_PX = 24;
const RUBBER_BAND_FACTOR = 0.5;
const SHEET_OUT_MS = 220;
const SHEET_OUT_MIN_MS = 120;
const SHEET_OUT_BEZIER = 'cubic-bezier(.2,0,0,1)';

export interface DragSample {
  t: number;
  y: number;
}

// How far the sheet must travel before a release counts as a dismissal: a
// quarter of its height, capped at 80px so a tall sheet is not too fussy.
export function dismissDistance(sheetHeight: number): number {
  if (!(sheetHeight > 0)) return DISMISS_MIN_PX;
  return Math.min(sheetHeight * DISMISS_FRACTION, DISMISS_MIN_PX);
}

// Downward speed over the last `windowMs` of samples (px/ms). A slow start
// followed by a fast flick still reads as a flick, unlike total-over-total.
export function recentVelocity(samples: DragSample[], windowMs = FLICK_WINDOW_MS): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  if (!last) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    const sample = samples[i];
    if (sample && last.t - sample.t <= windowMs) first = sample;
    else break;
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

// A long drag always dismisses; a short but fast one does too. Upward or tiny
// moves never do.
export function shouldDismissSheet(dy: number, sheetHeight: number, velocityPxPerMs: number): boolean {
  if (dy <= 0) return false;
  if (dy >= dismissDistance(sheetHeight)) return true;
  return velocityPxPerMs >= DISMISS_VELOCITY_PX_PER_MS;
}

// The translateY for an upward pull of `up` pixels: light, capped rubber-band.
export function rubberBand(up: number): number {
  if (up <= 0) return 0;
  return -Math.min(RUBBER_BAND_MAX_PX, up * RUBBER_BAND_FACTOR);
}

// Whether a touch may start a content drag: only from the top of the scroll
// container, only downward, and never from an interactive control.
export function allowsBodyDrag(scrollTop: number, dy: number, interactiveTarget: boolean): boolean {
  return scrollTop <= 0 && dy > 0 && !interactiveTarget;
}

// The phone/desktop split every sheet overlay shares; exported so sibling
// overlays (components/detail-sheet.ts) branch on the same breakpoint instead
// of duplicating the media query.
export function isPhoneSheetWidth(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 899px)').matches;
}

function _motionOk(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function _animates(): boolean {
  return isPhoneSheetWidth() && _motionOk();
}

function _isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as { closest?: (sel: string) => Element | null } | null;
  return !!el?.closest?.(
    'button, a, input, select, textarea, summary, canvas, [role="menu"], [role="slider"], '
    + '.lib-aroma-wheel, .crop-editor-overlay, .sticker-editor, [contenteditable="true"]');
}

function _now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function _currentTranslateY(el: HTMLElement): number {
  if (typeof getComputedStyle !== 'function') return 0;
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === 'none') return 0;
  const match = transform.match(/matrix(?:3d)?\(([^)]+)\)/);
  const numbers = match?.[1];
  if (!numbers) return 0;
  const values = numbers.split(',').map(v => parseFloat(v));
  if (values.length === 6) return values[5] || 0;
  if (values.length === 16) return values[13] || 0;
  return 0;
}

function _findTouch(list: TouchList, id: number | null): Touch | null {
  for (let i = 0; i < list.length; i++) {
    const touch = list[i];
    if (touch && touch.identifier === id) return touch;
  }
  return null;
}

// One animated close at a time. A second close of the same sheet is ignored;
// a close of another sheet, or a re-open (via settleSheetOut) finishes the old
// one first so the next sheet starts clean.
let _pending: { sheet: HTMLElement; finish: () => void } | null = null;

// Immediately completes a close that is still sliding out (if any). Open paths
// call this so a re-open is never wiped by the previous close's timer.
export function settleSheetOut(): void {
  const pending = _pending;
  if (!pending) return;
  _pending = null;
  pending.finish();
}

// Slides `sheet` from its current position down to fully off-screen and fades
// `backdrop` to 0, then runs `done`. On desktop or with reduced motion it runs
// `done` at once.
export function animateSheetOut(sheet: HTMLElement, backdrop: HTMLElement | null, done: () => void): void {
  if (_pending && _pending.sheet === sheet) return;
  if (_pending) settleSheetOut();
  if (!_animates()) { done(); return; }

  const startY = Math.max(0, _currentTranslateY(sheet));
  const height = sheet.offsetHeight || sheet.getBoundingClientRect().height || 0;
  sheet.style.transition = 'none';
  sheet.style.transform = startY > 0 ? `translateY(${startY}px)` : '';
  void sheet.offsetHeight; // commit the start position before transitioning

  const distance = Math.max(1, height - startY);
  const duration = Math.max(
    SHEET_OUT_MIN_MS,
    Math.round(SHEET_OUT_MS * (distance / Math.max(1, height))),
  );

  let finished = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    sheet.removeEventListener('transitionend', onEnd);
    if (_pending?.sheet === sheet) _pending = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (backdrop) {
      backdrop.style.transition = '';
      backdrop.style.opacity = '';
    }
    done();
  };
  const onEnd = (e: Event): void => {
    if (e.target === sheet) finish();
  };

  _pending = { sheet, finish };
  sheet.addEventListener('transitionend', onEnd);
  sheet.style.transition = `transform ${duration}ms ${SHEET_OUT_BEZIER}`;
  sheet.style.transform = `translateY(${height}px)`;
  if (backdrop) {
    backdrop.style.transition = `opacity ${duration}ms ${SHEET_OUT_BEZIER}`;
    backdrop.style.opacity = '0';
  }
  timer = setTimeout(finish, duration + 60);
}

// (Re)starts the phone slide-in: the sheet from the bottom edge, the backdrop
// fading in. Removing the class first lets a persistent element animate again.
export function startSheetEnter(sheet: HTMLElement | null, backdrop: HTMLElement | null): void {
  if (!sheet || !_animates() || typeof sheet.classList === 'undefined') return;
  sheet.classList.remove('lib-sheet-enter');
  void sheet.offsetWidth;
  sheet.classList.add('lib-sheet-enter');
  if (backdrop) {
    backdrop.classList.remove('lib-sheet-backdrop-enter');
    void backdrop.offsetWidth;
    backdrop.classList.add('lib-sheet-backdrop-enter');
  }
}

// Touch drag on the sheet itself: the grab pill, the head and the content all
// drag, as long as the content is scrolled to the top and the finger moves
// down. Touch events (not pointer) keep native `pan-y` scrolling working; the
// browser scroll is only suppressed with preventDefault once the drag starts.
// `onDismiss` returns `false` to say it declined the dismissal (e.g. a dirty
// form showing its confirm bar); the sheet then springs back instead of being
// left wherever the finger lifted. Any other return means a close was started.
export function attachSheetSwipe(sheet: HTMLElement, backdrop: HTMLElement | null, onDismiss: () => boolean | void): void {
  let active = false;
  let touchId: number | null = null;
  let startY = 0;
  let startScrollTop = 0;
  let interactive = false;
  let dragging = false;
  let lastDy = 0;
  let raf = 0;
  let samples: DragSample[] = [];

  const height = (): number => sheet.offsetHeight || sheet.getBoundingClientRect().height || 1;

  const resetStyles = (): void => {
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (backdrop) {
      backdrop.style.transition = '';
      backdrop.style.opacity = '';
    }
  };

  const springBack = (): void => {
    sheet.style.transition = `transform ${SPRING_BACK_MS}ms ${SHEET_OUT_BEZIER}`;
    sheet.style.transform = '';
    if (backdrop) {
      backdrop.style.transition = `opacity ${SPRING_BACK_MS}ms ${SHEET_OUT_BEZIER}`;
      backdrop.style.opacity = '1';
    }
    window.setTimeout(resetStyles, SPRING_BACK_MS + 40);
  };

  const applyTransform = (): void => {
    raf = 0;
    const dy = lastDy;
    sheet.style.transition = 'none';
    sheet.style.transform = dy >= 0
      ? (dy > 0 ? `translateY(${dy}px)` : '')
      : `translateY(${rubberBand(-dy)}px)`;
    if (backdrop) {
      backdrop.style.opacity = String(Math.max(0, 1 - Math.max(0, dy) / height()));
    }
  };

  const schedule = (): void => {
    if (raf) return;
    raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(applyTransform)
      : window.setTimeout(applyTransform, 16);
  };

  const onTouchStart = (e: TouchEvent): void => {
    // Ignore new gestures while a close is already sliding out.
    if (_pending || !isPhoneSheetWidth() || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!t) return;
    touchId = t.identifier;
    startY = t.clientY;
    startScrollTop = sheet.scrollTop;
    interactive = _isInteractiveTarget(e.target);
    active = true;
    dragging = false;
    lastDy = 0;
    samples = [{ t: _now(), y: 0 }];
  };

  const onTouchMove = (e: TouchEvent): void => {
    if (!active || touchId === null) return;
    const t = _findTouch(e.touches, touchId);
    if (!t) return;
    const dy = t.clientY - startY;
    if (!dragging) {
      // Upward moves and gestures that started while scrolled stay a scroll.
      if (!allowsBodyDrag(startScrollTop, dy, interactive) || sheet.scrollTop > 0) return;
      if (dy < DRAG_START_SLOP_PX) return;
      dragging = true;
      sheet.style.transition = 'none';
    }
    e.preventDefault();
    lastDy = dy;
    samples.push({ t: _now(), y: dy });
    if (samples.length > 40) samples.shift();
    schedule();
  };

  const onTouchEnd = (cancelled: boolean): void => {
    if (!active) return;
    active = false;
    touchId = null;
    if (raf) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      applyTransform();
    }
    if (!dragging) {
      // A stray tap must not wipe a close that is already sliding out.
      if (!_pending) resetStyles();
      return;
    }
    dragging = false;
    const dy = lastDy;
    const heightPx = height();
    const velocity = recentVelocity(samples);
    if (!cancelled && shouldDismissSheet(dy, heightPx, velocity)) {
      // Leave the transform where it is; animateSheetOut slides out from here.
      // If the callback declined (dirty form), spring back to the open state.
      if (onDismiss() === false) springBack();
      return;
    }
    springBack();
  };

  sheet.addEventListener('touchstart', onTouchStart, { passive: true });
  sheet.addEventListener('touchmove', onTouchMove, { passive: false });
  sheet.addEventListener('touchend', () => onTouchEnd(false));
  sheet.addEventListener('touchcancel', () => onTouchEnd(true));
}
