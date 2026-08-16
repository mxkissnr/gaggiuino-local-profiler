import { describe, it, expect } from 'vitest';

// sidebar.js's import chain touches state.js/i18n.js, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/sidebar-month-toggle.test.js).
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { updateFlapCounter } = await import('../public-src/components/sidebar.js');

// #823: the sidebar shot count was flattened from a mechanical split-flap
// odometer (per-digit boxed cells, flip animation) to a plain textContent
// write on a single element. updateFlapCounter() keeps its old export name
// (least churn for its call sites in main.js/status.js) but its internals
// are now a single synchronous, unconditional write — same "fake minimal
// document" approach as test/sidebar-month-toggle.test.js rather than
// pulling in a full jsdom/happy-dom dependency this repo doesn't otherwise
// use.
function fakeFlapDigits() {
  const el = { textContent: '' };
  globalThis.document = { getElementById: id => (id === 'flapDigits' ? el : undefined) };
  return el;
}

describe('updateFlapCounter (#823 flattened shot-count header)', () => {
  it('renders a small count zero-padded to 4 digits, matching the prototype\'s own "0005" example', () => {
    const el = fakeFlapDigits();
    updateFlapCounter(5);
    expect(el.textContent).toBe('0005');
  });

  it('renders a 2-digit count still padded to 4 digits', () => {
    const el = fakeFlapDigits();
    updateFlapCounter(42);
    expect(el.textContent).toBe('0042');
  });

  it('renders a count already at 4+ digits unpadded (no truncation)', () => {
    const el = fakeFlapDigits();
    updateFlapCounter(1234);
    expect(el.textContent).toBe('1234');
    updateFlapCounter(12345);
    expect(el.textContent).toBe('12345');
  });

  it('a later call always wins over an earlier one, since the write is synchronous (the #333 startup-race guard is no longer needed once nothing is deferred)', () => {
    const el = fakeFlapDigits();
    updateFlapCounter(0);
    updateFlapCounter(7);
    expect(el.textContent).toBe('0007');
  });

  it('is a defensive no-op when the container is missing from the DOM (mirrors the #333 race-condition scenario where the element may not exist yet on the very first call)', () => {
    globalThis.document = { getElementById: () => undefined };
    expect(() => updateFlapCounter(3)).not.toThrow();
  });
});
