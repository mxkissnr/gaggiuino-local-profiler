import { describe, it, expect, beforeEach, vi } from 'vitest';

// annotation.js imports state.js, which reads localStorage/navigator at
// module load time — same stubbing approach as milk-deduct-gate.test.js.
// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge test/helpers/fake-option-dom.ts uses).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
// r.ok:false keeps _performAnnotationSave from reaching the post-save
// renderSidebar()/updateSidebarHighlighting() calls (heavier DOM deps not
// stubbed here) — the payload sent to apiFetch is captured regardless.
const fetchSpy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue({ ok: false } as Response);
const { scheduleAutoSave, flushAutoSave } = await import('../public-src/views/shots/annotation.js');

// #635: mirrors _renderBeanSelect's data-bean-id contract — a selected
// option carries data-basket-id/data-puckscreen-id only when it corresponds
// to a real library entry; the empty/unselected option carries neither.
function fakeAnnotationDom(basketId: number | null, puckScreenId: number | null): void {
  const elements: Record<string, unknown> = {
    annCoffee:      { value: '', selectedOptions: [{ dataset: {} }] },
    annBasket:      { selectedOptions: [{ dataset: basketId != null ? { basketId: String(basketId) } : {} }] },
    annPuckScreen:  { selectedOptions: [{ dataset: puckScreenId != null ? { puckscreenId: String(puckScreenId) } : {} }] },
    annGrinder:     { value: '' },
    annGrindSetting:{ value: '' },
    annDose:        { value: '' },
    annTds:         { value: '' },
    annNotes:       { value: '' },
  };
  g.document = { getElementById: (id: string) => elements[id] };
}

// S.coffeeLibrary is typed for beans/grinders only (state/index.ts), while the
// annotation view reads baskets/puckScreens off the same object — bridge the
// test fixture to that wider runtime shape.
interface CatalogRow { id: number; name: string }

// The subset of the POST /annotate body these tests read back.
interface AnnotationPayload { basketId: number | null; puckScreenId: number | null }

beforeEach(() => {
  fetchSpy.mockClear();
  S.shots = [{ id: 1, timestamp: 1700000000, annotation: {} }];
  S.primaryShotId = 1;
  const catalog: { beans: CatalogRow[]; baskets: CatalogRow[]; puckScreens: CatalogRow[] } = {
    beans: [],
    baskets: [{ id: 5, name: 'IMS Precision' }],
    puckScreens: [{ id: 9, name: 'Slayer mesh' }],
  };
  S.coffeeLibrary = catalog as unknown as typeof S.coffeeLibrary;
});

describe('annotation save — basketId/puckScreenId roundtrip (#635, beanId pattern)', () => {
  it('reads the selected basket/puck screen option\'s data attributes into the saved payload', () => {
    fakeAnnotationDom(5, 9);
    scheduleAutoSave();
    flushAutoSave();
    expect(fetchSpy).toHaveBeenCalledWith('api/shots/1/annotate', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as AnnotationPayload;
    expect(body.basketId).toBe(5);
    expect(body.puckScreenId).toBe(9);
  });

  it('defaults both to null when nothing is selected, same as beanId', () => {
    fakeAnnotationDom(null, null);
    scheduleAutoSave();
    flushAutoSave();
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as AnnotationPayload;
    expect(body.basketId).toBeNull();
    expect(body.puckScreenId).toBeNull();
  });
});
