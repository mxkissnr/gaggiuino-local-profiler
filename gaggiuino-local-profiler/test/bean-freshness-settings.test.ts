// #1835 part B: the Settings → "Bean freshness" card. Saves go through
// setUiPref(), the same store utils.ts's freshnessWindows() and the Go
// low-stock check read, so the assertions look at the localStorage cache the
// store writes synchronously — no network involved (the PUT is debounced).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};
g.navigator ??= { language: 'en-US' };
g.window ??= {};

// setUiPref() debounces its PUT; a stub that always answers ok keeps that
// background flush from rejecting.
globalThis.fetch = () =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);

interface FakeInput { value: string }

function makeFakeDocument() {
  const els = new Map<string, FakeInput & { textContent: string; innerHTML: string; style: Record<string, string> }>();
  const make = () => ({ value: '', textContent: '', innerHTML: '', style: {} as Record<string, string> });
  return {
    getElementById(id: string) {
      if (!els.has(id)) els.set(id, make());
      return els.get(id)!;
    },
  };
}

// ui-prefs.ts seeds its in-memory copy from localStorage at module load, so
// the store has to be seeded BEFORE the module graph is imported. Each test
// gets a fresh module instance through vi.resetModules().
type CardModule = typeof import('../public-src/components/bean-freshness-settings.js');
async function loadCard(): Promise<CardModule> {
  vi.resetModules();
  return await import('../public-src/components/bean-freshness-settings.js');
}

const IDS = ['bfDegasUntil', 'bfPeakFrom', 'bfPeakUntil', 'bfFadingUntil', 'bfLowStock'] as const;

function cachedPrefs(): Record<string, unknown> {
  return JSON.parse(store.get('glp_ui_prefs') ?? '{}') as Record<string, unknown>;
}

function shownValues(doc: ReturnType<typeof makeFakeDocument>): string[] {
  return IDS.map(id => doc.getElementById(id).value);
}

beforeEach(() => {
  store.clear();
  // state/index.ts resolves S.currentLang from here at module load; pin it so
  // the error-message assertion below does not depend on the host locale.
  store.set('glp_lang', 'en');
  g.document = makeFakeDocument();
  // Saving flips the button to "Saved" and schedules the flip back; keeping
  // that timer fake stops it firing after the suite has torn its DOM down.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  // Drops the pending button/queue timers instead of running them: the store's
  // debounced PUT has nothing to assert here and would only race the teardown.
  vi.useRealTimers();
});

describe('bean freshness settings card (#1835)', () => {
  it('pre-fills the fields from the stored windows and threshold', async () => {
    store.set('glp_ui_prefs', JSON.stringify({
      bean_freshness: { degasUntil: 2, peakFrom: 5, peakUntil: 14, fadingUntil: 28 },
      bean_low_stock_g: 250,
    }));
    const card = await loadCard();
    card.renderBeanFreshnessSettings();
    const doc = g.document as ReturnType<typeof makeFakeDocument>;
    expect(shownValues(doc)).toEqual(['2', '5', '14', '28', '250']);
    expect(card.currentBeanFreshness()).toEqual({ degasUntil: 2, peakFrom: 5, peakUntil: 14, fadingUntil: 28, lowStockG: 250 });
  });

  it('falls back to the defaults when nothing is stored', async () => {
    const card = await loadCard();
    card.renderBeanFreshnessSettings();
    const doc = g.document as ReturnType<typeof makeFakeDocument>;
    expect(shownValues(doc)).toEqual(['4', '7', '21', '35', '100']);
    expect(card.currentBeanFreshness()).toEqual(card.defaultBeanFreshness());
  });

  it('saves a valid set into the shared ui-prefs store', async () => {
    const card = await loadCard();
    const doc = g.document as ReturnType<typeof makeFakeDocument>;
    doc.getElementById('bfDegasUntil').value = '3';
    doc.getElementById('bfPeakFrom').value = '6';
    doc.getElementById('bfPeakUntil').value = '18';
    doc.getElementById('bfFadingUntil').value = '30';
    doc.getElementById('bfLowStock').value = '120';
    card.saveBeanFreshnessSettings();

    const prefs = cachedPrefs();
    expect(prefs.bean_freshness).toEqual({ degasUntil: 3, peakFrom: 6, peakUntil: 18, fadingUntil: 30 });
    expect(prefs.bean_low_stock_g).toBe(120);
    expect(doc.getElementById('bfError').style.display).toBe('none');
  });

  it('rejects a non-ascending set without touching the stored values', async () => {
    const card = await loadCard();
    const doc = g.document as ReturnType<typeof makeFakeDocument>;
    doc.getElementById('bfDegasUntil').value = '10';
    doc.getElementById('bfPeakFrom').value = '7';
    doc.getElementById('bfPeakUntil').value = '21';
    doc.getElementById('bfFadingUntil').value = '35';
    doc.getElementById('bfLowStock').value = '100';
    card.saveBeanFreshnessSettings();

    expect(cachedPrefs().bean_freshness).toBeUndefined();
    expect(doc.getElementById('bfError').style.display).toBe('');
    expect(doc.getElementById('bfError').textContent).toContain('ascend');
  });

  it('rejects fractions, zero, an empty field and an out-of-range threshold', async () => {
    const { parseBeanFreshnessForm } = await loadCard();
    const base = { degasUntil: '4', peakFrom: '7', peakUntil: '21', fadingUntil: '35', lowStockG: '100' };
    expect(parseBeanFreshnessForm(base).values).not.toBeNull();

    const bad = (over: Partial<typeof base>) => parseBeanFreshnessForm({ ...base, ...over });
    expect(bad({ degasUntil: '4.5' }).fieldErrors.degasUntil).toBe('bf_err_days');
    expect(bad({ peakFrom: '0' }).fieldErrors.peakFrom).toBe('bf_err_days');
    expect(bad({ peakUntil: '' }).fieldErrors.peakUntil).toBe('bf_err_days');
    expect(bad({ fadingUntil: '366' }).fieldErrors.fadingUntil).toBe('bf_err_days');
    expect(bad({ lowStockG: '0' }).fieldErrors.lowStockG).toBe('bf_err_grams');
    expect(bad({ lowStockG: '5001' }).fieldErrors.lowStockG).toBe('bf_err_grams');
    expect(bad({ lowStockG: '2.5' }).fieldErrors.lowStockG).toBe('bf_err_grams');
    // Equal bounds leave no room for the "almost" band, so freshnessWindows()
    // would discard the whole set — reject it here instead of losing it silently.
    expect(bad({ peakFrom: '4' }).orderError).toBe(true);
  });

  it('resets to the built-in windows and threshold', async () => {
    store.set('glp_ui_prefs', JSON.stringify({
      bean_freshness: { degasUntil: 2, peakFrom: 5, peakUntil: 14, fadingUntil: 28 },
      bean_low_stock_g: 250,
    }));
    const card = await loadCard();
    card.resetBeanFreshnessSettings();

    const doc = g.document as ReturnType<typeof makeFakeDocument>;
    expect(shownValues(doc)).toEqual(['4', '7', '21', '35', '100']);
    expect(cachedPrefs().bean_freshness).toEqual({ degasUntil: 4, peakFrom: 7, peakUntil: 21, fadingUntil: 35 });
    expect(cachedPrefs().bean_low_stock_g).toBe(100);
  });

  it('saving a new set changes what freshnessState() reports', async () => {
    const card = await loadCard();
    const doc = g.document as ReturnType<typeof makeFakeDocument>;
    doc.getElementById('bfDegasUntil').value = '2';
    doc.getElementById('bfPeakFrom').value = '5';
    doc.getElementById('bfPeakUntil').value = '14';
    doc.getElementById('bfFadingUntil').value = '28';
    doc.getElementById('bfLowStock').value = '100';
    card.saveBeanFreshnessSettings();

    const utils = await import('../public-src/utils.js');
    expect(utils.freshnessState(3)).toBe('almost');
    expect(utils.freshnessState(20)).toBe('fading');
  });

  it('does nothing when the card is not in the page', async () => {
    g.document = { getElementById: () => undefined };
    const card = await loadCard();
    expect(() => card.renderBeanFreshnessSettings()).not.toThrow();
  });
});
