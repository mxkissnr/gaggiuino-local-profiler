// public-src/sse.js (#735): EventSource wrapper + fallback detection. A
// FakeEventSource stub stands in for the real browser EventSource so the
// watchdog/error-counter logic can be driven deterministically without a
// real network connection. Each test gets a fresh module instance
// (vi.resetModules() + dynamic import) since sse.js keeps its connection
// state (source/everConnected/strikes/listeners) at module scope.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Same fake-localStorage/navigator convention as test/sync-progress-toast.test.js
// -- public-src/state.js reads both at module-eval time.
const _store = new Map();
globalThis.localStorage = {
  getItem: k => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: k => { _store.delete(k); },
};
globalThis.navigator ??= { language: 'en-US' };

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.onopen = null;
    this.onerror = null;
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, cb) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() { this.closed = true; }
  // test-only helpers to drive the fake connection
  _open() { this.onopen?.(); }
  _error() { this.onerror?.(); }
  _emit(type, data) {
    for (const cb of this.listeners[type] || []) cb({ data: JSON.stringify(data) });
  }
}
FakeEventSource.instances = [];

describe('public-src/sse.js', () => {
  let S, connectEvents, disconnectEvents, onEvent;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource;

    ({ S } = await import('../public-src/state.js'));
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
});
