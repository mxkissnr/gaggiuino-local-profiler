// #1374: drag a bottom sheet down to close it on phones. The sheet head (and
// its grab pill) is the drag surface; the sheet's own scroll position wins
// while it is scrolled down, so reading stays a scroll.

const DISMISS_DISTANCE_PX = 80;
const FLICK_MIN_DISTANCE_PX = 24;
const FLICK_VELOCITY_PX_PER_MS = 0.6;
// Movement before a press becomes a drag. Below it the gesture stays a tap, so
// the head's menu and close buttons keep working.
const DRAG_START_SLOP_PX = 6;
const SPRING_BACK_MS = 180;

// A long drag always dismisses; a short but quick flick (distance over time)
// does too. Upward (negative) or tiny moves never do.
export function shouldDismissSheet(dy: number, dtMs: number): boolean {
  if (dy >= DISMISS_DISTANCE_PX) return true;
  if (dy >= FLICK_MIN_DISTANCE_PX && dtMs > 0 && dy / dtMs >= FLICK_VELOCITY_PX_PER_MS) return true;
  return false;
}

function _isPhoneWidth(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 899px)').matches;
}

function _isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as { closest?: (sel: string) => Element | null } | null;
  return !!el?.closest?.('button, a, input, select, textarea, summary, [role="menu"]');
}

// `sheet` is the scrolling .lib-sheet, `handle` the element the drag starts
// from. The inline transform is cleared on spring-back and on dismissal.
export function attachSheetSwipe(sheet: HTMLElement, handle: HTMLElement, onDismiss: () => void): void {
  let pointerId: number | null = null;
  let startY = 0;
  let startT = 0;
  let dragging = false;

  const resetStyles = (): void => {
    sheet.style.transition = '';
    sheet.style.transform = '';
  };

  const onDown = (e: PointerEvent): void => {
    if (!_isPhoneWidth() || sheet.scrollTop > 0 || _isInteractiveTarget(e.target)) return;
    pointerId = e.pointerId;
    startY = e.clientY;
    startT = Date.now();
    dragging = false;
  };

  const onMove = (e: PointerEvent): void => {
    const id = pointerId;
    if (id === null || e.pointerId !== id) return;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (dy < DRAG_START_SLOP_PX) return;
      dragging = true;
      sheet.style.transition = 'none';
      try { handle.setPointerCapture(id); } catch { /* pointer already gone */ }
    }
    sheet.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  };

  const onUp = (e: PointerEvent, cancelled: boolean): void => {
    const id = pointerId;
    if (id === null || e.pointerId !== id) return;
    const wasDragging = dragging;
    const dy = e.clientY - startY;
    const dt = Date.now() - startT;
    pointerId = null;
    dragging = false;
    try { handle.releasePointerCapture(id); } catch { /* never captured */ }
    if (!wasDragging) return;
    if (!cancelled && shouldDismissSheet(dy, dt)) {
      resetStyles();
      onDismiss();
      return;
    }
    sheet.style.transition = `transform ${SPRING_BACK_MS}ms cubic-bezier(.2,0,0,1)`;
    sheet.style.transform = '';
    setTimeout(resetStyles, SPRING_BACK_MS);
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', e => onUp(e, false));
  handle.addEventListener('pointercancel', e => onUp(e, true));
}
