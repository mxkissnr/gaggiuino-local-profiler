import { describe, it, expect, beforeEach, vi } from 'vitest';

// annotation.js imports state.js, which reads localStorage/navigator at
// module load time — same stubbing approach as milk-deduct-gate.test.js.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator    ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api.js');
// r.ok:false keeps _performAnnotationSave from reaching the post-save
// renderSidebar()/updateSidebarHighlighting() calls (heavier DOM deps not
// stubbed here) — the payload sent to apiFetch is captured regardless.
const fetchSpy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue({ ok: false });
const { scheduleAutoSave, flushAutoSave } = await import('../public-src/views/shots/annotation.js');

// #635: mirrors _renderBeanSelect's data-bean-id contract — a selected
// option carries data-basket-id/data-puckscreen-id only when it corresponds
// to a real library entry; the empty/unselected option carries neither.
function fakeAnnotationDom(basketId, puckScreenId) {
  const elements = {
    annCoffee:      { value: '', selectedOptions: [{ dataset: {} }] },
    annBasket:      { selectedOptions: [{ dataset: basketId != null ? { basketId: String(basketId) } : {} }] },
    annPuckScreen:  { selectedOptions: [{ dataset: puckScreenId != null ? { puckscreenId: String(puckScreenId) } : {} }] },
    annGrinder:     { value: '' },
    annGrindSetting:{ value: '' },
    annDose:        { value: '' },
    annTds:         { value: '' },
    annNotes:       { value: '' },
  };
  globalThis.document = { getElementById: id => elements[id] };
}

beforeEach(() => {
  fetchSpy.mockClear();
  S.shots = [{ id: 1, timestamp: 1700000000, annotation: {} }];
  S.primaryShotId = 1;
  S.coffeeLibrary = { beans: [], baskets: [{ id: 5, name: 'IMS Precision' }], puckScreens: [{ id: 9, name: 'Slayer mesh' }] };
});

describe('annotation save — basketId/puckScreenId roundtrip (#635, beanId pattern)', () => {
  it('reads the selected basket/puck screen option\'s data attributes into the saved payload', () => {
    fakeAnnotationDom(5, 9);
    scheduleAutoSave();
    flushAutoSave();
    expect(fetchSpy).toHaveBeenCalledWith('api/shots/1/annotate', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.basketId).toBe(5);
    expect(body.puckScreenId).toBe(9);
  });

  it('defaults both to null when nothing is selected, same as beanId', () => {
    fakeAnnotationDom(null, null);
    scheduleAutoSave();
    flushAutoSave();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.basketId).toBeNull();
    expect(body.puckScreenId).toBeNull();
  });
});
