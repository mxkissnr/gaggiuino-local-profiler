import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

// maintenance-sheet.ts pulls in state/index.ts (localStorage/navigator at
// module load), i18n.ts and the detail sheet — none of which run in the plain
// Node test environment, so stub the minimum before importing, same approach
// as maint-dashboard.test.ts and detail-sheet.test.ts.
const g = globalThis as unknown as Record<string, unknown>;

type SheetModule = typeof import('../public-src/views/maintenance-sheet.js');
type MaintView = typeof import('../public-src/views/maintenance.js');
type Tile = Parameters<SheetModule['maintTaskSheetBody']>[0];
type Entry = Parameters<SheetModule['maintTaskSheetBody']>[1][number];

let maintTaskSheetBody: SheetModule['maintTaskSheetBody'];
let maintTaskSheetActions: SheetModule['maintTaskSheetActions'];
let openMaintTaskSheet: SheetModule['openMaintTaskSheet'];
let _maintCountText: MaintView['_maintCountText'];
let AUTO_SYNCED_NOTE: MaintView['AUTO_SYNCED_NOTE'];

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ maintTaskSheetBody, maintTaskSheetActions, openMaintTaskSheet } = await import('../public-src/views/maintenance-sheet.js'));
  ({ _maintCountText, AUTO_SYNCED_NOTE } = await import('../public-src/views/maintenance.js'));
});

interface TaskOverrides {
  status?: string;
  pct?: number;
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

interface TileOverrides {
  machineId?: number;
  machineName?: string | null;
  isGlobal?: boolean;
  showMachineTag?: boolean;
}

function taskData(overrides: TaskOverrides = {}): Tile['d'] {
  const d: Tile['d'] = {
    status: 'ok', pct: 0.2, daysSince: null, shotsSince: 0,
    threshold_shots: null, threshold_days: null,
  };
  return Object.assign(d, overrides);
}

function tile(task: string, overrides: TaskOverrides = {}, tileOverrides: TileOverrides = {}): Tile {
  return {
    task,
    d: taskData(overrides),
    machineId: tileOverrides.machineId ?? 1,
    machineName: tileOverrides.machineName ?? null,
    isGlobal: tileOverrides.isGlobal ?? (task === 'waterfilter' || task.startsWith('grinder_')),
    showMachineTag: tileOverrides.showMachineTag ?? false,
  };
}

interface EntryOverrides {
  machineId?: number | null;
  shotCountAtTime?: number | null;
  notes?: string | null;
}

function entry(id: number, task: string, overrides: EntryOverrides = {}): Entry {
  return { id, task, ts: Date.UTC(2026, 4, 3) / 1000, ...overrides };
}

describe('maintTaskSheetBody (#1923)', () => {
  it('renders the three mode buttons with the tile machine id and the shots threshold', () => {
    const t0 = tile('backflush', { threshold_shots: 40, shotsSince: 12, status: 'soon' });
    const out = maintTaskSheetBody(t0, []);

    expect(out).toContain('class="maint-sheet"');
    expect(out).toContain('data-task="backflush"');
    expect(out).toContain('data-machine-id="1"');
    expect((out.match(/data-action="set-maint-mode"/g) || []).length).toBe(3);
    expect((out.match(/data-machine-id="1"/g) || []).length).toBeGreaterThanOrEqual(5);
    // shots is the active mode
    expect(out).toMatch(/class="analytics-filter-btn active"[^>]*data-mode="shots"/);
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('data-field="threshold_shots"');
    expect(out).toContain('data-action="toggle-maint-disabled"');
    expect(out).toContain('data-disabled="true"');
    expect(out).not.toContain('rename-maint-label');
    expect(out).not.toContain('delete-custom-maint-task');
  });

  it('adds the grams mode and a threshold_g input for a grinder tile in grams mode', () => {
    const t0 = tile('grinder_7', { threshold_g: 500, gramsSince: 120, grinderName: 'Niche Zero' });
    const out = maintTaskSheetBody(t0, []);

    expect((out.match(/data-action="set-maint-mode"/g) || []).length).toBe(4);
    expect(out).toMatch(/class="analytics-filter-btn active"[^>]*data-mode="g"/);
    expect(out).toContain('data-field="threshold_g"');
    expect(out).not.toContain('data-field="threshold_shots"');
  });

  it('renders an escaped rename field and delete (no disable) for a custom tile', () => {
    const t0 = tile('custom_clean', { label: 'a<b', threshold_shots: 10 });
    const out = maintTaskSheetBody(t0, []);

    expect(out).toContain('data-action="rename-maint-label"');
    expect(out).toContain('value="a&lt;b"');
    expect(out).toContain('data-action="delete-custom-maint-task"');
    expect(out).not.toContain('data-action="toggle-maint-disabled"');
  });

  it('shows only this task\'s history entries, in API order', () => {
    const t0 = tile('backflush', { threshold_shots: 40 });
    const out = maintTaskSheetBody(t0, [
      entry(3, 'descaling', { shotCountAtTime: 999 }),
      entry(2, 'backflush', { shotCountAtTime: 111 }),
      entry(1, 'backflush', { shotCountAtTime: 222 }),
    ]);

    expect(out).not.toContain('999');
    expect(out.indexOf('111')).toBeLessThan(out.indexOf('222'));
    expect((out.match(/class="maint-hist-row"/g) || []).length).toBe(2);
  });

  it('scopes entries by machine for a per-machine tile and includes all machines for a global tile', () => {
    const history = [
      entry(1, 'backflush', { machineId: 1, shotCountAtTime: 111 }),
      entry(2, 'backflush', { machineId: 2, shotCountAtTime: 222 }),
    ];
    const perMachine = maintTaskSheetBody(tile('backflush', { threshold_shots: 40 }, { machineId: 1 }), history);
    expect((perMachine.match(/class="maint-hist-row"/g) || []).length).toBe(1);
    expect(perMachine).toContain('111');
    expect(perMachine).not.toContain('222');

    const global = maintTaskSheetBody(tile('waterfilter', { threshold_days: 90 }, { isGlobal: true }), [
      entry(1, 'waterfilter', { machineId: 1, shotCountAtTime: 111 }),
      entry(2, 'waterfilter', { machineId: 2, shotCountAtTime: 222 }),
    ]);
    expect((global.match(/class="maint-hist-row"/g) || []).length).toBe(2);
  });

  it('renders the Auto badge instead of the raw marker and escapes notes', () => {
    const t0 = tile('backflush', { threshold_shots: 40 });
    const out = maintTaskSheetBody(t0, [
      entry(1, 'backflush', { shotCountAtTime: 10, notes: AUTO_SYNCED_NOTE }),
      entry(2, 'backflush', { shotCountAtTime: 12, notes: 'a<b' }),
    ]);

    expect(out).toContain('maint-auto-synced');
    expect(out).not.toContain(AUTO_SYNCED_NOTE);
    expect(out).toContain('a&lt;b');
    expect(out).not.toContain('a<b');
  });

  it('marks a manual entry (no shot count at the time) with the manual badge', () => {
    const out = maintTaskSheetBody(tile('backflush', { threshold_shots: 40 }), [
      entry(1, 'backflush', { shotCountAtTime: null }),
    ]);
    expect(out).toContain('maint-log-manual-badge');
    expect(out).toContain('<span class="maint-hist-count">–</span>');
  });

  it('shows the empty note when no entry matches', () => {
    const out = maintTaskSheetBody(tile('backflush', { threshold_shots: 40 }), []);
    expect(out).toContain('class="empty-note"');
    expect(out).toContain('No entries yet.');
  });
});

describe('maintTaskSheetActions (#1923)', () => {
  it('is one 44px icon button that marks the task done', () => {
    const out = maintTaskSheetActions(tile('backflush', { threshold_shots: 40 }, { machineId: 2 }));

    expect(out).toContain('class="lib-sheet-iconbtn"');
    expect(out).toContain('data-action="mark-maint-done"');
    expect(out).toContain('data-task="backflush"');
    expect(out).toContain('data-machine-id="2"');
    expect(out).toContain('aria-label="Mark as done"');
    expect(out).toContain('<svg');
  });
});

type KeyHandler = (e: KeyboardEvent) => void;

interface FakeHost {
  innerHTML: string;
  classList: { add: (t: string) => void; remove: (t: string) => void; contains: (t: string) => boolean };
  querySelector: (sel?: string) => unknown;
  style: Record<string, string>;
}

function makeHost(): FakeHost {
  const set = new Set<string>();
  return {
    innerHTML: '',
    classList: { add: (t) => { set.add(t); }, remove: (t) => { set.delete(t); }, contains: (t) => set.has(t) },
    querySelector: () => null,
    style: {},
  };
}

// Minimal copy of detail-sheet.test.ts's installDom: the sheet only needs the
// host, the keyboard hook and document.body's class list.
function installDom(host: FakeHost): void {
  const listeners: Record<string, KeyHandler[]> = {};
  const bodyClasses = new Set<string>();
  g.window = {
    matchMedia: (query: string) => ({ matches: query.includes('max-width') ? false : true }),
    innerWidth: 1200,
    innerHeight: 800,
  };
  g.document = {
    getElementById: (id: string) => (id === 'detailSheet' ? host : undefined),
    body: {
      classList: {
        add: (t: string) => { bodyClasses.add(t); },
        remove: (t: string) => { bodyClasses.delete(t); },
        contains: (t: string) => bodyClasses.has(t),
      },
    },
    activeElement: null,
    contains: () => true,
    addEventListener: (type: string, fn: KeyHandler) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type: string, fn: KeyHandler) => {
      const a = listeners[type];
      if (a) listeners[type] = a.filter(f => f !== fn);
    },
  };
}

describe('openMaintTaskSheet (#1923)', () => {
  let host: FakeHost;
  beforeEach(() => { host = makeHost(); });
  afterEach(async () => {
    const { closeDetailSheet } = await import('../public-src/components/detail-sheet.js');
    closeDetailSheet();
  });

  it('opens the task in the shared sheet with the title, bar action and body', () => {
    installDom(host);
    openMaintTaskSheet(tile('backflush', { threshold_shots: 40, shotsSince: 12 }), [], null);

    expect(host.innerHTML).toContain('Backflush');
    expect(host.innerHTML).toContain('lib-sheet-bar-actions');
    expect(host.innerHTML).toContain('class="maint-sheet"');
    expect(host.innerHTML).toContain('Mark as done');
  });

  it('builds the subtitle from the status, the count and the machine tag', () => {
    installDom(host);
    openMaintTaskSheet(
      tile('backflush', { threshold_shots: 40, shotsSince: 12, status: 'soon' }, { machineName: 'Gaggiuino', showMachineTag: true }),
      [],
      null,
    );

    expect(host.innerHTML).toContain('12 / 40 Shots');
    expect(host.innerHTML).toContain('Gaggiuino');
    expect(host.innerHTML).toContain(' · ');
  });
});

describe('_maintCountText (#1923)', () => {
  it('formats shots, days, both, grams and never exactly as before', () => {
    expect(_maintCountText('backflush', tile('backflush', { threshold_shots: 40, shotsSince: 12, status: 'soon' }).d))
      .toBe('12 / 40 Shots');
    expect(_maintCountText('grouphead', tile('grouphead', { threshold_days: 180, daysSince: 20, status: 'soon' }).d))
      .toBe('20 / 180 Days');
    expect(_maintCountText('descaling', tile('descaling', { threshold_shots: 200, threshold_days: 30, shotsSince: 12, daysSince: 4, status: 'soon' }).d))
      .toBe('12/200 Shots · 4/30 Days');
    expect(_maintCountText('grinder_1', tile('grinder_1', { threshold_g: 500, gramsSince: 120 }).d))
      .toBe('120g / 500g');
    expect(_maintCountText('descaling', tile('descaling', { status: 'never', shotsSince: 500 }).d))
      .toBe('Never done');
  });
});
