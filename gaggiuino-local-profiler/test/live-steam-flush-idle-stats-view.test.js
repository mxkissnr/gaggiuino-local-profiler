// #902: views/live.js's handleLiveData()/setLiveBadge() coverage for the
// new steam/flush live-content branches and the always-current idle stats
// row -- resolveMachineIconState()'s own mode-resolution logic is already
// covered directly in test/machine-icon.test.js, so machine-icon.js is
// mocked out here to keep this file focused on the DOM wiring under test.
// Same minimal-fake-document pattern as
// test/live-stream-sse-fallback-gating.test.js/
// test/machine-reachable-offline-signal.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en-US' };

vi.mock('../public-src/machine-icon.js', () => ({
  machineIconAnimatedSvg: () => '',
  setMachineIconMode: () => {},
  updateMachineIconBrewReadout: () => {},
  resolveMachineIconState: () => ({ mode: 'hot', heatFraction: 1 }),
  MACHINE_ICON_LIVE_CLASS: 'machine-icon-live',
}));

const { S } = await import('../public-src/state.js');
const { handleLiveData, setLiveBadge } = await import('../public-src/views/live.js');

function makeFakeDocument() {
  const registry = new Map();
  function makeElement() {
    return {
      className: '', textContent: '', style: {}, firstChild: null,
      classList: { add() {}, remove() {}, contains: () => false },
      querySelector: () => null,
    };
  }
  return {
    getElementById: id => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id);
    },
  };
}

describe('setLiveBadge() steaming/flushing labels (#902)', () => {
  let doc;

  beforeEach(() => {
    doc = makeFakeDocument();
    globalThis.document = doc;
    S.currentLang = 'en';
  });

  it('sets the steaming badge class/label', () => {
    setLiveBadge('steaming');
    expect(doc.getElementById('live-status-badge').className).toBe('live-status-badge steaming');
    expect(doc.getElementById('live-status-text').textContent).toBe('Steaming …');
  });

  it('sets the flushing badge class/label', () => {
    setLiveBadge('flushing');
    expect(doc.getElementById('live-status-badge').className).toBe('live-status-badge flushing');
    expect(doc.getElementById('live-status-text').textContent).toBe('Flushing …');
  });
});

describe('handleLiveData() steam/flush live-content branches (#902)', () => {
  let doc;

  beforeEach(() => {
    doc = makeFakeDocument();
    globalThis.document = doc;
    S.currentLang = 'en';
    S.liveTimerTick = null;
    S.liveBrewStartWall = null;
  });

  it('shows the steaming badge/content with duration+pressure+temp from steamDatapoints, blank flow/weight', () => {
    handleLiveData({
      machineReachable: true, isLive: false, isSteaming: true, isFlushing: false,
      steamDatapoints: { timeInMode: [0, 50], pressure: [0, 12], temperature: [1400, 1450] },
      temperature: 91, targetTemperature: 93, pressure: 0.1, waterLevel: 70,
    });

    expect(doc.getElementById('live-status-badge').className).toBe('live-status-badge steaming');
    expect(doc.getElementById('live-meta').textContent).toBe('Steaming …');
    expect(doc.getElementById('live-content').style.display).toBe('block');
    expect(doc.getElementById('live-idle').style.display).toBe('none');
    expect(doc.getElementById('livePressure').textContent).toBe('1.2');
    expect(doc.getElementById('liveTemp').textContent).toBe('145.0');
    expect(doc.getElementById('liveFlow').textContent).toBe('–');
    expect(doc.getElementById('liveWeight').textContent).toBe('–');
  });

  it('shows the flushing badge/content from flushDatapoints', () => {
    handleLiveData({
      machineReachable: true, isLive: false, isSteaming: false, isFlushing: true,
      flushDatapoints: { timeInMode: [0], pressure: [5], temperature: [930] },
      temperature: 93, targetTemperature: 93, pressure: 0.5, waterLevel: 70,
    });

    expect(doc.getElementById('live-status-badge').className).toBe('live-status-badge flushing');
    expect(doc.getElementById('live-meta').textContent).toBe('Flushing …');
    expect(doc.getElementById('live-content').style.display).toBe('block');
    expect(doc.getElementById('livePressure').textContent).toBe('0.5');
    expect(doc.getElementById('liveTemp').textContent).toBe('93.0');
  });

  it('updates the idle stats row (temp/target/pressure/water) even while true idle (no mode running)', () => {
    handleLiveData({
      machineReachable: true, isLive: false, isSteaming: false, isFlushing: false,
      datapoints: null, temperature: 91.5, targetTemperature: 93, pressure: 0.1, waterLevel: 64,
    });

    expect(doc.getElementById('liveIdleTemp').textContent).toBe('91.5°');
    expect(doc.getElementById('liveIdleTargetTemp').textContent).toBe(' / 93°');
    expect(doc.getElementById('liveIdlePressure').textContent).toBe('0.1 bar');
    expect(doc.getElementById('liveIdleWaterLevel').textContent).toBe('64%');
  });

  it('idle stats show a dash for each field that is null (e.g. before any poll has run)', () => {
    handleLiveData({
      machineReachable: true, isLive: false, isSteaming: false, isFlushing: false,
      datapoints: null, temperature: null, targetTemperature: null, pressure: null, waterLevel: null,
    });

    expect(doc.getElementById('liveIdleTemp').textContent).toBe('–');
    expect(doc.getElementById('liveIdleTargetTemp').textContent).toBe('');
    expect(doc.getElementById('liveIdlePressure').textContent).toBe('–');
    expect(doc.getElementById('liveIdleWaterLevel').textContent).toBe('–');
  });
});
