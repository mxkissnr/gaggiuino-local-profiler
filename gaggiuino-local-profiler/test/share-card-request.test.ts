import { describe, it, expect, beforeEach, vi } from 'vitest';

// #2166: the share card request carries the verdict the shot page shows, and
// only the fields that are actually set.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
  g.fetch = fetchMock;
});

const { getShotCard } = await import('../public-src/api/shots.js');

function sentUrl(): string {
  return fetchMock.mock.calls[0]?.[0] as string;
}

function sentParams(): URLSearchParams {
  return new URLSearchParams(sentUrl().split('?')[1] ?? '');
}

describe('share card request (#2166)', () => {
  it('sends only format, accent, theme and lang without a verdict', async () => {
    await getShotCard(3, { format: 'square', accent: '#5b21b6', theme: 'dark', lang: 'de' });
    expect(sentUrl()).toBe('api/shots/3/card?format=square&accent=%235b21b6&theme=dark&lang=de');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adds the verdict fields that are set', async () => {
    await getShotCard(3, {
      format: 'story', accent: '#5b21b6', theme: 'light', lang: 'de',
      verdict: 'Shot ran long (55 s) – grind coarser',
      verdictType: 'coarser',
      delta: -11,
      vs: 'vs shot 306',
    });
    const params = sentParams();
    expect(params.get('verdict')).toBe('Shot ran long (55 s) – grind coarser');
    expect(params.get('verdictType')).toBe('coarser');
    expect(params.get('delta')).toBe('-11');
    expect(params.get('vs')).toBe('vs shot 306');
  });

  it('keeps a zero delta and drops empty text', async () => {
    await getShotCard(3, {
      format: 'square', accent: 'amber-americano', theme: 'dark', lang: 'en',
      verdict: '', vs: '', delta: 0,
    });
    const params = sentParams();
    expect(params.get('delta')).toBe('0');
    expect(params.has('verdict')).toBe(false);
    expect(params.has('vs')).toBe(false);
    expect(params.has('verdictType')).toBe(false);
  });

  it('drops a null delta', async () => {
    await getShotCard(3, { format: 'square', accent: 'amber-americano', theme: 'dark', lang: 'en', delta: null });
    expect(sentParams().has('delta')).toBe(false);
  });
});
