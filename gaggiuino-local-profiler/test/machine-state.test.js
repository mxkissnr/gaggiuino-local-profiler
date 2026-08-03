import { describe, it, expect } from 'vitest';
import { deriveMachineState, isStillWarm } from '../lib/machine-state.js';

describe('deriveMachineState (#552)', () => {
    it('parses a normal idle status payload', () => {
        const now = 1_700_000_000_000;
        const r = deriveMachineState({
            brewSwitchState: false, pressure: '0.1', temperature: '92.3',
            targetTemperature: '93', weight: '0', waterLevel: '80', upTime: '1234',
            profileId: '2', profileName: 'V60', steamSwitchState: false,
        }, now);
        expect(r.isBrewing).toBe(false);
        expect(r.temperature).toBe(92.3);
        expect(r.targetTemperature).toBe(93);
        expect(r.profileName).toBe('V60');
        expect(r.machineStatus).toMatchObject({
            temperature: 92.3, targetTemperature: 93, waterLevel: 80,
            upTime: 1234, profileId: 2, profileName: 'V60', updatedAt: now,
        });
    });

    it('detects brewing from brewSwitchState', () => {
        const r = deriveMachineState({ brewSwitchState: true, temperature: '95' });
        expect(r.isBrewing).toBe(true);
        expect(r.machineStatus.brewSwitchState).toBe(true);
    });

    it('falls back profileName to "Unknown" when absent', () => {
        const r = deriveMachineState({});
        expect(r.profileName).toBe('Unknown');
        expect(r.machineStatus.profileName).toBeNull();
    });

    it('coerces unparseable numeric fields to 0/null', () => {
        const r = deriveMachineState({ pressure: 'x', temperature: 'y', profileId: 'z' });
        expect(r.pressure).toBe(0);
        expect(r.temperature).toBe(0);
        expect(r.machineStatus.profileId).toBeNull();
    });

    // #597
    it('omits the live-WS-only fields when `live` is not passed (backward compatibility)', () => {
        const r = deriveMachineState({ temperature: '92' });
        expect(r.machineStatus.pumpFlow).toBeUndefined();
        expect(r.machineStatus.thermocoupleFaulted).toBeUndefined();
    });

    it('merges sensorSnap fields into machineStatus when provided', () => {
        const r = deriveMachineState({ temperature: '92' }, undefined, {
            sensorSnap: { pumpFlow: 1.5, weightFlow: 0.4, waterTemperature: 90, boilerState: true, valveState: false },
        });
        expect(r.machineStatus.pumpFlow).toBe(1.5);
        expect(r.machineStatus.weightFlow).toBe(0.4);
        expect(r.machineStatus.waterTemperature).toBe(90);
        expect(r.machineStatus.boilerState).toBe(true);
        expect(r.machineStatus.valveState).toBe(false);
    });

    it('merges sysState fault fields into machineStatus when provided', () => {
        const r = deriveMachineState({ temperature: '92' }, undefined, {
            sysState: { thermocoupleFaulted: true, thermocoupleFaultReason: 'Open circuit', pressureSensorFaulted: false },
        });
        expect(r.machineStatus.thermocoupleFaulted).toBe(true);
        expect(r.machineStatus.thermocoupleFaultReason).toBe('Open circuit');
        expect(r.machineStatus.pressureSensorFaulted).toBe(false);
        expect(r.machineStatus.pressureSensorFaultReason).toBe('');
    });
});

describe('isStillWarm (#552)', () => {
    const now = 1_700_000_000_000;

    it('is warm when currentTemp is above the warm threshold (80) and switch-off was recent', () => {
        expect(isStillWarm({ currentTemp: 85, switchOffAt: now - 1000, switchOnAt: now - 60000 }, now)).toBe(true);
    });

    it('is not warm when currentTemp is at/below the warm threshold', () => {
        expect(isStillWarm({ currentTemp: 80, switchOffAt: now - 1000, switchOnAt: now - 60000 }, now)).toBe(false);
    });

    it('is cold once switchOffAt exceeds the warm-off window, regardless of temp', () => {
        expect(isStillWarm({ currentTemp: 85, switchOffAt: now - 999_999_999, switchOnAt: now - 60000 }, now)).toBe(false);
    });

    it('falls back to switchOnAt presence when currentTemp is unknown (null)', () => {
        expect(isStillWarm({ currentTemp: null, switchOffAt: null, switchOnAt: now - 1000 }, now)).toBe(true);
        expect(isStillWarm({ currentTemp: null, switchOffAt: null, switchOnAt: null }, now)).toBe(false);
    });
});
