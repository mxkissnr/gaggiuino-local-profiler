// #1498: a GaggiMate in standby is off, so the Live view must not count down
// to "ready" with a cold boiler. Covers the widget/DOM wiring in views/live.js
// and the shared icon-state translation it drives.
import { describe, it, expect, beforeEach } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the sibling live tests use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { updatePreheatWidget, handleLiveData } = await import('../public-src/views/live.js');

const state = S as unknown as Record<string, unknown>;

function makeElement() {
  const cls = new Set<string>();
  return {
    className: '', textContent: '', style: {} as Record<string, string>,
    firstChild: null as unknown,
    classList: {
      add: (...c: string[]) => c.forEach(x => cls.add(x)),
      remove: (...c: string[]) => c.forEach(x => cls.delete(x)),
      contains: (c: string) => cls.has(c),
    },
    querySelector: () => null,
    set innerHTML(_v: string) { this.firstChild = {}; },
    has: (c: string) => cls.has(c),
  };
}

type FakeElement = ReturnType<typeof makeElement>;

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  return {
    getElementById: (id: string): FakeElement => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id)!;
    },
  };
}

describe('Live view standby preheat (#1498)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let badge: FakeElement;
  let wrap: FakeElement;
  let title: FakeElement;

  beforeEach(() => {
    doc = makeFakeDocument();
    g.document = doc;
    state.currentLang = 'en';
    state.machines = [{ id: 1, isDefault: true }];
    state.activeMachineId = 1;
    badge = doc.getElementById('preheat-ready-badge');
    wrap = doc.getElementById('preheat-warming-wrap');
    title = doc.getElementById('liveIdleTitle');
  });

  it('hides the ready badge and warming widget and reads "Standby"', () => {
    updatePreheatWidget({ standby: true, ready: false, remaining: 1200, pct: 0.1 });

    expect(badge.style.display).toBe('none');
    expect(wrap.style.display).toBe('none');
    expect(title.textContent).toBe('Standby');
  });

  it('hides them even when the payload still claims ready with time remaining', () => {
    updatePreheatWidget({ standby: true, ready: true, remaining: 600, pct: 1 });

    expect(badge.style.display).toBe('none');
    expect(wrap.style.display).toBe('none');
    expect(title.textContent).toBe('Standby');
  });

  it('keeps the machine icon off (no accent, no heating) in standby', () => {
    const host = doc.getElementById('liveMachineIcon');
    updatePreheatWidget({ standby: true, ready: false, remaining: 1200 });

    expect(host.has('is-on')).toBe(false);
    expect(host.has('is-heating')).toBe(false);
  });

  it('the idle title stays "Standby" across a following live tick', () => {
    updatePreheatWidget({ standby: true, ready: false, remaining: 1200 });
    handleLiveData({ machineReachable: true });

    expect(title.textContent).toBe('Standby');
  });

  it('standby: false keeps today\'s warming countdown and title', () => {
    updatePreheatWidget({ standby: false, ready: false, remaining: 1200, pct: 0.1 });
    handleLiveData({ machineReachable: true });

    expect(badge.style.display).toBe('none');
    expect(wrap.style.display).toBe('');
    expect(doc.getElementById('preheat-countdown').textContent).toBe('20:00 remaining');
    expect(title.textContent).toBe('Warming up …');
  });
});
