import { describe, it, expect, beforeEach, vi } from 'vitest';

// Ids that reach an API path or query are URL-encoded so they cannot change
// which endpoint a request hits (#1747).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { pathSeg } = await import('../public-src/api/fetch.js');
const { deleteMilkById } = await import('../public-src/api/library.js');
const { deleteMachine } = await import('../public-src/api/machines.js');
const { deleteMaintenanceLogEntry } = await import('../public-src/api/maintenance.js');
const { postOrderAccept } = await import('../public-src/api/orders.js');
const { sendShotToTrash } = await import('../public-src/api/shots.js');

const hostile = '../1?x=';
const encoded = '..%2F1%3Fx%3D';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
  g.fetch = fetchMock;
});

function sentUrl(): string {
  return fetchMock.mock.calls[0]?.[0] as string;
}

describe('pathSeg (#1747)', () => {
  it('encodes path separators, query delimiters and fragments', () => {
    const seg = pathSeg('../../machines/1?x=#y');
    expect(seg).not.toMatch(/[/?#]/);
    expect(decodeURIComponent(seg)).toBe('../../machines/1?x=#y');
  });
});

describe('API clients encode ids (#1747)', () => {
  it('encodes a library id into one path segment', async () => {
    await deleteMilkById(hostile as unknown as number);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentUrl()).toBe(`api/library/milk/${encoded}`);
  });

  it('encodes a machine id into one path segment', async () => {
    await deleteMachine(hostile);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentUrl()).toBe(`api/machines/${encoded}`);
  });

  it('encodes a maintenance log id into one path segment', async () => {
    await deleteMaintenanceLogEntry(hostile);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentUrl()).toBe(`api/maintenance/log/${encoded}`);
  });

  it('encodes an order id into one path segment', async () => {
    await postOrderAccept(hostile, 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentUrl()).toBe(`api/orders/${encoded}/accept`);
  });

  it('encodes a shot id into one path segment', async () => {
    await sendShotToTrash(hostile as unknown as number);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentUrl()).toBe(`api/shots/${encoded}/trash`);
  });

  it('leaves normal numeric ids unchanged', async () => {
    await deleteMachine(3);
    expect(sentUrl()).toBe('api/machines/3');
    fetchMock.mockClear();
    await deleteMilkById(3);
    expect(sentUrl()).toBe('api/library/milk/3');
    fetchMock.mockClear();
    await deleteMaintenanceLogEntry(3);
    expect(sentUrl()).toBe('api/maintenance/log/3');
    fetchMock.mockClear();
    await postOrderAccept(3, 5);
    expect(sentUrl()).toBe('api/orders/3/accept');
    fetchMock.mockClear();
    await sendShotToTrash(3);
    expect(sentUrl()).toBe('api/shots/3/trash');
  });
});
