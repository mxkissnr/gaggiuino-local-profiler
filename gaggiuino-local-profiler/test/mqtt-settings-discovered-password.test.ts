// #1431 slice 2: GET /api/mqtt/discovery no longer carries the Supervisor
// broker's password (only hasPassword), so the Settings form must never
// pre-fill it. This test pins the two remaining paths through the password
// field: leaving it blank against a discovered password posts
// useDiscoveredPassword (no password key), while typing one posts it as a
// normal password — same apiFetch-spy + fake-DOM pattern as
// test/mcp-settings-card.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= {};

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');

// One loose element fake covers every field the card reads/writes: value and
// placeholder for the inputs, style for the remove row, innerHTML for the
// save confirmation.
class FakeEl {
  value = '';
  placeholder = '';
  checked = false;
  style: Record<string, string> = {};
  innerHTML = '';
  textContent = '';
}

const IDS = [
  'mqttHost', 'mqttPort', 'mqttUsername', 'mqttPassword', 'mqttPrefix',
  'mqttPasswordRemove', 'mqttPasswordRemoveRow', 'mqttDiscoveryHint',
  'mqttSettingsCard', 'mqttConnFields', 'mqttSettingsResult',
];
let els: Record<string, FakeEl>;

g.document = {
  getElementById: (id: string) => els[id] ?? null,
  querySelectorAll: () => [],
};

const { loadMqttSettings, saveMqttSettings } = await import('../public-src/components/mqtt-settings.js');

// GET /api/mqtt/settings reports hasPassword (never the password itself);
// GET /api/mqtt/discovery offers a broker from Supervisor with that flag set.
function mockLoad() {
  fetchSpy
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ transport: 'mqtt', host: '', port: 0, username: '', prefix: 'gaggiuino' }),
    } as unknown as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ available: true, host: 'core-mosquitto', port: 1883, username: 'homeassistant', hasPassword: true }),
    } as unknown as Response)
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) } as unknown as Response);
}

beforeEach(() => {
  S.currentLang = 'en';
  S.machines = [];
  fetchSpy.mockReset();
  els = {};
  for (const id of IDS) els[id] = new FakeEl();
});

describe('MQTT settings password field (#1431)', () => {
  it('never pre-fills the discovered password and reuses it via useDiscoveredPassword', async () => {
    mockLoad();

    await loadMqttSettings();

    expect(els.mqttPassword!.value).toBe('');
    expect(els.mqttPassword!.placeholder).toBe('From Home Assistant — leave blank to use it');

    await saveMqttSettings();

    expect(fetchSpy).toHaveBeenNthCalledWith(3, 'api/mqtt/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transport: 'mqtt',
        host: 'core-mosquitto',
        port: 1883,
        username: 'homeassistant',
        prefix: 'gaggiuino',
        useDiscoveredPassword: true,
      }),
    });
    expect(JSON.parse(fetchSpy.mock.calls[2]?.[1]?.body as string)).not.toHaveProperty('password');
  });

  it('posts a typed password and no discovery flag', async () => {
    mockLoad();

    await loadMqttSettings();
    els.mqttPassword!.value = 'typed-secret';
    await saveMqttSettings();

    expect(fetchSpy).toHaveBeenNthCalledWith(3, 'api/mqtt/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transport: 'mqtt',
        host: 'core-mosquitto',
        port: 1883,
        username: 'homeassistant',
        prefix: 'gaggiuino',
        password: 'typed-secret',
      }),
    });
    expect(JSON.parse(fetchSpy.mock.calls[2]?.[1]?.body as string)).not.toHaveProperty('useDiscoveredPassword');
  });
});
