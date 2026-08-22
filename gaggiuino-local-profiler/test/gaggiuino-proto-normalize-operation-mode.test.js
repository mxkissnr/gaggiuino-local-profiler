// #902: normalizeOperationMode() is the seam lib/machine-state.js's
// deriveMachineState() uses to compare sysState.operationMode regardless of
// which live transport supplied it -- WS decodes it to the enum's numeric
// wire value, MQTT's toSysState() maps it straight through as the enum's
// string name (see gaggiuino-mqtt-client.js's own comment on that field).
import { describe, it, expect } from 'vitest';
import { normalizeOperationMode } from '../lib/gaggiuino-proto.js';

describe('normalizeOperationMode() (#902)', () => {
    it('maps a numeric WS wire value to its canonical string name', () => {
        expect(normalizeOperationMode(0)).toBe('BREW_AUTO');
        expect(normalizeOperationMode(2)).toBe('FLUSH');
        expect(normalizeOperationMode(4)).toBe('STEAM');
        expect(normalizeOperationMode(5)).toBe('FLUSH_AUTO');
    });

    it('passes an already-canonical MQTT string name straight through', () => {
        expect(normalizeOperationMode('STEAM')).toBe('STEAM');
        expect(normalizeOperationMode('FLUSH_AUTO')).toBe('FLUSH_AUTO');
    });

    it('returns null for an unrecognized numeric value', () => {
        expect(normalizeOperationMode(99)).toBeNull();
    });

    it('returns null for an unrecognized string', () => {
        expect(normalizeOperationMode('NOT_A_MODE')).toBeNull();
    });

    it('returns null when operationMode is absent (no live transport connected)', () => {
        expect(normalizeOperationMode(undefined)).toBeNull();
        expect(normalizeOperationMode(null)).toBeNull();
    });
});
