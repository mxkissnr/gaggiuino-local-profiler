import { describe, it, expect } from 'vitest';
import { expandShots, mulberry32 } from '../scripts/perf-dataset.mts';
import type { BackupShot } from '../scripts/perf-dataset.mts';

// #1558: the perf dataset must be reproducible — same input and seed, same ZIP.
// expandShots is the pure core (clone ids, timestamps, seeded jitter and the
// annotations that follow each clone), so these tests exercise it without the
// filesystem or the ZIP reader/writer.

function makeShots(count: number): BackupShot[] {
    const shots: BackupShot[] = [];
    for (let id = 1; id <= count; id++) {
        shots.push({
            id,
            nativeId: id,
            timestamp: 1_700_000_000 + id * 600,
            datapoints: {
                pressure: [10, 20, 30, 40, 50],
                pumpFlow: [5, 6, 7, 8, 9],
                timeInShot: [0, 1, 2, 3, 4],
            },
            image: 'jpg',
        });
    }
    return shots;
}

function makeAnnotations(count: number): Record<string, Record<string, unknown>> {
    const annotations: Record<string, Record<string, unknown>> = {};
    for (let id = 1; id <= count; id++) {
        annotations[String(id)] = { beanId: 1000 + id, rating: id % 5, notes: `shot ${id}` };
    }
    return annotations;
}

describe('expandShots (#1558)', () => {
    it('is byte-for-byte identical for the same seed', () => {
        const shots = makeShots(4);
        const annotations = makeAnnotations(4);

        const first = expandShots(shots, annotations, 16, 1558);
        const second = expandShots(shots, annotations, 16, 1558);

        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('differs for a different seed', () => {
        const shots = makeShots(4);
        const annotations = makeAnnotations(4);

        const first = expandShots(shots, annotations, 16, 1558);
        const other = expandShots(shots, annotations, 16, 1559);

        expect(JSON.stringify(first)).not.toBe(JSON.stringify(other));
    });

    it('returns n shots, all with unique ids', () => {
        const shots = makeShots(4);
        const annotations = makeAnnotations(4);

        const expanded = expandShots(shots, annotations, 20, 1558);

        expect(expanded.shots).toHaveLength(20);
        expect(new Set(expanded.shots.map((shot) => shot.id)).size).toBe(20);
        expect(expanded.shots.every((shot) => shot.id === shot.nativeId)).toBe(true);
    });

    it('clones the annotation of the shot each clone came from', () => {
        const shots = makeShots(4);
        const annotations = makeAnnotations(4);

        const expanded = expandShots(shots, annotations, 12, 1558);

        // Clones cycle through the sources in order, after the 4 originals.
        for (let i = 4; i < expanded.shots.length; i++) {
            const clone = expanded.shots[i];
            const source = shots[(i - 4) % shots.length];
            expect(clone).toBeDefined();
            expect(source).toBeDefined();
            if (!clone || !source) continue;
            expect(expanded.annotations[String(clone.id)]).toEqual(annotations[String(source.id)]);
        }
    });

    it('mulberry32 is reproducible for a seed', () => {
        const first = mulberry32(7);
        const second = mulberry32(7);

        expect([first(), first(), first()]).toEqual([second(), second(), second()]);
    });
});
