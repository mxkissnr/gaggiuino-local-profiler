import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// maintenance.ts pulls in state/index.ts (localStorage/navigator at module load)
// and i18n.ts — neither is available in the plain Node test environment, so
// stub the minimum before importing, same approach as best-grind-combo.test.ts.
type MaintView = typeof import('../public-src/views/maintenance.js');
type MaintTileFixture = Parameters<MaintView['_pickNextDueTile']>[0][number];
let _normalizeMaintTiles: MaintView['_normalizeMaintTiles'];
let _pickNextDueTile: MaintView['_pickNextDueTile'];
let _partitionTiles: MaintView['_partitionTiles'];
let _maintLogTaskOptions: MaintView['_maintLogTaskOptions'];
let _maintVerdictState: MaintView['_maintVerdictState'];
let _maintVerdictHtml: MaintView['_maintVerdictHtml'];
let isAutoSynced: MaintView['isAutoSynced'];
let renderMaintenanceDashboard: MaintView['renderMaintenanceDashboard'];

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ _normalizeMaintTiles, _pickNextDueTile, _partitionTiles, _maintLogTaskOptions, _maintVerdictState,
     _maintVerdictHtml, isAutoSynced,
     renderMaintenanceDashboard } = await import('../public-src/views/maintenance.js'));
});

interface MaintTaskFixture {
  status: string;
  pct: number;
  daysSince: number | null;
  shotsSince: number;
  threshold_shots: number | null;
  threshold_days: number | null;
}
interface MaintTaskOverrides {
  daysSince?: number | null;
  shotsSince?: number;
  threshold_shots?: number | null;
  threshold_days?: number | null;
  threshold_g?: number | null;
  gramsSince?: number | null;
  machineSyncedAt?: string | number | null;
  lastDate?: string | null;
  grinderName?: string | null;
  disabled?: boolean;
  label?: string | null;
}
const task = (status: string, overrides: MaintTaskOverrides = {}): MaintTaskFixture => ({
  status, pct: status === 'ok' ? 0.2 : status === 'soon' ? 0.85 : 1,
  daysSince: null, shotsSince: 0, threshold_shots: null, threshold_days: null,
  ...overrides,
});

describe('_normalizeMaintTiles (#393)', () => {
  it('flattens a single-machine flat response into tiles, tagging global tasks', () => {
    const data = {
      descaling: task('due', { threshold_shots: 200, shotsSince: 210 }),
      backflush: task('ok', { threshold_shots: 20, shotsSince: 5 }),
      waterfilter: task('ok', { threshold_days: 90, daysSince: 10 }),
      grinder_1: task('never', { grinderName: 'Niche Zero' }),
    };
    const tiles = _normalizeMaintTiles(data, 1);
    expect(tiles).toHaveLength(4);
    expect(tiles.every(t => t.machineId === 1)).toBe(true);
    expect(tiles.find(t => t.task === 'descaling')!.isGlobal).toBe(false);
    expect(tiles.find(t => t.task === 'waterfilter')!.isGlobal).toBe(true);
    expect(tiles.find(t => t.task === 'grinder_1')!.isGlobal).toBe(true);
    // Single-machine scope never shows a per-machine name tag (nothing to
    // disambiguate against) — only the "shared" tag on global tasks.
    expect(tiles.every(t => t.showMachineTag === false)).toBe(true);
  });

  it('flattens the grouped "all machines" shape (#392) into one tile list, deduping global tasks', () => {
    const data = {
      all: true,
      machines: [
        { machineId: 1, machineName: 'Gaggiuino', tasks: { descaling: task('due', { threshold_shots: 200, shotsSince: 210 }) } },
        { machineId: 2, machineName: 'GaggiMate Sim', tasks: { descaling: task('never') } },
      ],
      global: { waterfilter: task('ok', { threshold_days: 90, daysSince: 10 }) },
    };
    const tiles = _normalizeMaintTiles(data, 'all');
    expect(tiles).toHaveLength(3); // 2 per-machine + 1 global, not duplicated per machine
    const descalingTiles = tiles.filter(t => t.task === 'descaling');
    expect(descalingTiles).toHaveLength(2);
    expect(descalingTiles.map(t => t.machineId).sort()).toEqual([1, 2]);
    const waterfilterTiles = tiles.filter(t => t.task === 'waterfilter');
    expect(waterfilterTiles).toHaveLength(1);
    expect(waterfilterTiles[0]?.isGlobal).toBe(true);
    // Global tile still needs a concrete machineId for its own done/threshold
    // writes (the backend ignores it for global tasks, but the URL needs one).
    expect(waterfilterTiles[0]?.machineId).toBe(1);
  });
});

describe('_pickNextDueTile (#393 — "Als Nächstes" banner target)', () => {
  it('returns null when nothing is due or never-done', () => {
    const tiles = [
      { task: 'backflush', d: task('ok') },
      { task: 'waterfilter', d: task('soon') },
    ] as unknown as MaintTileFixture[];
    expect(_pickNextDueTile(tiles)).toBeNull();
  });

  it('picks the tile with the largest shots-overage among due tasks', () => {
    const tiles = [
      { task: 'backflush', d: task('due', { threshold_shots: 20, shotsSince: 23 }) }, // 3 over
      { task: 'descaling', d: task('due', { threshold_shots: 200, shotsSince: 178 }) }, // not actually over (pct<1 in reality, but status forced here)
      { task: 'grouphead', d: task('due', { threshold_days: 180, daysSince: 200 }) }, // 20 over
    ] as unknown as MaintTileFixture[];
    const picked = _pickNextDueTile(tiles);
    expect(picked!.task).toBe('grouphead');
  });

  it('treats a never-done task\'s total shot count as its overage, so an established machine\'s never-cleaned task outranks a barely-overdue one', () => {
    const tiles = [
      { task: 'backflush', d: task('due', { threshold_shots: 20, shotsSince: 22 }) }, // 2 over
      { task: 'descaling', d: task('never', { shotsSince: 500 }) },
    ] as unknown as MaintTileFixture[];
    const picked = _pickNextDueTile(tiles);
    expect(picked!.task).toBe('descaling');
  });
});

// #: dashboard-vs-log mismatch bug report — the manual log-entry form's task
// dropdown must offer exactly the tasks the dashboard cards show (custom
// labels, grinder names, never a disabled task), not just MAINT_META's 5
// static keys.
describe('_maintLogTaskOptions', () => {
  it('resolves custom and grinder task names the same way the dashboard cards do', () => {
    const tiles = [
      { task: 'descaling', d: task('due') },
      { task: 'grinder_1', d: task('never', { grinderName: 'Niche Zero' }) },
      { task: 'custom_ruckspulen', d: task('ok', { label: 'Rückspülen mit Reiniger' }) },
    ] as unknown as MaintTileFixture[];
    const options = _maintLogTaskOptions(tiles);
    expect(options).toEqual([
      { task: 'descaling', label: expect.any(String) as string },
      { task: 'grinder_1', label: 'Niche Zero' },
      { task: 'custom_ruckspulen', label: 'Rückspülen mit Reiniger' },
    ]);
  });

  it('excludes disabled tasks (via _partitionTiles, which callers run first)', () => {
    const allTiles = [
      { task: 'descaling', d: task('due') },
      { task: 'backflush', d: { ...task('ok'), disabled: true } },
    ] as unknown as MaintTileFixture[];
    const { active } = _partitionTiles(allTiles);
    const options = _maintLogTaskOptions(active);
    expect(options.map(o => o.task)).toEqual(['descaling']);
  });

  it('dedups a task that appears once per machine under "all" scope to a single option', () => {
    const tiles = [
      { task: 'descaling', machineId: 1, d: task('due') },
      { task: 'descaling', machineId: 2, d: task('ok') },
    ] as unknown as MaintTileFixture[];
    const options = _maintLogTaskOptions(tiles);
    expect(options).toHaveLength(1);
  });
});

// #1923: the card no longer expands its own detail panel — the single Details
// button opens the shared popover / bottom sheet (views/maintenance-sheet.ts).
// A card that kept the old .detail markup would show the interval twice, so
// pin the new shape: one toggle carrying the tile's task and machine, and no
// inline mode segment, threshold input or done/disable/delete buttons.
interface FakeEl {
  innerHTML: string;
  className: string;
  style: { display: string };
  children: FakeEl[];
  appendChild: (child: FakeEl) => void;
}

function fakeEl(): FakeEl {
  const el: FakeEl = {
    innerHTML: '', className: '', style: { display: '' }, children: [],
    appendChild: (child) => { el.children.push(child); },
  };
  return el;
}

describe('maintenance card markup (#1923)', () => {
  const ids = ['maint-cards', 'maintScopeSeg', 'maintScopeHint', 'maintGrid',
               'maintCustomSection', 'maintDisabledSection'];
  let els: Map<string, FakeEl>;

  beforeEach(() => {
    els = new Map(ids.map(id => [id, fakeEl()]));
    (globalThis as unknown as Record<string, unknown>).document = {
      getElementById: (id: string) => els.get(id) ?? null,
      createElement: () => fakeEl(),
    };
  });

  function renderOne(name: string, overrides: MaintTaskOverrides = {}): string {
    const data = { [name]: task('ok', overrides) };
    renderMaintenanceDashboard(data, 1);
    const grid = els.get('maintGrid')!;
    expect(grid.children).toHaveLength(1);
    return grid.children[0]!.innerHTML;
  }

  it('renders one Details button that opens the task sheet for that tile', () => {
    const html = renderOne('backflush', { threshold_shots: 40, shotsSince: 12 });

    expect(html).toContain('data-action="open-maint-task"');
    expect(html).toContain('data-task="backflush"');
    expect(html).toContain('data-machine-id="1"');
    expect((html.match(/data-action="open-maint-task"/g) || []).length).toBe(1);
  });

  it('leaves no inline interval, threshold, done or disable markup on the card', () => {
    const html = renderOne('backflush', { threshold_shots: 40, shotsSince: 12 });

    expect(html).not.toContain('toggle-maint-detail');
    expect(html).not.toContain('class="detail"');
    expect(html).not.toContain('maint-mode-seg');
    expect(html).not.toContain('set-maint-mode');
    expect(html).not.toContain('save-maint-threshold');
    expect(html).not.toContain('rename-maint-label');
    expect(html).not.toContain('mark-maint-done');
    expect(html).not.toContain('toggle-maint-disabled');
  });

  it('still shows the count text on the card', () => {
    const html = renderOne('backflush', { threshold_shots: 40, shotsSince: 12 });
    expect(html).toContain('12 / 40 Shots');
  });
});

// #1639: the "Auto" badge must appear only when a task's last done date IS the
// machine's own service-log timestamp — not merely whenever machineSyncedAt is
// set. ApplyMachineServiceLog advances machineSyncedAt even when a newer manual
// "done" wins (lastDate unchanged), and a later manual "done" leaves a stale
// machineSyncedAt in place, so a non-null machineSyncedAt is not enough.
type MaintTaskArg = Parameters<MaintView['isAutoSynced']>[0];
describe('isAutoSynced (#1639)', () => {
  it('is true when the last done date is the machine timestamp', () => {
    const at = '2026-10-01T08:30:00.000Z';
    const d = task('ok', { machineSyncedAt: Date.parse(at), lastDate: at }) as unknown as MaintTaskArg;
    expect(isAutoSynced(d)).toBe(true);
  });

  it('is false when machineSyncedAt is older than a newer manual done', () => {
    const synced = '2026-09-01T08:30:00.000Z';
    const manual = '2026-10-01T08:30:00.000Z';
    const d = task('ok', { machineSyncedAt: Date.parse(synced), lastDate: manual }) as unknown as MaintTaskArg;
    expect(isAutoSynced(d)).toBe(false);
  });

  it('is false when the task has no machine sync at all', () => {
    const d = task('ok', { lastDate: '2026-10-01T08:30:00.000Z' }) as unknown as MaintTaskArg;
    expect(isAutoSynced(d)).toBe(false);
  });
});

type MaintTileArg = Parameters<MaintView['_maintVerdictState']>[0][number];
const tile = (name: string, status: string, overrides: MaintTaskOverrides = {}): MaintTileArg =>
  ({ task: name, d: task(status, overrides), machineId: 1, machineName: null, isGlobal: false, showMachineTag: false });

describe('_maintVerdictState (#1923)', () => {
  it('picks the due tile over a sooner one', () => {
    const tiles = [tile('soon-task', 'soon'), tile('due-task', 'due', { threshold_shots: 10, shotsSince: 20 })];
    const state = _maintVerdictState(tiles);
    expect(state.kind).toBe('due');
    expect(state.tile?.task).toBe('due-task');
  });

  it('counts a never-done task as due', () => {
    const state = _maintVerdictState([tile('backflush', 'never'), tile('descaling', 'ok')]);
    expect(state.kind).toBe('due');
    expect(state.dueCount).toBe(1);
  });

  it('counts due and never together', () => {
    const state = _maintVerdictState([
      tile('a', 'due'), tile('b', 'never'), tile('c', 'soon'), tile('d', 'ok'),
    ]);
    expect(state.dueCount).toBe(2);
  });

  it('falls back to the highest-pct soon tile when nothing is due', () => {
    const low = tile('low', 'soon', {});
    low.d.pct = 0.7;
    const high = tile('high', 'soon', {});
    high.d.pct = 0.95;
    const state = _maintVerdictState([low, high, tile('ok', 'ok')]);
    expect(state.kind).toBe('soon');
    expect(state.tile?.task).toBe('high');
    expect(state.dueCount).toBe(0);
  });

  it('reports ok with the highest-pct tile when everything is fine', () => {
    const low = tile('low', 'ok', {});
    low.d.pct = 0.1;
    const high = tile('high', 'ok', {});
    high.d.pct = 0.6;
    const state = _maintVerdictState([low, high]);
    expect(state.kind).toBe('ok');
    expect(state.tile?.task).toBe('high');
  });

  it('reports empty for no tiles', () => {
    const state = _maintVerdictState([]);
    expect(state.kind).toBe('empty');
    expect(state.tile).toBeNull();
    expect(state.dueCount).toBe(0);
  });
});

describe('_maintVerdictHtml (#1923)', () => {
  it('offers the done action for the due tile with its task, machine and text', () => {
    const dueTile = tile('descaling', 'due', { threshold_shots: 20, shotsSince: 40 });
    const html = _maintVerdictHtml(_maintVerdictState([dueTile]));
    expect(html).toContain('mark-maint-done');
    expect(html).toContain('data-task="descaling"');
    expect(html).toContain('data-machine-id="1"');
    expect(html).toContain('Descaling');
    expect(html).toContain('20 shots overdue');
  });

  it('offers no done action when nothing is due', () => {
    const ok = _maintVerdictHtml(_maintVerdictState([tile('backflush', 'ok')]));
    const soon = _maintVerdictHtml(_maintVerdictState([tile('backflush', 'soon')]));
    expect(ok).not.toContain('mark-maint-done');
    expect(soon).not.toContain('mark-maint-done');
  });

  it('puts the due count in the big number, due when > 0 and ok when 0', () => {
    const due = _maintVerdictHtml(_maintVerdictState([tile('a', 'due'), tile('b', 'never')]));
    expect(due).toMatch(/maint-verdict-num due">2</);
    const ok = _maintVerdictHtml(_maintVerdictState([tile('a', 'ok')]));
    expect(ok).toMatch(/maint-verdict-num ok">0</);
  });

  it('escapes a task name containing markup', () => {
    const custom = tile('custom_1', 'due', { label: 'A < B' });
    const html = _maintVerdictHtml(_maintVerdictState([custom]));
    expect(html).toContain('A &lt; B');
    expect(html).not.toContain('A < B');
  });
});
