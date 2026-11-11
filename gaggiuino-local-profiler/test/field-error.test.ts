// #1962 slice 6: markFieldInvalid is the one place a failed field is marked
// and focused, and it clears on the next input. The node test env has no DOM,
// so this fake stands in for the few methods the helper touches.
import { describe, it, expect } from 'vitest';
import { markFieldInvalid } from '../public-src/components/field-error.js';

class FakeInput {
  readonly style: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  focusCount = 0;
  removed = 0;
  private listeners: Array<() => void> = [];

  setAttribute(name: string, value: string): void { this.attrs[name] = value; }
  removeAttribute(name: string): void { this.removed += 1; delete this.attrs[name]; }
  focus(): void { this.focusCount += 1; }
  addEventListener(type: string, fn: () => void): void { if (type === 'input') this.listeners.push(fn); }
  removeEventListener(type: string, fn: () => void): void {
    if (type === 'input') this.listeners = this.listeners.filter(l => l !== fn);
  }
  fire(): void { for (const fn of [...this.listeners]) fn(); }
  get listenerCount(): number { return this.listeners.length; }
}

const asField = (input: FakeInput): HTMLElement => input as unknown as HTMLElement;

describe('markFieldInvalid (#1962)', () => {
  it('marks the field invalid and focuses it', () => {
    const input = new FakeInput();

    markFieldInvalid(asField(input));

    expect(input.attrs['aria-invalid']).toBe('true');
    expect(input.style.outline).toBe('2px solid var(--err)');
    expect(input.focusCount).toBe(1);
    expect(input.listenerCount).toBe(1);
  });

  it('clears the mark on the first input and does nothing on the next one', () => {
    const input = new FakeInput();
    markFieldInvalid(asField(input));

    input.fire();

    expect(input.attrs['aria-invalid']).toBeUndefined();
    expect(input.style.outline).toBe('');
    expect(input.listenerCount).toBe(0);

    input.fire();

    expect(input.removed).toBe(1);
  });

  it('does nothing without a field', () => {
    expect(() => markFieldInvalid(null)).not.toThrow();
  });
});
