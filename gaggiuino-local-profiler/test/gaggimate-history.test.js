// GaggiMate .slog / index.bin binary parser tests (#318). Fixtures are built
// by hand in-test from the format description (see history.js's header
// comment) rather than fetched from a real device — none was available.
// Covers both header v4 (128-byte header) and v5 (512-byte header with
// phase-transition records).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const history = require('../lib/machines/gaggimate/history');

function writeCString(buf, offset, str, maxLen) {
    const bytes = Buffer.from(str, 'utf8').subarray(0, maxLen - 1);
    bytes.copy(buf, offset);
}

// fieldsMask selecting t(bit0), tt(bit1), ct(bit2), cp(bit4), fl(bit5) — a
// representative subset, not all 13 fields, to also prove fieldsMask-driven
// sample layout (skipped fields shrink the per-sample byte size).
const FIELDS_MASK = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 4) | (1 << 5);
const SAMPLE_SIZE = 10; // 5 active fields * 2 bytes

function buildSlogV4({ samples }) {
    const headerSize = history.HEADER_SIZE_V4;
    const buf = Buffer.alloc(headerSize + samples.length * SAMPLE_SIZE);
    buf.write('SHOT', 0, 'ascii');
    buf.writeUInt8(4, 4);              // version
    buf.writeUInt8(SAMPLE_SIZE, 5);    // deviceSampleSize
    buf.writeUInt16LE(headerSize, 6);
    buf.writeUInt16LE(100, 8);         // sampleIntervalMs
    buf.writeUInt32LE(FIELDS_MASK, 12);
    buf.writeUInt32LE(samples.length, 16);
    buf.writeUInt32LE(5000, 20);       // durationMs
    buf.writeUInt32LE(1700000000, 24); // timestamp
    writeCString(buf, 28, 'p1', 32);
    writeCString(buf, 60, 'Test Profile', 48);
    buf.writeUInt16LE(185, 108);       // finalWeight = 18.5g

    let off = headerSize;
    for (const s of samples) {
        buf.writeInt16LE(s.t, off); off += 2;
        buf.writeInt16LE(s.tt, off); off += 2;
        buf.writeInt16LE(s.ct, off); off += 2;
        buf.writeInt16LE(s.cp, off); off += 2;
        buf.writeInt16LE(s.fl, off); off += 2;
    }
    return buf;
}

function buildSlogV5({ samples, transitions }) {
    const headerSize = history.HEADER_SIZE_V5;
    const buf = Buffer.alloc(headerSize + samples.length * SAMPLE_SIZE);
    buf.write('SHOT', 0, 'ascii');
    buf.writeUInt8(5, 4);
    buf.writeUInt8(SAMPLE_SIZE, 5);
    buf.writeUInt16LE(headerSize, 6);
    buf.writeUInt16LE(100, 8);
    buf.writeUInt32LE(FIELDS_MASK, 12);
    buf.writeUInt32LE(samples.length, 16);
    buf.writeUInt32LE(6000, 20);
    buf.writeUInt32LE(1700000500, 24);
    writeCString(buf, 28, 'p2', 32);
    writeCString(buf, 60, 'V5 Profile', 48);
    buf.writeUInt16LE(200, 108); // 20.0g

    transitions.forEach((t, i) => {
        const o = 110 + i * 29;
        buf.writeUInt16LE(t.sampleIndex, o);
        buf.writeUInt8(t.phaseNumber, o + 2);
        buf.writeUInt8(t.exitReason, o + 3);
        writeCString(buf, o + 4, t.phaseName, 25);
    });
    buf.writeUInt8(transitions.length, 458);
    buf.writeUInt8(5, 459);       // finalExitReason: duration
    buf.writeUInt16LE(250, 460);  // brewDelayMs

    let off = headerSize;
    for (const s of samples) {
        buf.writeInt16LE(s.t, off); off += 2;
        buf.writeInt16LE(s.tt, off); off += 2;
        buf.writeInt16LE(s.ct, off); off += 2;
        buf.writeInt16LE(s.cp, off); off += 2;
        buf.writeInt16LE(s.fl, off); off += 2;
    }
    return buf;
}

const SAMPLES = [
    { t: 0, tt: 930, ct: 900, cp: 20, fl: 50 },
    { t: 1, tt: 930, ct: 915, cp: 80, fl: 180 },
    { t: 2, tt: 930, ct: 920, cp: 90, fl: 200 },
];

describe('gaggimate/history — .slog v4 (128-byte header)', () => {
    const buf = buildSlogV4({ samples: SAMPLES });
    const parsed = history.parseSlog(buf);

    it('parses the common header fields', () => {
        expect(parsed.version).toBe(4);
        expect(parsed.sampleIntervalMs).toBe(100);
        expect(parsed.durationMs).toBe(5000);
        expect(parsed.timestamp).toBe(1700000000);
        expect(parsed.profileId).toBe('p1');
        expect(parsed.profileName).toBe('Test Profile');
        expect(parsed.finalWeight).toBeCloseTo(18.5);
    });

    it('decodes samples according to fieldsMask, applying the right scale per field', () => {
        expect(parsed.samples).toHaveLength(3);
        expect(parsed.samples[0].tickMs).toBe(0);
        expect(parsed.samples[1].tickMs).toBe(100); // tick 1 * sampleIntervalMs 100
        expect(parsed.samples[2].tickMs).toBe(200);
        expect(parsed.samples[0].tt).toBeCloseTo(93.0);
        expect(parsed.samples[1].ct).toBeCloseTo(91.5);
        expect(parsed.samples[2].cp).toBeCloseTo(9.0);
        expect(parsed.samples[1].fl).toBeCloseTo(1.8);
        // fields not in the mask (pf/vf/pr/v/ev/systemInfo) are simply absent
        expect(parsed.samples[0].pr).toBeUndefined();
    });

    it('has no v5 phase-transition data', () => {
        expect(parsed.transitions).toEqual([]);
    });

    it('toGlpShot maps samples into GLP\'s canonical ×10-scaled datapoints shape', () => {
        const shot = history.toGlpShot(parsed, 42);
        expect(shot.id).toBe(42);
        expect(shot.profile_name).toBe('Test Profile');
        expect(shot.duration).toBe(5000);
        expect(shot.datapoints.timeInShot).toEqual([0, 1, 2]); // tickMs/100 rounded
        expect(shot.datapoints.temperature).toEqual([900, 915, 920]); // ct * 10
        expect(shot.datapoints.pressure).toEqual([20, 80, 90]); // cp (raw/10 bar) * 10
        expect(shot.machineType).toBe('gaggimate');
    });
});

describe('gaggimate/history — .slog v5 (512-byte header, phase transitions)', () => {
    const transitions = [
        { sampleIndex: 0, phaseNumber: 0, exitReason: 1, phaseName: 'Preinfusion' },
        { sampleIndex: 1, phaseNumber: 1, exitReason: 5, phaseName: 'Extraction' },
    ];
    const buf = buildSlogV5({ samples: SAMPLES, transitions });
    const parsed = history.parseSlog(buf);

    it('parses the v5 header the same way as v4 for common fields', () => {
        expect(parsed.version).toBe(5);
        expect(parsed.profileName).toBe('V5 Profile');
        expect(parsed.finalWeight).toBeCloseTo(20.0);
    });

    it('parses phase-transition records', () => {
        expect(parsed.transitions).toHaveLength(2);
        expect(parsed.transitions[0]).toMatchObject({ sampleIndex: 0, phaseNumber: 0, exitReason: 1, phaseName: 'Preinfusion' });
        expect(parsed.transitions[1].phaseName).toBe('Extraction');
        expect(parsed.finalExitReason).toBe(5);
        expect(parsed.brewDelayMs).toBe(250);
    });

    it('still decodes samples correctly with the larger header offset', () => {
        expect(parsed.samples).toHaveLength(3);
        expect(parsed.samples[2].ct).toBeCloseTo(92.0);
    });
});

describe('gaggimate/history — index.bin', () => {
    function buildIndexBin(entries) {
        const buf = Buffer.alloc(history.INDEX_HEADER_SIZE + entries.length * history.INDEX_ENTRY_SIZE);
        buf.writeUInt32LE(history.INDEX_MAGIC, 0);
        buf.writeUInt16LE(1, 4);   // version
        buf.writeUInt16LE(history.INDEX_ENTRY_SIZE, 6);
        buf.writeUInt32LE(entries.length, 8);
        buf.writeUInt32LE(entries.length + 1, 12); // nextShotId

        entries.forEach((e, i) => {
            const o = history.INDEX_HEADER_SIZE + i * history.INDEX_ENTRY_SIZE;
            buf.writeUInt32LE(e.id, o);
            buf.writeUInt32LE(e.timestamp, o + 4);
            buf.writeUInt32LE(e.duration, o + 8);
            buf.writeUInt16LE(e.volume * 10, o + 12);
            buf.writeUInt8(e.rating, o + 14);
            buf.writeUInt8(e.flags, o + 15);
            writeCString(buf, o + 16, e.profileId, 32);
            writeCString(buf, o + 48, e.profileName, 48);
            buf.writeUInt16LE(e.avgTemp * 10, o + 96);
            buf.writeUInt16LE(e.maxPressure * 10, o + 98);
            buf.writeUInt16LE(e.avgFlow * 100, o + 100);
        });
        return buf;
    }

    it('parses the header and every entry record', () => {
        const buf = buildIndexBin([
            { id: 1, timestamp: 1700000000, duration: 28000, volume: 36, rating: 4, flags: 0x01, profileId: 'p1', profileName: 'Espresso', avgTemp: 92.3, maxPressure: 9.1, avgFlow: 1.85 },
            { id: 2, timestamp: 1700003600, duration: 25000, volume: 40, rating: 0, flags: 0x03, profileId: 'p2', profileName: 'Ristretto', avgTemp: 93.0, maxPressure: 8.5, avgFlow: 1.6 },
        ]);
        const parsed = history.parseIndexBin(buf);

        expect(parsed.entryCount).toBe(2);
        expect(parsed.nextShotId).toBe(3);
        expect(parsed.entries).toHaveLength(2);

        expect(parsed.entries[0]).toMatchObject({
            id: 1, timestamp: 1700000000, duration: 28000, rating: 4,
            completed: true, deleted: false, profileName: 'Espresso',
        });
        expect(parsed.entries[0].volume).toBeCloseTo(36);
        expect(parsed.entries[0].avgTemp).toBeCloseTo(92.3);
        expect(parsed.entries[0].avgFlow).toBeCloseTo(1.85);

        expect(parsed.entries[1]).toMatchObject({ id: 2, completed: true, deleted: true, profileName: 'Ristretto' });
    });

    it('rejects a file with the wrong magic number', () => {
        const bad = Buffer.alloc(64);
        bad.write('NOPE', 0, 'ascii');
        expect(() => history.parseIndexBin(bad)).toThrow(/bad magic/);
    });
});
