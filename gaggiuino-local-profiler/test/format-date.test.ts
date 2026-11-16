// #1962: formatDate() is the one display date format (docs/DESIGN.md "Dates").
import { describe, it, expect } from 'vitest';
import { formatDate, formatDayLabel } from '../public-src/utils';

const MS = new Date(2026, 2, 7, 14, 5).getTime();

describe('formatDate', () => {
  it('formats the short form for de-DE and en-US', () => {
    expect(formatDate(MS, 'de-DE')).toBe('07.03.2026');
    expect(formatDate(MS, 'en-US')).toBe('03/07/2026');
  });

  it('formats the long form for de-DE and en-US', () => {
    expect(formatDate(MS, 'de-DE', 'long')).toBe('7. März 2026');
    expect(formatDate(MS, 'en-US', 'long')).toBe('March 7, 2026');
  });

  it('accepts a Date and a number alike', () => {
    expect(formatDate(new Date(MS), 'de-DE', 'long')).toBe(formatDate(MS, 'de-DE', 'long'));
  });

  it('appends the time with withTime', () => {
    expect(formatDate(MS, 'de-DE', 'long', true)).toMatch(/^7\. März 2026 \d{2}:\d{2}$/);
  });

  it('keeps formatDayLabel on the short form', () => {
    expect(formatDayLabel(MS, 'de-DE')).toBe(formatDate(MS, 'de-DE'));
  });
});
