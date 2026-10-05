import { describe, it, expect } from 'vitest';
import { buildRecordedGmPhaseRanges, exitReasonKey } from '../public-src/constants.js';
import type { GmPhaseRange, RecordedPhaseTransition } from '../public-src/constants.js';
import de from '../public-src/i18n/de.js';
import en from '../public-src/i18n/en.js';
import es from '../public-src/i18n/es.js';
import fr from '../public-src/i18n/fr.js';
import it from '../public-src/i18n/it.js';
import nl from '../public-src/i18n/nl.js';

const TRANSITIONS: RecordedPhaseTransition[] = [
    { t: 0, phase: 0, name: 'Preinfusion', reason: 0 },
    { t: 85, phase: 1, name: 'Extraction', reason: 5 },
];

const PROFILE_RANGES: GmPhaseRange[] = [
    { name: 'a', phaseType: 'preinfusion', t0: 0, t1: 5 },
    { name: 'b', phaseType: 'brew', t0: 5, t1: 30 },
];

describe('buildRecordedGmPhaseRanges', () => {
    it('maps recorded transitions to second-based ranges', () => {
        expect(buildRecordedGmPhaseRanges(TRANSITIONS, 30.2)).toEqual([
            { name: 'Preinfusion', phaseType: 'brew', t0: 0, t1: 8.5 },
            { name: 'Extraction', phaseType: 'brew', t0: 8.5, t1: 30.2 },
        ]);
    });

    it('takes each phase type from the profile ranges by index', () => {
        const ranges = buildRecordedGmPhaseRanges(TRANSITIONS, 30.2, PROFILE_RANGES);
        expect(ranges[0]?.phaseType).toBe('preinfusion');
        expect(ranges[1]?.phaseType).toBe('brew');
    });

    it('returns [] for null, undefined and empty input', () => {
        expect(buildRecordedGmPhaseRanges(null, 30)).toEqual([]);
        expect(buildRecordedGmPhaseRanges(undefined, 30)).toEqual([]);
        expect(buildRecordedGmPhaseRanges([], 30)).toEqual([]);
    });

    it('falls back to "Phase N" when a transition has no name', () => {
        const ranges = buildRecordedGmPhaseRanges([{ t: 0, phase: 1 }], 10);
        expect(ranges[0]?.name).toBe('Phase 2');
    });

    it('clamps the last range to its own start when it begins after endSec', () => {
        const ranges = buildRecordedGmPhaseRanges([{ t: 100, phase: 0, name: 'Late' }], 5);
        expect(ranges[0]?.t1).toBe(ranges[0]?.t0);
    });
});

describe('exitReasonKey', () => {
    it('maps integer codes 1..7 to exit_reason_ keys', () => {
        expect(exitReasonKey(1)).toBe('exit_reason_1');
        expect(exitReasonKey(7)).toBe('exit_reason_7');
    });

    it('returns null outside 1..7 and for non-integers', () => {
        for (const bad of [0, 8, null, undefined, 2.5, '3']) {
            expect(exitReasonKey(bad)).toBeNull();
        }
    });
});

describe('recorded-phase i18n keys', () => {
    const LANGS = { de, en, es, fr, it, nl };
    const WARN_KEYS = [
        'machine_warn_water', 'machine_warn_flush', 'machine_warn_switch',
        'machine_warn_scaleConnected', 'machine_warn_scaleBattery', 'machine_warn_temperature',
        'machine_update_available',
    ];

    it('every language defines the exit-reason and machine-warning keys', () => {
        for (const [name, dict] of Object.entries(LANGS)) {
            for (let code = 1; code <= 7; code++) {
                const key = `exit_reason_${code}`;
                expect(typeof dict[key], `${name}.js ${key}`).toBe('string');
                expect((dict[key] as string).length, `${name}.js ${key}`).toBeGreaterThan(0);
            }
            for (const key of WARN_KEYS) {
                expect(typeof dict[key], `${name}.js ${key}`).toBe('string');
                expect((dict[key] as string).length, `${name}.js ${key}`).toBeGreaterThan(0);
            }
        }
    });

    it('shot_end_reason interpolates the reason in every language', () => {
        for (const [name, dict] of Object.entries(LANGS)) {
            expect(typeof dict.shot_end_reason, `${name}.js shot_end_reason`).toBe('function');
            const rendered = (dict.shot_end_reason as (r: string) => string)('X');
            expect(rendered, `${name}.js shot_end_reason('X')`).toContain('X');
        }
    });
});
