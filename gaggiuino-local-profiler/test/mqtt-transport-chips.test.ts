// #2093: the Live connection toggle renders on the shared .chip and its only
// active state is aria-pressed="true" -- no class toggle. Stubs the same
// browser globals test/mqtt-settings-discovered-password.test.ts does, so the
// component module can be imported without jsdom.
import { describe, it, expect, beforeEach } from 'vitest';

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {} };
g.navigator ??= { language: 'en-US' };
g.window ??= {};

interface FakeChip {
  dataset: { mqttTransport: string };
  attrs: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  classList: { toggle: () => never };
}

function fakeChip(mqttTransport: string): FakeChip {
  const attrs: Record<string, string> = {};
  return {
    dataset: { mqttTransport },
    attrs,
    setAttribute(name, value) { attrs[name] = value; },
    classList: {
      toggle: () => { throw new Error('classList.toggle must not be used'); },
    },
  };
}

let ws: FakeChip;
let mqtt: FakeChip;
let mqttSettingsCard: { style: Record<string, string> };
let mqttConnFields: { style: Record<string, string> };

g.document = {
  getElementById: (id: string) => (id === 'mqttSettingsCard' ? mqttSettingsCard
    : id === 'mqttConnFields' ? mqttConnFields
    : null),
  querySelectorAll: (sel: string) => (sel === '#mqttTransportToggle [data-mqtt-transport]' ? [ws, mqtt] : []),
};

const { S } = await import('../public-src/state/index.js');
const { setMqttTransport } = await import('../public-src/components/mqtt-settings.js');

beforeEach(() => {
  S.machines = [];
  ws = fakeChip('websocket');
  mqtt = fakeChip('mqtt');
  mqttSettingsCard = { style: {} };
  mqttConnFields = { style: {} };
});

describe('live connection transport chips (#2093)', () => {
  it('presses only the chosen transport and shows the broker fields for MQTT', () => {
    setMqttTransport('mqtt');
    expect(mqtt.attrs['aria-pressed']).toBe('true');
    expect(ws.attrs['aria-pressed']).toBe('false');
    expect(mqttConnFields.style.display).toBe('');

    setMqttTransport('websocket');
    expect(ws.attrs['aria-pressed']).toBe('true');
    expect(mqtt.attrs['aria-pressed']).toBe('false');
    expect(mqttConnFields.style.display).toBe('none');
  });
});
