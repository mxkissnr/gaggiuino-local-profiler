import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1958: showToast reports how a toast ended, so a caller can tell "the user
// saw it and it ran out" from "another toast took its place".

vi.mock('../public-src/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/utils.js')>()),
  themeColor: () => '#000000',
}));

import { showToast } from '../public-src/components/toast.js';

class FakeEl {
  id = '';
  className = '';
  textContent = '';
  type = '';
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  onclick: (() => void) | null = null;

  setAttribute(): void {}
  appendChild(child: FakeEl): FakeEl {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  querySelector(selector: string): FakeEl | null {
    const cls = selector.replace(/^\./, '');
    return this.children.find((c) => c.className === cls) ?? null;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
}

let els: Map<string, FakeEl>;

function installFakeDom(): void {
  els = new Map<string, FakeEl>();
  const doc = {
    getElementById: (id: string) => els.get(id) ?? null,
    createElement: () => new FakeEl(),
    body: {
      appendChild: (el: FakeEl) => {
        els.set(el.id, el);
        return el;
      },
    },
  };
  (globalThis as unknown as Record<string, unknown>).document = doc;
}

function toastElement(): FakeEl {
  const el = els.get('glpToast');
  if (!el) throw new Error('the toast element was never created');
  return el;
}

describe('showToast onHide (#1958)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeDom();
  });

  it('reports a toast that simply ran out as timeout, once', () => {
    const onHide = vi.fn();
    showToast('hello', { duration: 1000, onHide });
    expect(onHide).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onHide).toHaveBeenCalledWith('timeout');

    vi.advanceTimersByTime(1000);
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('reports an action click as action, then runs the action', () => {
    const order: string[] = [];
    const onClick = vi.fn(() => { order.push('onClick'); });
    const onHide = vi.fn((how: string) => { order.push(`onHide:${how}`); });

    showToast('undo me', { duration: 1000, action: { label: 'Undo', onClick }, onHide });
    const btn = toastElement().querySelector('.glp-toast-action');
    expect(btn).not.toBeNull();
    const click = btn ? btn.onclick : null;
    expect(click).not.toBeNull();
    click?.();

    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onHide).toHaveBeenCalledWith('action');
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['onHide:action', 'onClick']);

    // The dismissed toast's timer must not report it a second time.
    vi.advanceTimersByTime(5000);
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('reports a replaced toast as replaced, and its timer no longer fires it', () => {
    const first = vi.fn();
    showToast('first', { duration: 1000, onHide: first });
    showToast('second', { duration: 1000 });

    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith('replaced');

    vi.advanceTimersByTime(5000);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('leaves a toast without onHide, and the numeric duration form, working as before', () => {
    showToast('x', 500);
    expect(toastElement().textContent).toBe('x');
    expect(toastElement().style.opacity).toBe('1');

    vi.advanceTimersByTime(500);
    expect(toastElement().style.opacity).toBe('0');

    // Replaced by a later toast without any onHide either: no throw.
    showToast('no callback', { duration: 1000 });
    expect(toastElement().textContent).toBe('no callback');
  });
});
