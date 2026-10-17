import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToastOptions } from '../public-src/components/toast.js';

// #1716: trashing a shot from the sidebar shows a toast with an Undo button;
// Undo must call the restore endpoint, put the shot back at its place in the
// list and reselect it when it was the open shot. The toast is captured so the
// test clicks the real Undo callback. As in shots-trash-selection.test.ts, the
// sidebar render is stubbed and updateView() is held at its first `await` by a
// never-settling ensureCurves(), which keeps it away from the DOM.

const mock = vi.hoisted(() => ({
  toasts: [] as { msg: string; opts?: ToastOptions | number }[],
  restored: [] as number[],
  gone: new Set<number>(),
}));

vi.mock('../public-src/components/toast.js', () => ({
  showToast: vi.fn((msg: string, opts?: ToastOptions | number) => { mock.toasts.push({ msg, opts }); }),
}));

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
  restoreShotFromTrash: vi.fn((id: number) => {
    mock.restored.push(id);
    return Promise.resolve({ ok: true, text: () => Promise.resolve('') } as Response);
  }),
  getShot: vi.fn((id: number) => Promise.resolve(mock.gone.has(id) ? null : { id })),
  listShots: vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response)),
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
  S.shots = ids.map(id => ({ id, timestamp: id, annotation: {} }));
  S.allShots = S.shots;
}

// Clicks the Undo button of the most recent toast and waits for the restore.
async function clickUndo(): Promise<void> {
  const last = mock.toasts.at(-1);
  const opts = last?.opts;
  if (!opts || typeof opts === 'number' || !opts.action) throw new Error('no toast with an action');
  opts.action.onClick();
  await vi.waitFor(() => { expect(mock.restored.length).toBeGreaterThan(0); });
  await new Promise(r => setTimeout(r, 0));
}

describe('undo after trashing a shot from the sidebar (#1716)', () => {
  beforeEach(() => {
    mock.toasts.length = 0;
    mock.restored.length = 0;
    mock.gone.clear();
    S.compareShotId = null;
    S.activeMachineId = null;
  });

  it('shows a "moved to trash" toast with an Undo action', async () => {
    setShots([10, 20, 30]);
    S.primaryShotId = 30;

    await trashShot(20);

    expect(mock.toasts).toHaveLength(1);
    const { msg, opts } = mock.toasts[0]!;
    expect(msg).toBe('Shot moved to trash');
    expect(typeof opts === 'object' && opts.action?.label).toBe('Undo');
  });

  it('Undo restores the open shot, puts it back in place and reselects it', async () => {
    setShots([10, 20, 30]);
    S.primaryShotId = 20;

    await trashShot(20);
    expect(S.primaryShotId).toBe(30);
    expect(S.shots.map(s => s.id)).toEqual([10, 30]);

    await clickUndo();

    expect(mock.restored).toEqual([20]);
    expect(S.shots.map(s => s.id)).toEqual([10, 20, 30]);
    expect(S.allShots.map(s => s.id)).toEqual([10, 20, 30]);
    expect(S.primaryShotId).toBe(20);
    expect(store.glp_primaryShotId).toBe('20');
  });

  it('Undo of a shot that was not open restores it without changing the selection', async () => {
    setShots([10, 20, 30]);
    S.primaryShotId = 30;

    await trashShot(10);
    await clickUndo();

    expect(mock.restored).toEqual([10]);
    expect(S.shots.map(s => s.id)).toEqual([10, 20, 30]);
    expect(S.primaryShotId).toBe(30);
  });

  it('a newer trash replaces the toast; the latest Undo restores only that shot', async () => {
    setShots([10, 20, 30]);
    S.primaryShotId = 30;

    await trashShot(10);
    await trashShot(20);
    await clickUndo();

    expect(mock.restored).toEqual([20]);
    expect(S.shots.map(s => s.id)).toEqual([20, 30]);
  });

  it('does not insert the shot twice when it was already back in the list', async () => {
    setShots([10, 20, 30]);
    S.primaryShotId = 30;

    await trashShot(20);
    setShots([10, 20, 30]); // e.g. restored elsewhere and reloaded by live sync
    await clickUndo();

    expect(S.shots.map(s => s.id)).toEqual([10, 20, 30]);
  });

  it('leaves a shot out that was permanently deleted in the meantime', async () => {
    setShots([10, 20, 30]);
    S.primaryShotId = 20;

    await trashShot(20);
    mock.gone.add(20);
    await clickUndo();

    expect(S.shots.map(s => s.id)).toEqual([10, 30]);
    expect(S.primaryShotId).toBe(30);
  });
});
