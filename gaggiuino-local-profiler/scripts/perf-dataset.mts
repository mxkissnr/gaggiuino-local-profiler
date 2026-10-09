#!/usr/bin/env node
// Deterministic dataset generator for the perf-compare workflow (#1558).
//
// Reads the demo backup ZIP, grows its `shots` array to N by cloning existing
// shots — fresh unique id/nativeId, timestamps spread backwards from the oldest
// real shot, a small seeded jitter on the curve values — clones the matching
// `annotations` entries under the new shot id, and writes a new ZIP. Every other
// section and every image entry is copied unchanged.
//
// Determinism: a fixed seeded PRNG (mulberry32, never Math.random) and a fixed
// ZIP layout (input entry order, DOS timestamp 1980-01-01, method 8) mean the
// same input plus seed give a byte-identical ZIP. The perf-compare workflow
// relies on that so base and head measure the same data.
//
// The repo ships no ZIP library and this file adds no dependency, so a minimal
// central-directory reader (stored or deflated entries, inflated via node:zlib's
// inflateRawSync) and a minimal writer (deflateRawSync, CRC-32 computed here)
// live below. The Go server reads the result with archive/zip, so plain local
// headers plus a central directory are enough — no ZIP64, no encryption.
//
// The pure part — mulberry32, expandShots and buildDataset — is exported for
// test/perf-dataset.test.ts; the CLI wrapper only touches the filesystem.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(scriptDir, '..');

// The demo backup's curve values move a few percent per clone: enough that a
// second seed gives visibly different rows, small enough that the shape and the
// endpoint timings stay realistic. `timeInShot` is left exact because it is the
// x-axis every other series is plotted against.
const JITTER = 0.04;
const CLONE_STEP_SECONDS = 3600;

export interface BackupShot {
    id: number;
    nativeId: number;
    timestamp: number;
    datapoints?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface ZipEntry {
    name: string;
    data: Buffer;
}

export interface ExpandedShots {
    shots: BackupShot[];
    annotations: Record<string, Record<string, unknown>>;
}

interface Backup {
    shots?: BackupShot[];
    annotations?: Record<string, Record<string, unknown>>;
    trash?: Record<string, unknown>;
    [key: string]: unknown;
}

// mulberry32 — a tiny, fast, well-distributed 32-bit PRNG. Deterministic given
// the seed, unlike Math.random, which is what makes the dataset reproducible.
export function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value) as string) as T;
}

function jitterDatapoints(datapoints: Record<string, unknown>, rng: () => number): void {
    for (const key of Object.keys(datapoints)) {
        if (key === 'timeInShot') continue;
        const series = datapoints[key];
        if (!Array.isArray(series)) continue;
        const values = series as unknown[];
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            if (typeof value !== 'number' || !Number.isFinite(value)) continue;
            const moved = value * (1 + (rng() - 0.5) * JITTER);
            values[i] = Number.isInteger(value) ? Math.round(moved) : moved;
        }
    }
}

// expandShots grows `shots` (and the annotations keyed by shot id) to n entries.
// When n is at most the existing count the first n shots are kept unchanged;
// otherwise the rest are clones that cycle through the existing shots. New ids
// start above every existing shot/annotation id (and above idFloor, which the
// caller sets from the backup's `trash` map so a clone never collides with a
// trashed id). The returned arrays are new objects; the inputs are not mutated.
export function expandShots(
    shots: readonly BackupShot[],
    annotations: Readonly<Record<string, Record<string, unknown>>>,
    n: number,
    seed: number,
    idFloor = 0,
): ExpandedShots {
    if (n <= 0) return { shots: [], annotations: {} };

    const baseCount = Math.min(n, shots.length);
    const result: BackupShot[] = [];
    const resultAnnotations: Record<string, Record<string, unknown>> = {};

    for (let i = 0; i < baseCount; i++) {
        const shot = shots[i];
        if (!shot) continue;
        result.push(shot);
        const annotation = annotations[String(shot.id)];
        if (annotation) resultAnnotations[String(shot.id)] = annotation;
    }

    if (n <= shots.length || shots.length === 0) {
        return { shots: result, annotations: resultAnnotations };
    }

    let maxId = idFloor;
    for (const shot of shots) {
        maxId = Math.max(maxId, shot.id, shot.nativeId);
    }
    for (const key of Object.keys(annotations)) {
        const id = Number(key);
        if (Number.isFinite(id)) maxId = Math.max(maxId, id);
    }

    const oldestTimestamp = Math.min(...shots.map((shot) => shot.timestamp));
    const rng = mulberry32(seed);
    let cloneIndex = 0;
    while (result.length < n) {
        const source = shots[cloneIndex % shots.length];
        cloneIndex += 1;
        if (!source) continue;

        const newId = maxId + cloneIndex;
        const clone = cloneJson(source);
        // A clone has no photo of its own (the images/ entries are left
        // untouched), so drop any dangling reference to the source's image.
        delete clone.image;
        clone.id = newId;
        clone.nativeId = newId;
        clone.timestamp = oldestTimestamp - cloneIndex * CLONE_STEP_SECONDS - Math.floor(rng() * 60);
        if (clone.datapoints) jitterDatapoints(clone.datapoints, rng);
        result.push(clone);

        const sourceAnnotation = annotations[String(source.id)];
        if (sourceAnnotation) resultAnnotations[String(newId)] = cloneJson(sourceAnnotation);
    }

    return { shots: result, annotations: resultAnnotations };
}

// ── Minimal ZIP reader ──────────────────────────────────────────────────────

interface ZipCentralRecord {
    name: string;
    method: number;
    compressedSize: number;
    localOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buf: Buffer): number {
    // The EOCD is 22 bytes plus an optional comment of up to 65535 bytes; scan
    // backwards over that window for the signature.
    const min = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
    }
    return -1;
}

export function readZip(buf: Buffer): ZipEntry[] {
    const eocd = findEndOfCentralDirectory(buf);
    if (eocd < 0) throw new Error('not a zip: end of central directory not found');

    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);

    const records: ZipCentralRecord[] = [];
    for (let k = 0; k < count; k++) {
        if (buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) throw new Error('not a zip: bad central directory');
        const method = buf.readUInt16LE(p + 10);
        const compressedSize = buf.readUInt32LE(p + 20);
        const nameLength = buf.readUInt16LE(p + 28);
        const extraLength = buf.readUInt16LE(p + 30);
        const commentLength = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
        records.push({ name, method, compressedSize, localOffset });
        p += 46 + nameLength + extraLength + commentLength;
    }

    const entries: ZipEntry[] = [];
    for (const record of records) {
        const local = record.localOffset;
        if (buf.readUInt32LE(local) !== LOCAL_SIGNATURE) throw new Error(`not a zip: bad local header for ${record.name}`);
        const localNameLength = buf.readUInt16LE(local + 26);
        const localExtraLength = buf.readUInt16LE(local + 28);
        const dataStart = local + 30 + localNameLength + localExtraLength;
        const raw = buf.subarray(dataStart, dataStart + record.compressedSize);

        let data: Buffer;
        if (record.method === 0) {
            data = Buffer.from(raw);
        } else if (record.method === 8) {
            data = inflateRawSync(raw);
        } else {
            throw new Error(`unsupported ZIP compression method ${record.method} for ${record.name}`);
        }
        entries.push({ name: record.name, data });
    }
    return entries;
}

// ── Minimal ZIP writer ──────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(data: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        c = CRC_TABLE[(c ^ (data[i] as number)) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

// writeZip emits entries in the given order with a fixed DOS date (1980-01-01)
// and method 8, so the same entries always produce the same bytes.
export function writeZip(entries: readonly ZipEntry[]): Buffer {
    const dosTime = 0;
    const dosDate = 0x21; // 1980-01-01
    const chunks: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const crc = crc32(entry.data);
        const compressed = deflateRawSync(entry.data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOCAL_SIGNATURE, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, name, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(dosTime, 12);
        central.writeUInt16LE(dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);

        offset += local.length + name.length + compressed.length;
    }

    const centralDirectory = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralDirectory.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...chunks, centralDirectory, eocd]);
}

// ── Dataset assembly ────────────────────────────────────────────────────────

export function buildDataset(zipBuf: Buffer, n: number, seed: number): Buffer {
    const entries = readZip(zipBuf);
    const out: ZipEntry[] = [];
    for (const entry of entries) {
        if (entry.name !== 'backup.json') {
            out.push(entry);
            continue;
        }
        const backup = JSON.parse(entry.data.toString('utf8')) as Backup;
        const trashIds = Object.keys(backup.trash ?? {})
            .map((key) => Number(key))
            .filter((id) => Number.isFinite(id));
        const idFloor = trashIds.length > 0 ? Math.max(...trashIds) : 0;
        const expanded = expandShots(backup.shots ?? [], backup.annotations ?? {}, n, seed, idFloor);
        backup.shots = expanded.shots;
        backup.annotations = expanded.annotations;
        out.push({ name: entry.name, data: Buffer.from(JSON.stringify(backup), 'utf8') });
    }
    return writeZip(out);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function argValue(argv: readonly string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    return index !== -1 ? argv[index + 1] : undefined;
}

function isMain(): boolean {
    const entry = process.argv[1];
    return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
    const argv = process.argv.slice(2);
    const input = argValue(argv, '--input') ?? join(appRoot, 'demo', 'glp-demo-backup.zip');
    const out = argValue(argv, '--out');
    const shots = Number(argValue(argv, '--shots') ?? '5000');
    const seed = Number(argValue(argv, '--seed') ?? '1558');

    if (out === undefined) {
        console.error('usage: node scripts/perf-dataset.mts --out <file.zip> [--input <zip>] [--shots <n>] [--seed <n>]');
        process.exit(1);
    }
    const zip = buildDataset(readFileSync(input), shots, seed);
    writeFileSync(out, zip);
    console.log(`wrote ${out}: ${shots} shots, seed ${seed}, ${zip.length} bytes`);
}
