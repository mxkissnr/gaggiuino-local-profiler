// public-src/sse.js (#735): EventSource wrapper + fallback detection. A
// FakeEventSource stub stands in for the real browser EventSource so the
// watchdog/error-counter logic can be driven deterministically without a
// real network connection. Each test gets a fresh module instance
// (vi.resetModules() + dynamic import) since sse.js keeps its connection
// state (source/everConnected/strikes/listeners) at module scope.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Same fake-localStorage/navigator convention as
// test/frozen-portion-shot-tracking.test.ts -- public-src/state/index.ts reads
// both at module-eval time. vitest's node environment has no browser globals,
// so the fakes go through a loose view of globalThis rather than satisfying
// the full Storage/Navigator shapes.
const g = globalThis as unknown as Record<string, unknown>;
const _store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k: string, v: unknown) => { _store.set(k, String(v)); },
  removeItem: (k: string) => { _store.delete(k); },
};
g.navigator ??= { language: 'en-US' };

type Listener = (ev: { data: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners: Record<string, Listener[]> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: Listener): void {
    (this.listeners[type] ??= []).push(cb);
  }
  close(): void { this.closed = true; }
  // test-only helpers to drive the fake connection
  _open(): void { this.onopen?.(); }
  _error(): void { this.onerror?.(); }
  _emit(type: string, data: unknown): void {
    for (const cb of this.listeners[type] || []) cb({ data: JSON.stringify(data) });
  }
}

describe('public-src/sse.js', () => {
  let S: (typeof import('../public-src/state/index.js'))['S'];
  let connectEvents: (typeof import('../public-src/sse.js'))['connectEvents'];
  let disconnectEvents: (typeof import('../public-src/sse.js'))['disconnectEvents'];
  let onEvent: (typeof import('../public-src/sse.js'))['onEvent'];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeEventSource.instances = [];
    g.EventSource = FakeEventSource;

    ({ S } = await import('../public-src/state/index.js'));
    ({ connectEvents, disconnectEvents, onEvent } = await import('../public-src/sse.js'));
    S.sseActive = null;
    S.glpToken = '';
  });

  afterEach(() => {
    disconnectEvents();
    vi.useRealTimers();
  });

  it('successful open sets S.sseActive = true', () => {
    connectEvents(() => {});
    const es = FakeEventSource.instances[0];
    es._open();
    expect(S.sseActive).toBe(true);
  });

  it('3 errors with no prior successful open trigger the fallback', () => {
    const onFallback = vi.fn();
    connectEvents(onFallback);
    const es = FakeEventSource.instances[0];

    es._error();
    es._error();
    expect(onFallback).not.toHaveBeenCalled();
    expect(S.sseActive).not.toBe(false);

    es._error();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(S.sseActive).toBe(false);
  });

  it('a single error AFTER a successful open does NOT trigger the fallback (normal auto-reconnect)', () => {
    const onFallback = vi.fn();
    connectEvents(onFallback);
    const es = FakeEventSource.instances[0];

    es._open();
    expect(S.sseActive).toBe(true);

    // Even several errors after a confirmed-working connection must not
    // flip the app back into polling mode -- that's just EventSource's
    // normal auto-reconnect behavior after a transient drop.
    es._error();
    es._error();
    es._error();
    expect(onFallback).not.toHaveBeenCalled();
    expect(S.sseActive).toBe(true);
  });

  it('the 8s watchdog fires the fallback if the connection never opens', () => {
    const onFallback = vi.fn();
    connectEvents(onFallback);

    vi.advanceTimersByTime(7999);
    expect(onFallback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(S.sseActive).toBe(false);
  });

  it('the watchdog does not fire once the connection has already opened', () => {
    const onFallback = vi.fn();
    connectEvents(onFallback);
    FakeEventSource.instances[0]._open();

    vi.advanceTimersByTime(8000);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('dispatches a pushed event to a registered onEvent() handler', () => {
    const handler = vi.fn();
    onEvent('sync-progress', handler);
    connectEvents(() => {});
    const es = FakeEventSource.instances[0];
    es._open();

    es._emit('sync-progress', { machineId: 1, current: 2, total: 5 });
    expect(handler).toHaveBeenCalledWith({ machineId: 1, current: 2, total: 5 });
  });

  it('builds the stream URL with a ?token= fallback when S.glpToken is set', () => {
    S.glpToken = 'abc123';
    connectEvents(() => {});
    expect(FakeEventSource.instances[0].url).toBe('api/events?token=abc123');
  });

  // #1016: mid-session staleness -- a connected stream that goes silent
  // (Ingress/proxy black-holed it) without ever firing onerror/onclose used
  // to leave S.sseActive stuck at true forever, permanently suppressing the
  // REST-polling fallback.
  it('flips S.sseActive back to false if connected but no event arrives for the stale window, with no onerror at all', () => {
    connectEvents(() => {});
    const es = FakeEventSource.instances[0];
    es._open();
    expect(S.sseActive).toBe(true);

    vi.advanceTimersByTime(39999);
    expect(S.sseActive).toBe(true);

    vi.advanceTimersByTime(1);
    expect(S.sseActive).toBe(false);
    // native reconnect must still be allowed to happen in the background
    expect(es.closed).toBe(false);
  });

  it('a received event resets the staleness timer so a healthy stream never falsely goes inactive', () => {
    onEvent('live-snapshot', () => {});
    connectEvents(() => {});
    const es = FakeEventSource.instances[0];
    es._open();

    // Keep emitting an event just before the stale window would elapse --
    // should never trip, no matter how long the session runs.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(39000);
      es._emit('live-snapshot', { seq: i });
      expect(S.sseActive).toBe(true);
    }
  });

  it('an event arriving after the stream had already gone stale restores S.sseActive without needing onopen', () => {
    onEvent('live-snapshot', () => {});
    connectEvents(() => {});
    const es = FakeEventSource.instances[0];
    es._open();

    vi.advanceTimersByTime(40000);
    expect(S.sseActive).toBe(false);

    es._emit('live-snapshot', { seq: 1 });
    expect(S.sseActive).toBe(true);
  });
});
