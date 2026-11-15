import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShotMeta } from '../public-src/state/index.js';

// library.ts's import chain touches state/index.ts/i18n.ts, which read
// localStorage/navigator at module load time — stub the minimum browser
// globals so the module graph can be imported under vitest's node
// environment (same pattern as test/library-last-grind-setting.test.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };

// The pin toggle saves through the library API and reports failures through
// the toast; mocking both keeps the test off the network and lets it hold a
// save open to prove the in-flight guard.
const mocks = vi.hoisted(() => ({ saveBean: vi.fn(), toast: vi.fn() }));
vi.mock('../public-src/api/library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public-src/api/library.js')>();
  return { ...actual, saveBean: mocks.saveBean };
});
vi.mock('../public-src/components/toast.js', () => ({ showToast: mocks.toast }));

const { S } = await import('../public-src/state/index.js');

interface LibraryModule {
  renderBeanCard: (b: unknown, beans: unknown[]) => string;
}
const { renderBeanCard } = (await import('../public-src/views/library.js')) as unknown as LibraryModule;
const { toggleBeanProfilePin } = await import('../public-src/views/library/bean-profiles.js');

interface FakeDocument {
  elements: Record<string, { innerHTML: string }>;
  document: {
    getElementById: (id: string) => { innerHTML: string } | undefined;
    querySelectorAll: () => never[];
  };
}

// `elements` is a plain Record, so an entry reads as `{ innerHTML } | undefined`
// under noUncheckedIndexedAccess; narrow by throwing rather than asserting.
function uiNode(elements: Record<string, { innerHTML: string }>): { innerHTML: string } {
  const node = elements.beanListUI;
  if (node === undefined) throw new Error('beanListUI element missing');
  return node;
}

function fakeDocument(): FakeDocument {
  const elements: Record<string, { innerHTML: string }> = { beanListUI: { innerHTML: '' } };
  return {
    elements,
    document: {
      getElementById: (id: string) => elements[id],
      querySelectorAll: () => [],
    },
  };
}

// The card is the sheet's body; render it straight off S so a toggle's
// re-render is visible without building the sheet host. S types library rows
// as opaque records and the import is cast to LibraryModule above, so the
// render call below is checked at the module boundary only, like the other
// library tests.
function card(id: number): string {
  const beans = S.coffeeLibrary.beans;
  const bean = beans.find(b => Number(b['id']) === id);
  if (!bean) throw new Error(`bean ${id} missing`);
  return renderBeanCard(bean, beans);
}

type ShotRow = ShotMeta & {
  profileName: string;
  annotation: { beanId: number; coffee: string; rating: string | null };
};

interface ShotSpec {
  beanId: number;
  profile: string;
  rating?: number;
  machineId?: number;
  timestamp: number;
}

function shot(spec: ShotSpec): ShotRow {
  return {
    id: spec.timestamp,
    timestamp: spec.timestamp,
    machineId: spec.machineId ?? 1,
    profileName: spec.profile,
    annotation: {
      beanId: spec.beanId,
      coffee: 'Bean',
      rating: spec.rating != null ? String(spec.rating) : null,
    },
  };
}

function deferred<T>() {
  const box: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>(res => { box.resolve = res; });
  return { promise, resolve: (value: T) => box.resolve?.(value) };
}

const LONDINIUM = [
  shot({ beanId: 1, profile: 'Londinium', rating: 5, timestamp: 1000 }),
  shot({ beanId: 1, profile: 'Londinium', rating: 4, timestamp: 2000 }),
  shot({ beanId: 1, profile: 'Londinium', rating: 4, timestamp: 3000 }),
];

const plainBean = { id: 1, name: 'Bean', bags: [] };

describe('bean detail sheet profile history (#1963)', () => {
  beforeEach(() => {
    const { elements, document } = fakeDocument();
    g.document = document;
    uiNode(elements).innerHTML = '';
    mocks.saveBean.mockReset();
    mocks.toast.mockReset();
    S.currentLang = 'en';
    S.activeMachineId = 1;
    S.machineProfiles = [];
    S.machineProfilesStale = false;
    S.machines = [{ id: 1, name: 'Gaggia' }, { id: 2, name: 'Luna' }];
    S.shots = [];
  });

  it('lists a profile proven by three rated shots with its rating and sample count', () => {
    S.coffeeLibrary = { beans: [plainBean], grinders: [] };
    S.shots = LONDINIUM;

    const html = card(1);
    expect(html).toContain('lib-sheet-profiles');
    expect(html).toContain('Proven profiles');
    expect(html).toContain('lib-profile-name">Londinium');
    expect(html).toContain('Ø 4.3 stars · 3 rated shots');
    expect(html).toContain('data-action="toggle-bean-profile-pin"');
    expect(html).toContain('aria-pressed="false"');
  });

  it('pins the profile on tap and unpins it on the next, changing the rendered state', async () => {
    S.coffeeLibrary = { beans: [plainBean], grinders: [] };
    S.shots = LONDINIUM;
    expect(card(1)).toContain('aria-pressed="false"');

    mocks.saveBean.mockResolvedValueOnce({ ...plainBean, pinnedProfiles: [{ machineId: 1, name: 'Londinium' }] });
    await toggleBeanProfilePin(1, 1, 'Londinium');
    expect(mocks.saveBean).toHaveBeenCalledWith(1, { pinnedProfiles: [{ machineId: 1, name: 'Londinium' }] });
    expect(card(1)).toContain('aria-pressed="true"');

    mocks.saveBean.mockResolvedValueOnce({ ...plainBean, pinnedProfiles: [] });
    await toggleBeanProfilePin(1, 1, 'Londinium');
    expect(mocks.saveBean).toHaveBeenLastCalledWith(1, { pinnedProfiles: [] });
    expect(card(1)).toContain('aria-pressed="false"');
  });

  it('suggests a profile from similar beans, and drops the section when the machine has no history', () => {
    S.coffeeLibrary = {
      beans: [
        { id: 10, name: 'Fresh Bean', roastLevel: 'medium', process: 'Washed', bags: [] },
        { id: 11, name: 'Similar Bean', roastLevel: 'medium', process: 'Washed', bags: [] },
      ],
      grinders: [],
    };
    S.shots = [
      shot({ beanId: 11, profile: 'Blooming', rating: 5, timestamp: 1000 }),
      shot({ beanId: 11, profile: 'Blooming', rating: 5, timestamp: 2000 }),
      shot({ beanId: 11, profile: 'Blooming', rating: 4, timestamp: 3000 }),
    ];

    const html = card(10);
    expect(html).toContain('Suggested from similar beans');
    expect(html).toContain('lib-profile-name">Blooming');
    expect(html).toContain('from 1 similar bean');
    expect(html).not.toContain('Proven profiles');

    // The same bean on a machine with one lone shot: too thin, no section.
    S.activeMachineId = 2;
    S.shots = [shot({ beanId: 11, profile: 'Blooming', rating: 5, machineId: 2, timestamp: 1000 })];
    expect(card(10)).not.toContain('lib-sheet-profiles');
    expect(card(10)).not.toContain('Blooming');
  });

  it('sends nothing while a pin save is still pending', async () => {
    S.coffeeLibrary = { beans: [plainBean], grinders: [] };
    S.shots = LONDINIUM;
    const pending = deferred<unknown>();
    mocks.saveBean.mockReturnValueOnce(pending.promise);

    const first = toggleBeanProfilePin(1, 1, 'Londinium');
    await toggleBeanProfilePin(1, 1, 'Londinium');
    expect(mocks.saveBean).toHaveBeenCalledTimes(1);

    pending.resolve({ ...plainBean, pinnedProfiles: [{ machineId: 1, name: 'Londinium' }] });
    await first;
    expect(card(1)).toContain('aria-pressed="true"');
  });

  it('keeps the old pins and shows the save-error toast when the save fails', async () => {
    S.coffeeLibrary = {
      beans: [{ ...plainBean, pinnedProfiles: [{ machineId: 1, name: 'Londinium' }] }],
      grinders: [],
    };
    S.shots = LONDINIUM;
    mocks.saveBean.mockRejectedValueOnce(new Error('offline'));

    await toggleBeanProfilePin(1, 1, 'Londinium');
    expect(mocks.toast).toHaveBeenCalledWith('Error saving');
    expect(card(1)).toContain('aria-pressed="true"');
    expect(S.coffeeLibrary.beans[0]?.['pinnedProfiles']).toEqual([{ machineId: 1, name: 'Londinium' }]);
  });

  it('flags a pinned profile the machine no longer has, and names the machine when all are shown', () => {
    // A pin outlives the profile it names: the machine list no longer has
    // "Ghost", so the row stays visible (to be unpinned) and says so.
    S.coffeeLibrary = {
      beans: [{ ...plainBean, pinnedProfiles: [{ machineId: 1, name: 'Ghost' }] }],
      grinders: [],
    };
    S.machineProfiles = [{ name: 'Londinium' }];
    expect(card(1)).toContain('Pinned, no rated shots yet');
    expect(card(1)).toContain('Not on this machine any more');

    // With "all machines" the rows pool machines, so each row names its own.
    S.activeMachineId = 'all';
    expect(card(1)).toContain('lib-profile-name">Ghost');
    expect(card(1)).toContain('Gaggia');
  });

  it('escapes a profile name instead of letting it become markup', () => {
    const evil = '<img src=x onerror=alert(1)>';
    S.coffeeLibrary = { beans: [plainBean], grinders: [] };
    S.shots = [
      shot({ beanId: 1, profile: evil, rating: 5, timestamp: 1000 }),
      shot({ beanId: 1, profile: evil, rating: 5, timestamp: 2000 }),
      shot({ beanId: 1, profile: evil, rating: 5, timestamp: 3000 }),
    ];

    const html = card(1);
    expect(html).toContain('lib-profile-name');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
