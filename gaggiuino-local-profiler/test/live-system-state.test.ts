// #2139: a GaggiMate display that is reachable but not ready (firmware v1.9.0+
// sys.s) shows its own state as the Live tab's idle title and status badge,
// after unreachable and standby and ahead of the preheat states.
import { describe, it, expect, beforeEach } from 'vitest';

// vitest's node environment has no browser globals; stub them through a loose
// view of globalThis (the same bridge the sibling live tests use).
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S } = await import('../public-src/state/index.js');
const { updatePreheatWidget, handleLiveData, machineSystemStateLabel } = await import('../public-src/views/live.js');

const state = S as unknown as Record<string, unknown>;

function makeElement() {
  const cls = new Set<string>();
  return {
    className: '', textContent: '', style: {} as Record<string, string>,
    firstChild: null as unknown,
    classList: {
      add: (...c: string[]) => c.forEach(x => cls.add(x)),
      remove: (...c: string[]) => c.forEach(x => cls.delete(x)),
      contains: (c: string) => cls.has(c),
    },
    querySelector: () => null,
    set innerHTML(_v: string) { this.firstChild = {}; },
  };
}

type FakeElement = ReturnType<typeof makeElement>;

function makeFakeDocument() {
  const registry = new Map<string, FakeElement>();
  return {
    getElementById: (id: string): FakeElement => {
      if (!registry.has(id)) registry.set(id, makeElement());
      return registry.get(id)!;
    },
  };
}

const READY_PREHEAT = { standby: false, ready: true, remaining: 0, pct: 1 };

// [system state, error code, English title and badge text, badge variant]
const CASES: [string, number, string, string][] = [
  ['starting', 0, 'Starting …', 'badge--warn'],
  ['waiting', 0, 'Waiting for controller', 'badge--warn'],
  ['updating', 0, 'Updating firmware', 'badge--warn'],
  ['autotuning', 0, 'Autotune running', 'badge--warn'],
  ['mismatch', 0, 'Firmware mismatch', 'badge--warn'],
  ['error', 3, 'Controller error 3', 'badge--err'],
];

describe('Live view GaggiMate system state (#2139)', () => {
  let doc: ReturnType<typeof makeFakeDocument>;
  let title: FakeElement;
  let badge: FakeElement;
  let badgeText: FakeElement;
  let readyBadge: FakeElement;
  let wrap: FakeElement;

  beforeEach(() => {
    doc = makeFakeDocument();
    g.document = doc;
    state.currentLang = 'en';
    state.machines = [{ id: 1, isDefault: true }];
    state.activeMachineId = 1;
    title = doc.getElementById('liveIdleTitle');
    badge = doc.getElementById('live-status-badge');
    badgeText = doc.getElementById('live-status-text');
    readyBadge = doc.getElementById('preheat-ready-badge');
    wrap = doc.getElementById('preheat-warming-wrap');
    // The view keeps the last preheat payload and live message between calls,
    // so every case starts from a ready, reachable machine.
    updatePreheatWidget(READY_PREHEAT);
    handleLiveData({ machineReachable: true });
  });

  it.each(CASES)('%s shows its own title and badge', (systemState, code, label, variant) => {
    handleLiveData({ machineReachable: true, machineSystemState: systemState, machineSystemErrorCode: code });

    expect(title.textContent).toBe(label);
    expect(badgeText.textContent).toBe(label);
    expect(badge.className).toContain(variant);
    expect(readyBadge.style.display).toBe('none');
  });

  it('a controller error without a code shows no number', () => {
    handleLiveData({ machineReachable: true, machineSystemState: 'error', machineSystemErrorCode: 0 });

    expect(title.textContent).toBe('Controller error');
    expect(badgeText.textContent).toBe('Controller error');
    expect(badge.className).toContain('badge--err');
  });

  it('an empty system state keeps "Machine ready" and the ready badge', () => {
    handleLiveData({ machineReachable: true, machineSystemState: '', machineSystemErrorCode: 0 });

    expect(title.textContent).toBe('Machine ready');
    expect(badgeText.textContent).toBe('Ready');
    expect(badge.className).toContain('badge--ok');
    expect(readyBadge.style.display).toBe('');
  });

  it('a payload without the field keeps "Machine ready"', () => {
    handleLiveData({ machineReachable: true });

    expect(title.textContent).toBe('Machine ready');
    expect(badgeText.textContent).toBe('Ready');
  });

  it('an unreachable machine still shows unreachable first', () => {
    handleLiveData({ machineReachable: false, machineSystemState: 'waiting' });

    expect(title.textContent).toBe('Machine unreachable');
    expect(badgeText.textContent).toBe('Unreachable');
  });

  it('a GaggiMate in standby still shows standby first', () => {
    updatePreheatWidget({ standby: true, ready: false, remaining: 0 });
    handleLiveData({ machineReachable: true, machineSystemState: 'waiting' });

    expect(title.textContent).toBe('Standby');
    expect(badgeText.textContent).toBe('Standby');
  });

  it('hides the warm-up countdown while not ready and brings it back once ready', () => {
    updatePreheatWidget({ standby: false, ready: false, remaining: 600, pct: 0.1 });
    expect(wrap.style.display).toBe('');

    handleLiveData({ machineReachable: true, machineSystemState: 'waiting' });
    expect(title.textContent).toBe('Waiting for controller');
    expect(wrap.style.display).toBe('none');

    handleLiveData({ machineReachable: true, machineSystemState: '' });
    expect(title.textContent).toBe('Warming up …');
    expect(badgeText.textContent).toBe('Warming up …');
    expect(wrap.style.display).toBe('');
  });

  it('a preheat update while the display is not ready keeps its state on the badge', () => {
    handleLiveData({ machineReachable: true, machineSystemState: 'updating' });
    updatePreheatWidget(READY_PREHEAT);

    expect(readyBadge.style.display).toBe('none');
    expect(badgeText.textContent).toBe('Updating firmware');
  });

  it('labels every state in all six languages', () => {
    // starting, waiting, updating, autotuning, mismatch, error, error with code 3
    const LABELS: Record<string, string[]> = {
      en: ['Starting …', 'Waiting for controller', 'Updating firmware', 'Autotune running', 'Firmware mismatch', 'Controller error', 'Controller error 3'],
      de: ['Startet …', 'Warte auf Controller', 'Firmware-Update läuft', 'Autotune läuft', 'Firmware passt nicht zusammen', 'Controller-Fehler', 'Controller-Fehler 3'],
      es: ['Iniciando …', 'Esperando al controlador', 'Actualizando firmware', 'Autoajuste en curso', 'Firmware incompatible', 'Error del controlador', 'Error del controlador 3'],
      fr: ['Démarrage …', 'En attente du contrôleur', 'Mise à jour en cours', 'Autoréglage en cours', 'Firmwares incompatibles', 'Erreur du contrôleur', 'Erreur du contrôleur 3'],
      it: ['Avvio …', 'In attesa del controller', 'Aggiornamento in corso', 'Autotune in corso', 'Firmware non compatibili', 'Errore del controller', 'Errore del controller 3'],
      nl: ['Opstarten …', 'Wachten op controller', 'Firmware-update bezig', 'Autotune bezig', 'Firmware komt niet overeen', 'Controllerfout', 'Controllerfout 3'],
    };
    const states = ['starting', 'waiting', 'updating', 'autotuning', 'mismatch', 'error'];
    for (const [lang, labels] of Object.entries(LABELS)) {
      state.currentLang = lang;
      const got = [...states.map(s => machineSystemStateLabel(s)), machineSystemStateLabel('error', 3)];
      expect(got, lang).toEqual(labels);
    }
  });

  it('an unknown state falls back to the raw word instead of a missing key', () => {
    expect(machineSystemStateLabel('calibrating')).toBe('calibrating');
  });
});
