// #1288 (part of #1196): the MCP settings card turns the built-in MCP server
// on from the app's Settings page. This tests that load fills the three
// toggles from GET /api/mcp/settings, that the developer-tools row is only
// shown when the build offers it, and that save POSTs exactly the three
// required booleans — same apiFetch-spy + fake-DOM pattern as
// test/notify-settings-card.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= {};

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');

// Minimal fake checkbox + row + container, just enough for
// querySelector('[data-mcp-key="..."]') and the style.display toggle.
class FakeCheckbox {
  dataset: { mcpKey: string };
  checked = false;
  disabled = false;
  constructor(key: string) {
    this.dataset = { mcpKey: key };
  }
}
class FakeRow {
  style: Record<string, string> = { display: 'none' };
}
class FakeList {
  _boxes: FakeCheckbox[];
  constructor(keys: string[]) {
    this._boxes = keys.map((k) => new FakeCheckbox(k));
  }
  querySelector(sel: string): FakeCheckbox | undefined {
    const key = /data-mcp-key="([^"]+)"/.exec(sel)?.[1];
    return this._boxes.find((b) => b.dataset.mcpKey === key);
  }
}
class FakeButton {
  textContent = '';
  innerHTML = '';
}

let list: FakeList | undefined;
let devRow: FakeRow;
let btn: FakeButton;
g.document = {
  getElementById: (id: string) => {
    if (id === 'mcpSettingsList') return list;
    if (id === 'mcpDevRow') return devRow;
    if (id === 'mcpSettingsSaveBtn') return btn;
    return undefined;
  },
};

const { loadMcpSettingsCard, saveMcpSettings } = await import('../public-src/components/mcp-settings.js');

const KEYS = ['enabled', 'allowWrite', 'allowDeveloperTools'];
const box = (key: string): FakeCheckbox => list!.querySelector(`[data-mcp-key="${key}"]`)!;

beforeEach(() => {
  S.currentLang = 'en';
  fetchSpy.mockReset();
  list = new FakeList(KEYS);
  devRow = new FakeRow();
  btn = new FakeButton();
});

describe('loadMcpSettingsCard', () => {
  it('fills the toggles and keeps the developer row hidden when the build does not offer it', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ enabled: true, allowWrite: true, allowDeveloperTools: false, developerToolsAvailable: false }),
    } as unknown as Response);

    await loadMcpSettingsCard();

    expect(box('enabled').checked).toBe(true);
    expect(box('allowWrite').checked).toBe(true);
    expect(box('allowDeveloperTools').checked).toBe(false);
    expect(devRow.style.display).toBe('none');
  });

  it('shows and fills the developer row on a dev build that offers it', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ enabled: true, allowWrite: false, allowDeveloperTools: true, developerToolsAvailable: true }),
    } as unknown as Response);

    await loadMcpSettingsCard();

    expect(devRow.style.display).toBe('');
    expect(box('allowDeveloperTools').checked).toBe(true);
  });

  it('is a no-op when the card is not in the DOM — does not throw or fetch', async () => {
    list = undefined;
    await expect(loadMcpSettingsCard()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('saveMcpSettings', () => {
  it('POSTs exactly the three required toggles to /api/mcp/settings', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ enabled: false, allowWrite: false, allowDeveloperTools: false, developerToolsAvailable: true }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);

    await loadMcpSettingsCard();
    box('enabled').checked = true;
    box('allowWrite').checked = true;
    box('allowDeveloperTools').checked = true;

    await saveMcpSettings();

    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'api/mcp/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, allowWrite: true, allowDeveloperTools: true }),
    });
  });

  it('sends allowDeveloperTools: false when the developer row is hidden', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ enabled: true, allowWrite: false, allowDeveloperTools: false, developerToolsAvailable: false }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);

    await loadMcpSettingsCard();
    // even a stale checked value must not leak out while the row is hidden
    box('allowDeveloperTools').checked = true;

    await saveMcpSettings();

    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'api/mcp/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, allowWrite: false, allowDeveloperTools: false }),
    });
  });

  it('shows the saved confirmation as a drawn icon plus text (#811)', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ enabled: true, allowWrite: false, allowDeveloperTools: false, developerToolsAvailable: false }),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);

    await loadMcpSettingsCard();
    await saveMcpSettings();

    expect(btn.innerHTML).toContain('Saved');
    expect(btn.innerHTML).toContain('<svg');
    expect(btn.innerHTML).not.toContain('\u2713');
  });
});
