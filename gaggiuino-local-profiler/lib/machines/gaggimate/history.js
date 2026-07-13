// GaggiMate shot-history binary parser (#318) — own implementation written
// from a prose description of the format (reverse-engineered from the
// GaggiMate web UI's own parsers, fetched read-only for reference, never
// copied — see the repo's Gaggiuino project-boundaries rule, held to for
// GaggiMate too). Formats covered:
//   - index.bin: GET /api/history/index.bin — fixed 32-byte header + 128-byte
//     entry records, one per shot.
//   - <id>.slog: GET /api/history/<id>.slog — magic "SHOT", header v4 (128
//     bytes) or v5 (512 bytes, adds up to 12 phase-transition records), then
//     one fixed-size sample record per field selected in the header's
//     fieldsMask, back to back until EOF/sampleCount.
'use strict';

// ── index.bin ────────────────────────────────────────────────────────────

const INDEX_MAGIC = 0x58444953; // 'SIDX' little-endian
const INDEX_HEADER_SIZE = 32;
const INDEX_ENTRY_SIZE = 128;

function readCString(buf, offset, maxLen) {
    let end = offset;
    const limit = offset + maxLen;
    while (end < limit && buf[end] !== 0) end++;
    return buf.toString('utf8', offset, end);
}

function parseIndexBin(buffer) {
    if (buffer.length < INDEX_HEADER_SIZE) throw new Error('index.bin: file too short for header');
    const magic = buffer.readUInt32LE(0);
    if (magic !== INDEX_MAGIC) throw new Error('index.bin: bad magic (not SIDX)');

    const version    = buffer.readUInt16LE(4);
    const entrySize  = buffer.readUInt16LE(6) || INDEX_ENTRY_SIZE;
    const entryCount = buffer.readUInt32LE(8);
    const nextShotId = buffer.readUInt32LE(12);

    const entries = [];
    const maxByLength = Math.floor((buffer.length - INDEX_HEADER_SIZE) / entrySize);
    const count = entryCount > 0 ? Math.min(entryCount, maxByLength) : maxByLength;

    for (let i = 0; i < count; i++) {
        const o = INDEX_HEADER_SIZE + i * entrySize;
        if (o + entrySize > buffer.length) break;
        const flags = buffer.readUInt8(o + 15);
        entries.push({
            id:          buffer.readUInt32LE(o),
            timestamp:   buffer.readUInt32LE(o + 4),
            duration:    buffer.readUInt32LE(o + 8),
            volume:      buffer.readUInt16LE(o + 12) / 10,
            rating:      buffer.readUInt8(o + 14),
            completed:   !!(flags & 0x01),
            deleted:     !!(flags & 0x02),
            hasNote:     !!(flags & 0x04),
            profileId:   readCString(buffer, o + 16, 32),
            profileName: readCString(buffer, o + 48, 48),
            avgTemp:     buffer.readUInt16LE(o + 96) / 10,
            maxPressure: buffer.readUInt16LE(o + 98) / 10,
            avgFlow:     buffer.readUInt16LE(o + 100) / 100,
        });
    }

    return { version, entrySize, entryCount, nextShotId, entries };
}

// ── .slog ────────────────────────────────────────────────────────────────

const SLOG_MAGIC = 0x544f4853; // 'SHOT' little-endian
const HEADER_SIZE_V4 = 128;
const HEADER_SIZE_V5 = 512;

// Field codes in ascending fieldsMask bit-order, each a 16-bit sample value.
const FIELD_BITS = [
    { bit: 0,  key: 't',  scale: null }, // tick — multiplied by sampleIntervalMs, not divided
    { bit: 1,  key: 'tt', scale: 10 },   // target temperature (°C)
    { bit: 2,  key: 'ct', scale: 10 },   // current temperature (°C)
    { bit: 3,  key: 'tp', scale: 10 },   // target pressure (bar)
    { bit: 4,  key: 'cp', scale: 10 },   // current pressure (bar)
    { bit: 5,  key: 'fl', scale: 100 },  // pump flow (ml/s)
    { bit: 6,  key: 'tf', scale: 100 },  // target flow (ml/s)
    { bit: 7,  key: 'pf', scale: 100 },  // puck flow (ml/s)
    { bit: 8,  key: 'vf', scale: 100 },  // volumetric flow (ml/s)
    { bit: 9,  key: 'v',  scale: 10 },   // volumetric weight (g)
    { bit: 10, key: 'ev', scale: 10 },   // estimated weight (g)
    { bit: 11, key: 'pr', scale: 100 },  // puck resistance
    { bit: 12, key: 'systemInfo', scale: null },
];

function decodeSystemInfo(raw) {
    return {
        volumetricAtStart: !!(raw & 0x01),
        volumetricNow:      !!(raw & 0x02),
        bleScaleConnected:  !!(raw & 0x04),
        volumetricCapable:  !!(raw & 0x08),
        extendedRecording:  !!(raw & 0x10),
    };
}

function parseSlog(buffer) {
    if (buffer.length < 8) throw new Error('.slog: file too short for header');
    const magic = buffer.readUInt32LE(0);
    if (magic !== SLOG_MAGIC) throw new Error('.slog: bad magic (not SHOT)');

    const version          = buffer.readUInt8(4);
    const deviceSampleSize = buffer.readUInt8(5);
    const headerSize       = buffer.readUInt16LE(6) || (version >= 5 ? HEADER_SIZE_V5 : HEADER_SIZE_V4);
    const sampleIntervalMs = buffer.readUInt16LE(8) || 100;
    const fieldsMask       = buffer.readUInt32LE(12);
    const sampleCountHdr   = buffer.readUInt32LE(16);
    const durationMs       = buffer.readUInt32LE(20);
    const timestamp        = buffer.readUInt32LE(24);
    const profileId        = readCString(buffer, 28, 32);
    const profileName      = readCString(buffer, 60, 48);
    const finalWeight       = buffer.readUInt16LE(108) / 10;

    let transitions = [];
    let finalExitReason = null;
    let brewDelayMs = null;
    if (version >= 5 && buffer.length >= HEADER_SIZE_V5) {
        const transitionCount = Math.min(buffer.readUInt8(458), 12);
        for (let i = 0; i < transitionCount; i++) {
            const o = 110 + i * 29;
            transitions.push({
                sampleIndex: buffer.readUInt16LE(o),
                phaseNumber: buffer.readUInt8(o + 2),
                exitReason:  buffer.readUInt8(o + 3),
                phaseName:   readCString(buffer, o + 4, 25),
            });
        }
        finalExitReason = buffer.readUInt8(459);
        brewDelayMs     = buffer.readUInt16LE(460);
    }

    const activeFields = FIELD_BITS.filter(f => (fieldsMask & (1 << f.bit)) !== 0);
    const computedSampleSize = activeFields.length * 2;
    const sampleSize = deviceSampleSize || computedSampleSize;

    const samples = [];
    if (sampleSize > 0) {
        const dataStart  = headerSize;
        const available  = Math.floor((buffer.length - dataStart) / sampleSize);
        const maxSamples = sampleCountHdr > 0 ? Math.min(sampleCountHdr, available) : available;

        for (let i = 0; i < maxSamples; i++) {
            const base = dataStart + i * sampleSize;
            if (base + sampleSize > buffer.length) break;
            const sample = {};
            let off = base;
            for (const f of activeFields) {
                const raw = buffer.readInt16LE(off);
                if (f.key === 't') sample.tickMs = raw * sampleIntervalMs;
                else if (f.key === 'systemInfo') sample.systemInfo = decodeSystemInfo(raw);
                else sample[f.key] = raw / f.scale;
                off += 2;
            }
            samples.push(sample);
        }
    }

    return {
        version, sampleIntervalMs, fieldsMask, sampleCount: sampleCountHdr,
        durationMs, timestamp, profileId, profileName, finalWeight,
        transitions, finalExitReason, brewDelayMs, samples,
    };
}

// ── Mapping into GLP's canonical shot/datapoints shape ─────────────────────
// GLP's own datapoints convention (see lib/poll.js's liveAccum) scales every
// value ×10 as an integer and counts timeInShot in "deciseconds" (elapsed
// ms / 100, rounded). GaggiMate's ct/tt/cp/v/ev already decode to real units
// above, so they're re-scaled ×10 here the same way. Puck flow (pf),
// volumetric flow (vf) and puck resistance (pr) have no slot in GLP's
// canonical datapoints — kept in `gaggimateExtra` instead of being silently
// dropped, per the plan's "lossy, documented" mapping.
function toGlpShot(slog, nativeId) {
    const datapoints = {
        timeInShot: [], pressure: [], temperature: [],
        shotWeight: [], weightFlow: [], pumpFlow: [], targetTemperature: [],
    };
    const gaggimateExtra = { puckFlow: [], volumetricFlow: [], puckResistance: [] };

    for (const s of slog.samples) {
        datapoints.timeInShot.push(Math.round((s.tickMs ?? 0) / 100));
        datapoints.pressure.push(Math.round((s.cp ?? 0) * 10));
        datapoints.temperature.push(Math.round((s.ct ?? 0) * 10));
        datapoints.targetTemperature.push(Math.round((s.tt ?? 0) * 10));
        datapoints.shotWeight.push(Math.round((s.ev ?? s.v ?? 0) * 10));
        datapoints.weightFlow.push(Math.round((s.fl ?? 0) * 10));
        datapoints.pumpFlow.push(Math.round((s.tf ?? 0) * 10));
        gaggimateExtra.puckFlow.push(s.pf ?? null);
        gaggimateExtra.volumetricFlow.push(s.vf ?? null);
        gaggimateExtra.puckResistance.push(s.pr ?? null);
    }

    return {
        id:           nativeId,
        timestamp:    slog.timestamp,
        duration:     slog.durationMs,
        profile_name: slog.profileName || slog.profileId || 'Unknown',
        datapoints,
        gaggimateExtra,
        gaggimateFinalWeight: slog.finalWeight,
        machineType: 'gaggimate',
    };
}

module.exports = {
    INDEX_MAGIC, INDEX_HEADER_SIZE, INDEX_ENTRY_SIZE,
    SLOG_MAGIC, HEADER_SIZE_V4, HEADER_SIZE_V5, FIELD_BITS,
    parseIndexBin, parseSlog, toGlpShot,
};
