import { S } from './index.js';
import type { AppState } from './index.js';

// Disposables that live for the duration of a view/session (polling
// intervals, the calendar ResizeObserver, the QR scanner's MediaStream and
// BarcodeDetector). Kept in one registry so teardown is always the right
// kind — clearInterval, observer.disconnect(), or track.stop() — instead of
// every call site re-deriving it.
export type TimerName =
  | 'livePollInterval'
  | 'preheatPollInterval'
  | 'liveTimerTick'
  | '_ordersPollTimer'
  | '_calendarResizeObserver'
  | '_scanStream'
  | '_scanDetector';

export function get<K extends TimerName>(name: K): AppState[K] {
  return S[name];
}

export function dispose(name: TimerName): void {
  switch (name) {
    case 'livePollInterval':
    case 'preheatPollInterval':
    case 'liveTimerTick':
    case '_ordersPollTimer': {
      const id: number | null = S[name];
      if (id != null) clearInterval(id);
      break;
    }
    case '_calendarResizeObserver':
      S._calendarResizeObserver?.disconnect();
      break;
    case '_scanStream':
      S._scanStream?.getTracks().forEach(track => track.stop());
      break;
    case '_scanDetector':
      // BarcodeDetector exposes no teardown API — dropping the reference is
      // the release.
      break;
  }
  (S as unknown as Record<TimerName, unknown>)[name] = null;
}

export function set<K extends TimerName>(name: K, value: AppState[K]): void {
  dispose(name);
  S[name] = value;
}
