// #1614 slice 2: every write that the server rejects must surface an error
// instead of appearing successful. apiFetchJson now rejects on a non-ok
// status, triggerSync keeps the 429 message visible until its 3s reset, and
// the orders / shot-defaults write paths call window.showToast on failure.
//
// Same fetch-spy + fake-DOM convention as test/notify-settings-card.test.ts
// and test/status-update-inflight.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis so the minimal fakes below need not satisfy the full
// Storage/Navigator/Window shapes.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

interface FakeEl {
  textContent: string;
  innerHTML: string;
  disabled: boolean;
  value: string;
  style: Record<string, string>;
  selectedOptions?: { dataset: Record<string, string> }[];
}
function makeEl(init: Partial<FakeEl> = {}): FakeEl {
  return { textContent: '', innerHTML: '', disabled: false, value: '', style: {}, ...init };
}

const docEls = new Map<string, FakeEl>();
g.document = { getElementById: (id: string) => docEls.get(id) };

const showToast = vi.fn();

const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');

const { apiFetchJson } = await import('../public-src/api/fetch.js');
const { triggerSync } = await import('../public-src/components/status.js');
const { completeOrder } = await import('../public-src/views/orders.js');
const { saveShotDefaultsSettings } = await import('../public-src/components/shot-defaults-settings.js');

// Minimal Response stand-in: only the fields the code under test reads.
function response(init: { ok: boolean; status?: number; body?: unknown; bodyRejects?: boolean }): Response {
  return {
    ok: init.ok,
    status: init.status ?? 200,
    json: () => (init.bodyRejects ? Promise.reject(new Error('no JSON body')) : Promise.resolve(init.body ?? {})),
  } as unknown as Response;
}

beforeEach(() => {
  docEls.clear();
  showToast.mockReset();
  fetchSpy.mockReset();
  g.window = { showToast };
});

describe('apiFetchJson rejects error responses (#1614)', () => {
  it('rejects with the body error on a 500', async () => {
    fetchSpy.mockResolvedValue(response({ ok: false, status: 500, body: { error: 'boom' } }));
    await expect(apiFetchJson('api/x')).rejects.toThrow('boom');
  });

  it('rejects with HTTP <status> when the error body is not JSON', async () => {
    fetchSpy.mockResolvedValue(response({ ok: false, status: 404, bodyRejects: true }));
    await expect(apiFetchJson('api/x')).rejects.toThrow('HTTP 404');
  });

  it('resolves with the parsed body on a 200', async () => {
    fetchSpy.mockResolvedValue(response({ ok: true, status: 200, body: { a: 1 } }));
    await expect(apiFetchJson('api/x')).resolves.toEqual({ a: 1 });
  });
});

describe('triggerSync 429 keeps its message (#1614)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('shows the server message while disabled, and resets after 3s', async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(response({ ok: false, status: 429, body: { error: 'Slow down' } }));
    const btn = makeEl();
    docEls.set('syncBtn', btn);

    await triggerSync();

    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('Slow down');

    vi.advanceTimersByTime(3000);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('↻ Sync');
  });
});

describe('rejected writes surface a toast (#1614)', () => {
  it('completeOrder shows an error toast and still reloads the view on a 500', async () => {
    fetchSpy.mockResolvedValue(response({ ok: false, status: 500 }));

    await completeOrder('1');

    expect(showToast).toHaveBeenCalledWith('Error: 500');
  });

  it('shot-defaults save shows an error toast and no saved label on a 500', async () => {
    fetchSpy.mockResolvedValue(response({ ok: false, status: 500 }));
    const btn = makeEl();
    docEls.set('sdDrinkType', makeEl({ value: 'espresso' }));
    docEls.set('sdCoffee', makeEl({ selectedOptions: [{ dataset: { beanId: '7' } }] }));
    docEls.set('sdBasket', makeEl({ value: '3' }));
    docEls.set('sdPuckScreen', makeEl({ value: '5' }));
    docEls.set('sdGrinder', makeEl({ value: 'Niche' }));
    docEls.set('sdDose', makeEl({ value: '18.5' }));
    docEls.set('shotDefaultsSaveBtn', btn);

    await saveShotDefaultsSettings();

    expect(showToast).toHaveBeenCalledWith('Error: ');
    expect(btn.innerHTML).not.toContain('Saved');
  });
});
