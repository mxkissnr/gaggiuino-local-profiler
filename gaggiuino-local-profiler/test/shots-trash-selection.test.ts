import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1625 slice 5: trashing the open shot must open a neighbour of that shot, not
// jump to the oldest shot of the whole history. The real view's side effects
// (sidebar re-render, chart update, trash list reload) are not under test, so
// they are stubbed: updateView() is held at its first `await` by a never-
// settling ensureCurves(), which keeps it away from the DOM entirely.

vi.mock('../public-src/components/sidebar.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/components/sidebar.js')>()),
  renderSidebar: vi.fn(),
}));

vi.mock('../public-src/shot-curves.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/shot-curves.js')>()),
  ensureCurves: () => new Promise<void>(() => {}),
}));

vi.mock('../public-src/api/shots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../public-src/api/shots.js')>()),
  sendShotToTrash: vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('') } as Response)),
  listShots: vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response)),
  listShotsDump: vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response)),
}));

const g = globalThis as unknown as Record<string, unknown>;
const store: Record<string, string> = {};
g.localStorage ??= {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
};

const { S } = await import('../public-src/state/index.js');
const { trashShot } = await import('../public-src/views/shots/index.js');

// S.shots is oldest-first: index 0 is the oldest shot of the history.
function setShots(ids: number[]): void {
  S.shots = ids.map(id => ({ id, timestamp: id, annotation: {} })) as unknown as typeof S.shots;
  S.allShots = S.shots;
}

describe('trashing the open shot selects a neighbour (#1625)', () => {
  beforeEach(() => {
    S.compareShotId = null;
  });

  it('opens the next newer shot when the open middle shot is trashed', async () => {
    setShots([10, 20, 30]); // 10 oldest … 30 newest
    S.primaryShotId = 20;

    await trashShot(20);

    expect(S.primaryShotId).toBe(30);
    expect(S.shots.map(s => s.id)).toEqual([10, 30]);
  });

  it('opens the next older shot when the open newest shot is trashed', async () => {
    setShots([10, 20, 30]);
    S.primaryShotId = 30;

    await trashShot(30);

    expect(S.primaryShotId).toBe(20);
    expect(S.shots.map(s => s.id)).toEqual([10, 20]);
  });
});
