// #1085: a multi-component firmware OTA (`update-all`) restarts its own
// 0-100% cycle per component (controller firmware C_FW, display firmware
// F_FW, display filesystem F_FS), so the machine's progress `type`
// discriminator has to reach the label or a normal stage boundary renders
// as an unexplained jump back to 0%. Minimal fake DOM, same pattern as
// test/machine-accent-theme.test.js, just enough for
// renderFirmwareProgressBar()'s row -> bar -> label/fill lookups.
import { describe, it, expect, beforeEach } from 'vitest';

const _localStorageStore = {};
globalThis.localStorage ??= {
  getItem: (k) => (k in _localStorageStore ? _localStorageStore[k] : null),
  setItem: (k, v) => { _localStorageStore[k] = String(v); },
};
globalThis.navigator ??= { language: 'en-US' };
globalThis.window ??= globalThis;
globalThis.document ??= { documentElement: { style: {} }, getElementById: () => null };

const { S } = await import('../public-src/state.js');
const { renderFirmwareProgressBar } = await import('../public-src/components/machines-settings.js');

import en from '../public-src/i18n/en.js';
import de from '../public-src/i18n/de.js';
import itLang from '../public-src/i18n/it.js';
import fr from '../public-src/i18n/fr.js';
import es from '../public-src/i18n/es.js';
import nl from '../public-src/i18n/nl.js';

const LANGS = { en, de, it: itLang, fr, es, nl };
const TYPES = ['C_FW', 'F_FW', 'F_FS'];

function makeRow() {
  const label = { textContent: '' };
  const fill = { style: {} };
  const bar = {
    style: {},
    querySelector: (sel) => ({
      '.machine-firmware-progress-label': label,
      '.sync-progress-fill': fill,
    }[sel] ?? null),
  };
  const row = {
    querySelector: (sel) => (sel === '.machine-firmware-progress-bar' ? bar : null),
  };
  return { row, bar, label, fill };
}

describe('renderFirmwareProgressBar() names the OTA stage (#1085)', () => {
  beforeEach(() => { S.currentLang = 'en'; });

  it('labels a controller-firmware step with the stage and percentage', () => {
    const { row, bar, label, fill } = makeRow();
    renderFirmwareProgressBar(row, { progress: 76, status: 'IN_PROGRESS', type: 'C_FW' });
    expect(label.textContent).toContain('controller firmware');
    expect(label.textContent).toContain('76%');
    expect(fill.style.width).toBe('76%');
    expect(bar.style.display).toBe('');
  });

  it('distinguishes the display-firmware and display-filesystem stages', () => {
    const a = makeRow();
    renderFirmwareProgressBar(a.row, { progress: 0, status: 'IN_PROGRESS', type: 'F_FW' });
    expect(a.label.textContent).toContain('display firmware');
    expect(a.label.textContent).toContain('0%');

    const b = makeRow();
    renderFirmwareProgressBar(b.row, { progress: 100, status: 'IN_PROGRESS', type: 'F_FS' });
    expect(b.label.textContent).toContain('display filesystem');
    expect(b.label.textContent).toContain('100%');
  });

  it('falls back to a generic firmware label for an unrecognized type without throwing', () => {
    const { row, label, fill } = makeRow();
    expect(() => renderFirmwareProgressBar(row, { progress: 50, status: 'IN_PROGRESS', type: 'ZZ' })).not.toThrow();
    expect(label.textContent).toContain('Updating firmware');
    expect(label.textContent).toContain('50%');
    expect(fill.style.width).toBe('50%');
  });

  it('keeps the pre-#1085 label when the machine reports no type', () => {
    const { row, label } = makeRow();
    renderFirmwareProgressBar(row, { progress: 42, status: 'IN_PROGRESS' });
    expect(label.textContent).toBe(en.settings_machine_firmware_progress_label(42));
  });

  it('still hides the bar and clamps the fill width as before', () => {
    const hidden = makeRow();
    renderFirmwareProgressBar(hidden.row, null);
    expect(hidden.bar.style.display).toBe('none');

    const over = makeRow();
    renderFirmwareProgressBar(over.row, { progress: 150, status: 'IN_PROGRESS', type: 'C_FW' });
    expect(over.fill.style.width).toBe('100%');
    expect(over.label.textContent).toContain('100%');

    const under = makeRow();
    renderFirmwareProgressBar(under.row, { progress: -5, status: 'IN_PROGRESS', type: 'C_FW' });
    expect(under.fill.style.width).toBe('0%');
    expect(under.label.textContent).toContain('0%');
  });
});

describe('settings_machine_firmware_progress_label_staged across all 6 languages (#1085)', () => {
  it('exists as a function in every language and interpolates the percentage', () => {
    for (const [name, dict] of Object.entries(LANGS)) {
      expect(typeof dict.settings_machine_firmware_progress_label_staged, `${name}.js key`).toBe('function');
      expect(dict.settings_machine_firmware_progress_label_staged('C_FW', 76)).toContain('76%');
    }
  });

  it('names all three stages distinctly, with a generic fallback for anything else', () => {
    for (const [name, dict] of Object.entries(LANGS)) {
      const rendered = TYPES.map((type) => dict.settings_machine_firmware_progress_label_staged(type, 0));
      expect(new Set(rendered).size, `${name}.js stage labels`).toBe(TYPES.length);
      expect(() => dict.settings_machine_firmware_progress_label_staged('ZZ', 0)).not.toThrow();
      expect(() => dict.settings_machine_firmware_progress_label_staged(undefined, 0)).not.toThrow();
    }
  });
});
