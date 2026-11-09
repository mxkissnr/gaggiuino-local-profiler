// #1956: shows in-app popups one at a time. A popup waits while it would get in
// the way (deps.canShow), and just before showing, the shared state is re-read
// (deps.refresh) and the popup asked whether it is still due, because another
// device may have dealt with it while it waited.
export interface PopupRequest {
  /** A second request with the same id replaces one still waiting. */
  id: string;
  isDue: () => boolean;
  /** Opens the popup; must call done() once it is gone. */
  show: (done: () => void) => void;
}

export interface PopupQueueDeps {
  canShow: () => boolean;
  /** Re-reads the shared state; false when it could not be confirmed. */
  refresh: () => Promise<boolean>;
}

const RETRY_MS = 2000;
const GAP_MS = 400;

let _deps: PopupQueueDeps | null = null;
const _queue: PopupRequest[] = [];
let _busy = false;
let _timer: ReturnType<typeof setTimeout> | null = null;

export function initPopupQueue(deps: PopupQueueDeps): void {
  _deps = deps;
}

export function enqueuePopup(req: PopupRequest): void {
  const i = _queue.findIndex(q => q.id === req.id);
  if (i >= 0) _queue[i] = req;
  else _queue.push(req);
  _schedule(0);
}

function _schedule(ms: number): void {
  if (_timer !== null) return;
  _timer = setTimeout(() => { _timer = null; void _pump(); }, ms);
}

async function _pump(): Promise<void> {
  const deps = _deps;
  if (!deps || _busy || !_queue.length) return;
  if (!deps.canShow()) { _schedule(RETRY_MS); return; }
  _busy = true;
  let inSync: boolean;
  try { inSync = await deps.refresh(); } catch { inSync = false; }
  // Unconfirmed state must not decide. Nothing was marked seen, so the next
  // start or shot asks again; no retry loop against an unreachable server.
  if (!inSync) { _queue.length = 0; _busy = false; return; }
  if (!deps.canShow()) { _busy = false; _schedule(RETRY_MS); return; }
  const req = _queue.shift();
  if (!req || !req.isDue()) { _busy = false; _schedule(0); return; }
  let finished = false;
  const done = (): void => {
    if (finished) return;
    finished = true;
    _busy = false;
    _schedule(GAP_MS);
  };
  try { req.show(done); } catch { done(); }
}
