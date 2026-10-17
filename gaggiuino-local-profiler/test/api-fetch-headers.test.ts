import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1615: apiFetch() adds X-GLP-Client (writes) and X-GLP-Token by spreading
// the caller's headers into a new object. Spreading a Headers instance (or
// an entries array) that way drops all of its entries, so a caller passing
// one silently lost e.g. its Content-Type. Every HeadersInit form now keeps
// its entries; a plain object passes through with its names unchanged.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { apiFetch, CLIENT_ID } = await import('../public-src/api/transport.js');

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
  g.fetch = fetchMock;
  S.glpToken = 'tok-1';
});

function sentHeaders(): Record<string, string> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return init?.headers as Record<string, string>;
}

describe('apiFetch header merge (#1615)', () => {
  it('keeps the entries of a Headers instance', async () => {
    await apiFetch('api/x', { method: 'POST', headers: new Headers({ 'Content-Type': 'application/json' }) });
    expect(sentHeaders()).toEqual({
      'content-type': 'application/json', 'X-GLP-Client': CLIENT_ID, 'X-GLP-Token': 'tok-1',
    });
  });

  it('keeps the entries of an entries array', async () => {
    await apiFetch('api/x', { headers: [['X-GLP-Passphrase-B64', 'cw==']] });
    expect(sentHeaders()).toEqual({ 'X-GLP-Passphrase-B64': 'cw==', 'X-GLP-Token': 'tok-1' });
  });

  it('passes a plain object through with its header names unchanged', async () => {
    await apiFetch('api/x', { method: 'PUT', headers: { 'Content-Type': 'application/json' } });
    expect(sentHeaders()).toEqual({
      'Content-Type': 'application/json', 'X-GLP-Client': CLIENT_ID, 'X-GLP-Token': 'tok-1',
    });
  });

  it('leaves a GET without token or headers untouched', async () => {
    S.glpToken = '';
    await apiFetch('api/x');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({});
  });
});
