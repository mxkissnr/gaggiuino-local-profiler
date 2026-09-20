// #1085: a Gaggiuino firmware update flashes several components one after
// another (controller firmware, then the frontend image/filesystem), each
// restarting its own 0-100% cycle. The progress bar only read
// progress.progress, so a component boundary rendered as the bar silently
// resetting to 0% -- indistinguishable from a crash. renderFirmwareProgressBar()
// now names the component the firmware reports in progress.type via
// firmwareProgressLabel(); the codes (C_FW | F_FW | F_FS) are the firmware's
// own REST API doc's field notes for GET /api/firmware/progress.
import { describe, it, expect } from 'vitest';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.window ??= globalThis;

// machines-settings.js reaches for the DOM at import time (element lookups in
// its module-level wiring); the same minimal fake the other machines-settings
// tests use is enough here, since only the pure label helper is exercised.
globalThis.document = { getElementById: () => undefined, querySelectorAll: () => [] };

const { S } = await import('../public-src/state/index.js');
const { firmwareProgressLabel } = await import('../public-src/components/machines-settings.js');
const en = (await import('../public-src/i18n/en.js')).default;
const de = (await import('../public-src/i18n/de.js')).default;
const es = (await import('../public-src/i18n/es.js')).default;
const itLang = (await import('../public-src/i18n/it.js')).default;
const fr = (await import('../public-src/i18n/fr.js')).default;
const nl = (await import('../public-src/i18n/nl.js')).default;

const LANGS = { en, de, es, it: itLang, fr, nl };
const STAGE_KEYS = [
  'settings_machine_firmware_stage_c_fw',
  'settings_machine_firmware_stage_f_fw',
  'settings_machine_firmware_stage_f_fs',
];

describe('firmwareProgressLabel (#1085)', () => {
  S.currentLang = 'en';

  it('names the component the firmware reports instead of a bare percentage', () => {
    expect(firmwareProgressLabel({ progress: 0, status: 'IN_PROGRESS', type: 'C_FW' }, 0))
      .toBe('Controller firmware… 0%');
    expect(firmwareProgressLabel({ progress: 76, status: 'IN_PROGRESS', type: 'F_FW' }, 76))
      .toBe('Frontend firmware… 76%');
    expect(firmwareProgressLabel({ progress: 12, status: 'IN_PROGRESS', type: 'F_FS' }, 12))
      .toBe('Frontend filesystem… 12%');
  });

  it('resolves the type case-insensitively', () => {
    expect(firmwareProgressLabel({ type: 'c_fw' }, 5)).toBe('Controller firmware… 5%');
  });

  it('falls back to the generic label for a type this build does not know or the firmware omits', () => {
    expect(firmwareProgressLabel({ type: 'SOME_FUTURE_CODE' }, 40)).toBe('Updating firmware… 40%');
    expect(firmwareProgressLabel({}, 40)).toBe('Updating firmware… 40%');
    expect(firmwareProgressLabel({ type: null }, 40)).toBe('Updating firmware… 40%');
  });

  it('every language names all three documented stages', () => {
    for (const [name, dict] of Object.entries(LANGS)) {
      for (const key of STAGE_KEYS) {
        expect(dict[key], `${name}.js missing ${key}`).toBeTruthy();
      }
    }
  });

  it('every language interpolates both the stage name and the percentage', () => {
    for (const [name, dict] of Object.entries(LANGS)) {
      const stage = dict.settings_machine_firmware_stage_c_fw;
      const rendered = dict.settings_machine_firmware_progress_stage_label(stage, 76);
      expect(rendered, `${name}.js stage label`).toContain(stage);
      expect(rendered, `${name}.js stage label`).toContain('76');
    }
  });

  it('the stage label reads differently from the generic one in every language', () => {
    for (const [name, dict] of Object.entries(LANGS)) {
      const staged = dict.settings_machine_firmware_progress_stage_label(
        dict.settings_machine_firmware_stage_f_fw, 5);
      expect(staged, `${name}.js stage label`).not.toBe(dict.settings_machine_firmware_progress_label(5));
    }
  });
});
