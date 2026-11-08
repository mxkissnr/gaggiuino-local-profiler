import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

// #1923: the log-entry and custom-task forms are sheet bodies built by pure
// builders in maintenance-sheet.ts and opened by maintenance.ts. Both modules
// pull in state/index.ts (localStorage/navigator at module load) and i18n.ts,
// so stub the minimum before importing, same approach as
// maintenance-task-sheet.test.ts.
const g = globalThis as unknown as Record<string, unknown>;

type SheetModule = typeof import('../public-src/views/maintenance-sheet.js');
type MaintView = typeof import('../public-src/views/maintenance.js');

let maintLogFormBody: SheetModule['maintLogFormBody'];
let maintCustomFormBody: SheetModule['maintCustomFormBody'];
let openMaintLogForm: MaintView['openMaintLogForm'];
let openMaintCustomForm: MaintView['openMaintCustomForm'];
let closeMaintLogForm: MaintView['closeMaintLogForm'];
let S: typeof import('../public-src/state/index.js').S;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ maintLogFormBody, maintCustomFormBody } = await import('../public-src/views/maintenance-sheet.js'));
  ({ openMaintLogForm, openMaintCustomForm, closeMaintLogForm } = await import('../public-src/views/maintenance.js'));
  ({ S } = await import('../public-src/state/index.js'));
});

beforeEach(() => { S.currentLang = 'en'; });

describe('maintLogFormBody (#1923)', () => {
  it('fills the select with one escaped option per task and pins the date', () => {
    const out = maintLogFormBody(
      [{ task: 'backflush', label: 'Backflush' }, { task: 'custom_a<b', label: 'a<b' }],
      '2026-05-03',
    );

    expect(out).toContain('id="maintLogForm"');
    expect(out).toContain('class="maint-sheet maint-form"');
    expect(out).not.toContain('data-task');
    expect(out).toContain('id="maintLogTask"');
    expect(out).toContain('<option value="backflush">Backflush</option>');
    expect(out).toContain('value="custom_a&lt;b"');
    expect(out).toContain('a&lt;b</option>');
    expect(out).not.toContain('a<b');
    expect(out).toContain('id="maintLogDate"');
    expect(out).toContain('value="2026-05-03"');
    expect(out).toContain('max="2026-05-03"');
    expect(out).toContain('id="maintLogNotes"');
  });

  it('carries no Cancel button, the sheet bar closes the form', () => {
    const out = maintLogFormBody([], '2026-05-03');
    expect(out).not.toContain('maintLogCancelBtn');
    expect(out).not.toContain('maint-log-cancel-btn');
  });
});

describe('maintCustomFormBody (#1923)', () => {
  it('renders the label and the two interval inputs with their ranges', () => {
    const out = maintCustomFormBody();

    expect(out).toContain('class="maint-sheet maint-form"');
    expect(out).toContain('id="customTaskLabel"');
    expect(out).toContain('maxlength="100"');
    expect(out).toContain('id="customTaskShots"');
    expect(out).toContain('min="1" max="10000"');
    expect(out).toContain('id="customTaskDays"');
    expect(out).toContain('min="1" max="3650"');
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
  // The form lives inside the sheet host, so its ids only resolve while the
  // host markup holds them — exactly like the real document.
  const inSheet = { addEventListener: () => {} } as unknown as HTMLElement;
  g.document = {
    getElementById: (id: string) => {
      if (id === 'detailSheet') return host;
      return host.innerHTML.includes(`id="${id}"`) ? inSheet : undefined;
    },
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

// The plan's Context pointers, pinned here instead of editing those files:
// the sheet's action slot and bar ordering come from detail-sheet.ts (whose own
// test asserts them), the labels must resolve through the i18n dictionaries
// (i18n.test.ts fails on a key left unreferenced, so every key the builders
// took over from the deleted markup stays used), and Save borrows the library
// form sheet's .lib-sheet-save convention rather than inventing a button.
describe('form sheets follow the shared sheet and i18n conventions (#1923)', () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeHost();
    installDom(host);
    S.machines = [{ id: 4, name: 'Gaggiuino' }];
    S.activeMachineId = 4;
  });
  afterEach(async () => {
    const { closeDetailSheet } = await import('../public-src/components/detail-sheet.js');
    closeDetailSheet();
  });

  it('puts the Save in the bar actions, after the title, for both forms', () => {
    openMaintLogForm();
    const logSheet = host.innerHTML;
    expect(logSheet).toContain('lib-sheet-bar-actions');
    expect(logSheet.indexOf('id="detailSheetTitle"')).toBeLessThan(logSheet.indexOf('lib-sheet-bar-actions'));

    openMaintCustomForm();
    const customSheet = host.innerHTML;
    expect(customSheet).toContain('lib-sheet-bar-actions');
    expect(customSheet.indexOf('id="detailSheetTitle"')).toBeLessThan(customSheet.indexOf('lib-sheet-bar-actions'));
  });

  it("uses the library form sheet's .lib-sheet-save for the bar action only", () => {
    openMaintLogForm();
    expect(host.innerHTML).toContain('class="lib-sheet-save"');
    expect((host.innerHTML.match(/lib-sheet-save/g) || []).length).toBe(1);

    openMaintCustomForm();
    expect((host.innerHTML.match(/lib-sheet-save/g) || []).length).toBe(1);
  });

  // A key missing from the dictionaries falls back to its own name, so seeing
  // the rendered English text (and not the key) proves the key still resolves.
  it('renders translated labels rather than raw i18n keys', () => {
    openMaintLogForm();
    expect(host.innerHTML).toContain('>Add entry<');
    expect(host.innerHTML).toContain('>Save<');
    expect(host.innerHTML).not.toContain('>maint_log_add<');
    expect(host.innerHTML).not.toContain('>maint_log_save<');

    openMaintCustomForm();
    expect(host.innerHTML).toContain('>Add custom task<');
    expect(host.innerHTML).not.toContain('>maint_custom_add_summary<');

    // The body carries the interval labels; the add action itself is in the bar.
    const body = maintCustomFormBody();
    expect(body).toContain('Every');
    expect(body).toContain('shots');
    expect(body).toContain('Days');
    expect(body).not.toContain('maint_custom_every');
    expect(body).not.toContain('maint_unit_shots');
    expect(body).not.toContain('maint_by_days');
    expect(body).not.toContain('maint_custom_label_ph');
  });
});

describe('openMaintLogForm in the shared sheet (#1923)', () => {
  let host: FakeHost;
  beforeEach(() => { host = makeHost(); installDom(host); });
  afterEach(async () => {
    const { closeDetailSheet } = await import('../public-src/components/detail-sheet.js');
    closeDetailSheet();
  });

  it('puts the log form body in the sheet with Save in the bar', () => {
    openMaintLogForm();

    expect(host.innerHTML).toContain('lib-sheet-bar-actions');
    expect(host.innerHTML).toContain('class="lib-sheet-save"');
    expect(host.innerHTML).toContain('data-action="submit-maint-log"');
    expect(host.innerHTML).toContain('id="maintLogForm"');
    expect(host.innerHTML).toContain('id="maintLogTask"');
  });

  it('closeMaintLogForm closes the sheet while the form is present', () => {
    openMaintLogForm();
    expect(host.classList.contains('open')).toBe(true);
    closeMaintLogForm();
    expect(host.innerHTML).toBe('');
    expect(host.classList.contains('open')).toBe(false);
  });
});

describe('openMaintCustomForm in the shared sheet (#1923)', () => {
  let host: FakeHost;
  beforeEach(() => {
    host = makeHost();
    installDom(host);
    S.machines = [{ id: 4, name: 'Gaggiuino' }];
    S.activeMachineId = 4;
  });
  afterEach(async () => {
    const { closeDetailSheet } = await import('../public-src/components/detail-sheet.js');
    closeDetailSheet();
  });

  it('carries the write machine id on the bar action', () => {
    openMaintCustomForm();

    expect(host.innerHTML).toContain('class="lib-sheet-save"');
    expect(host.innerHTML).toContain('data-action="add-custom-maint-task"');
    expect(host.innerHTML).toContain('data-machine-id="4"');
    expect(host.innerHTML).toContain('id="customTaskLabel"');
  });
});
