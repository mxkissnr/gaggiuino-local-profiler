import { describe, it, expect } from 'vitest';
import { groupShotsByDay } from '../public-src/utils.js';

const NOW = new Date(2026, 6, 21, 15, 0, 0); // 2026-07-21 15:00 local
const ts = (y, m, d, h = 12) => Math.floor(new Date(y, m - 1, d, h).getTime() / 1000);
const formatOlder = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('groupShotsByDay', () => {
    it('groups today, yesterday and older shots into separate buckets with correct labels', () => {
        const shots = [
            { id: 1, timestamp: ts(2026, 7, 21, 9) },  // today, 09:00
            { id: 2, timestamp: ts(2026, 7, 21, 8) },  // today, 08:00
            { id: 3, timestamp: ts(2026, 7, 20, 17) }, // yesterday
            { id: 4, timestamp: ts(2026, 7, 19, 7) },  // older
        ];
        const groups = groupShotsByDay(shots, NOW, 'Heute', 'Gestern', formatOlder);
        expect(groups).toHaveLength(3);
        expect(groups[0]).toMatchObject({ label: 'Heute', key: '2026-07-21' });
        expect(groups[0].shots.map(s => s.id)).toEqual([1, 2]);
        expect(groups[1]).toMatchObject({ label: 'Gestern', key: '2026-07-20' });
        expect(groups[1].shots.map(s => s.id)).toEqual([3]);
        expect(groups[2]).toMatchObject({ label: '2026-07-19', key: '2026-07-19' });
        expect(groups[2].shots.map(s => s.id)).toEqual([4]);
    });

    it('starts a new bucket whenever the day changes, even non-contiguously in the input order', () => {
        const shots = [
            { id: 1, timestamp: ts(2026, 7, 20, 9) },
            { id: 2, timestamp: ts(2026, 7, 19, 9) },
            { id: 3, timestamp: ts(2026, 7, 20, 8) }, // back to the 20th — must open a *new* bucket, not merge with group 0
        ];
        const groups = groupShotsByDay(shots, NOW, 'Heute', 'Gestern', formatOlder);
        expect(groups).toHaveLength(3);
        expect(groups.map(g => g.shots.map(s => s.id))).toEqual([[1], [2], [3]]);
    });

    it('handles an empty or missing list', () => {
        expect(groupShotsByDay([], NOW, 'Heute', 'Gestern', formatOlder)).toEqual([]);
        expect(groupShotsByDay(undefined, NOW, 'Heute', 'Gestern', formatOlder)).toEqual([]);
    });

    it('treats midnight boundaries correctly (23:59 today vs 00:01 tomorrow-relative-to-now)', () => {
        const shots = [{ id: 1, timestamp: ts(2026, 7, 20, 23) }]; // 23:00 yesterday
        const groups = groupShotsByDay(shots, NOW, 'Heute', 'Gestern', formatOlder);
        expect(groups[0].label).toBe('Gestern');
    });
});
