// #614: notify_preheat_ready/notify_low_stock moved from the Orders admin
// panel (only rendered when enable_orders: true) to an always-visible
// "Notifications" Settings card. This tests that the card reads/writes the
// same /api/orders/settings blob independently of views/orders.js — same
// apiFetch-spy pattern as test/milk-deduct-gate.test.js, same fake-DOM
// pattern as test/machines-settings-theme-form.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state.js');
const apiModule = await import('../public-src/api.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');

// Minimal fake checkbox + container, just enough for querySelector(All)
// on [data-notify-key="..."]/[data-notify-key] to work.
class FakeCheckbox {
  constructor(key) { this.dataset = { notifyKey: key }; this.checked = false; }
}
class FakeList {
  constructor(keys) { this._boxes = keys.map(k => new FakeCheckbox(k)); }
  querySelector(sel) {
    const key = /data-notify-key="([^"]+)"/.exec(sel)?.[1];
    return this._boxes.find(b => b.dataset.notifyKey === key);
  }
  querySelectorAll() { return this._boxes; }
}
class FakeButton {
  constructor() { this.textContent = ''; }
}

let list, btn;
globalThis.document = {
  getElementById: id => {
    if (id === 'notifySettingsList') return list;
    if (id === 'notifySettingsSaveBtn') return btn;
    return undefined;
  },
};

const { loadNotifySettingsCard, saveNotifySettings } = await import('../public-src/components/notify-settings.js');

beforeEach(() => {
  S.currentLang = 'en';
  fetchSpy.mockReset();
  list = new FakeList(['notify_preheat_ready', 'notify_low_stock']);
  btn = new FakeButton();
});

describe('loadNotifySettingsCard', () => {
  it('checks both boxes when the settings blob has no explicit false (undefined == on, #603 convention)', async () => {
    fetchSpy.mockResolvedValue({ json: async () => ({ enabled: true }) });
    await loadNotifySettingsCard();
    expect(list.querySelector('[data-notify-key="notify_preheat_ready"]').checked).toBe(true);
    expect(list.querySelector('[data-notify-key="notify_low_stock"]').checked).toBe(true);
  });

  it('unchecks a box whose key is explicitly false in the settings blob', async () => {
    fetchSpy.mockResolvedValue({ json: async () => ({ enabled: true, notify_low_stock: false }) });
    await loadNotifySettingsCard();
    expect(list.querySelector('[data-notify-key="notify_preheat_ready"]').checked).toBe(true);
    expect(list.querySelector('[data-notify-key="notify_low_stock"]').checked).toBe(false);
  });

  it('is a no-op when the card is not in the DOM (e.g. view not yet rendered) — does not throw', async () => {
    list = undefined;
    await expect(loadNotifySettingsCard()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('saveNotifySettings', () => {
  it('POSTs both toggle keys plus the existing enabled flag to /api/orders/settings', async () => {
    list.querySelector('[data-notify-key="notify_preheat_ready"]').checked = true;
    list.querySelector('[data-notify-key="notify_low_stock"]').checked = false;
    fetchSpy
      .mockResolvedValueOnce({ json: async () => ({ enabled: true, broadcastRecipients: ['x'] }) }) // GET before save
      .mockResolvedValueOnce({ json: async () => ({}) }); // POST response

    await saveNotifySettings();

    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'api/orders/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, notify_preheat_ready: true, notify_low_stock: false }),
    });
  });

  it('does not clobber unrelated settings keys — only sends enabled + the two toggle keys', async () => {
    fetchSpy
      .mockResolvedValueOnce({ json: async () => ({ enabled: false, baristaNotifyService: 'notify.x' }) })
      .mockResolvedValueOnce({ json: async () => ({}) });

    await saveNotifySettings();

    const postBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(postBody).toEqual({ enabled: false, notify_preheat_ready: false, notify_low_stock: false });
  });

  it('shows the saved confirmation text on the button after a successful save', async () => {
    fetchSpy.mockResolvedValue({ json: async () => ({ enabled: true }) });
    await saveNotifySettings();
    expect(btn.textContent).toBe('✓ Saved');
  });
});
