import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { diffMachineBackups, MAX_DIFF_DEPTH } from '../public-src/shared/machine-backup-diff.js';
import type { BackupChange, BackupDocument, LeafChange } from '../public-src/shared/machine-backup-diff.js';

type Bag = Record<string, unknown>;

/** The hand-built document shape: real key structure, neutral values, no secrets.
 *  Pure Node test: no DOM, locale or timer use, so test/setup.ts has nothing to add here. */
interface TestDoc {
    firmware: Bag; settings: Bag; profiles: Bag[]; pumpCalibration: Bag; defaultProfileId: unknown; [key: string]: unknown;
}

// A factory, not a shared constant: baseDoc() must give each side its own objects.
const phase2 = (): Bag => ({ type: 1, target: { end: 9 }, stopConditions: { time: 5000 } });
const PHASE_2 = phase2();
const PHASE_2_END_8 = { type: 1, target: { end: 8 }, stopConditions: { time: 5000 } };

type ChangeOf = { change: LeafChange; from?: unknown; to?: unknown };
const changed = (from: unknown, to: unknown): ChangeOf => ({ change: 'changed', from, to });
const added = (to: unknown): ChangeOf => ({ change: 'added', to });
const removed = (from: unknown): ChangeOf => ({ change: 'removed', from });

function isBag(value: unknown): value is Bag {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Array.isArray() would narrow to any[] here, making later reads unsafe-any. */
function isList(value: unknown): value is readonly unknown[] {
    return Array.isArray(value);
}

function container(root: Bag, path: readonly string[]): Bag {
    let node = root;
    for (const key of path.slice(0, -1)) {
        if (!isBag(node[key])) throw new Error(`missing container ${key}`);
        node = node[key];
    }
    return node;
}

function setAt(root: Bag, path: readonly string[], value: unknown): void {
    const last = path[path.length - 1];
    if (last !== undefined) container(root, path)[last] = value;
}

function deleteAt(root: Bag, path: readonly string[]): void {
    const last = path[path.length - 1];
    if (last !== undefined) delete container(root, path)[last];
}

function phasesOf(profile: Bag): Bag[] {
    const phases = profile['phases'];
    return isList(phases) ? (phases as Bag[]) : [];
}

function baseDoc(): TestDoc {
    return {
        format: 'gaggiuino-settings',
        version: 1,
        firmware: { core: '8aaf6f0', frontend: '8aaf6f0' },
        defaultProfileId: 4,
        settings: {
            boiler: { steamSetPoint: 155, offsetTemp: 7, brewDeltaState: true },
            system: { machineName: 'Test machine', releaseChannel: 0, pumpSpec: [0, 0, 0, 0] },
            led: { color: { R: 255, G: 63, B: 0 }, state: true },
            display: { lcdBrightness: 70 },
            webUi: { themeId: 'espresso' },
        },
        profiles: [
            { id: 4, name: 'Adaptive', phases: [{ type: 0, target: { end: 7 }, stopConditions: { time: 20000 } }, phase2()],
              globalStopConditions: { weight: 37 }, waterTemperature: 93, recipe: { coffeeIn: 15, coffeeOut: 33 } },
            { id: 3, name: 'Londinium', phases: [{ type: 1, target: { end: 3 }, stopConditions: { time: 6000 } }],
              globalStopConditions: { weight: 40 }, waterTemperature: 92, recipe: { coffeeIn: 18, coffeeOut: 36 } },
        ],
        pumpCalibration: { bands: [{ cpsRef: 15, valid: true }], lut: [0, 0, 0, 0], lutValid: false },
    };
}

function orderingPair(): { from: TestDoc; to: TestDoc } {
    const from = baseDoc();
    const to = baseDoc();
    setAt(to, ['firmware', 'core'], '9a1b2c3');
    setAt(to, ['defaultProfileId'], 7);
    setAt(to, ['settings', 'boiler', 'steamSetPoint'], 156);
    deleteAt(to, ['settings', 'display', 'lcdBrightness']);
    setAt(to, ['settings', 'webUi', 'dashboardFontSize'], 'large');
    const p4 = to.profiles[0]!;
    p4['name'] = 'Adaptive v2';
    setAt(phasesOf(p4)[1]!, ['target', 'end'], 8);
    p4['waterTemperature'] = 94;
    to.profiles = [p4, { id: 7, name: 'Filter', phases: [] }];
    setAt(to, ['pumpCalibration', 'lutValid'], true);
    setAt(to, ['futureKey'], 1);
    return { from, to };
}

/** Deep copy with every object's keys reversed and the profiles array reversed. */
function reorder(value: unknown, top = true): unknown {
    if (isList(value)) return value.map((item) => reorder(item, false));
    if (!isBag(value)) return value;
    const out: Bag = {};
    for (const [key, child] of Object.entries(value).reverse()) out[key] = reorder(child, false);
    const profiles = out['profiles'];
    if (top && isList(profiles)) out['profiles'] = [...profiles].reverse();
    return out;
}

function deepFreeze(value: unknown): void {
    if (!isBag(value) && !isList(value)) return;
    for (const child of Object.values(value as Bag)) deepFreeze(child);
    Object.freeze(value);
}

/** n nested single-key objects (or arrays), built fresh on every call. */
function deep(n: number, list = false): unknown {
    let value: unknown = 1;
    for (let i = 0; i < n; i += 1) value = list ? [value] : { a: value };
    return value;
}

/** Diff of a mutated copy of baseDoc() against an untouched one. */
function diffAgainstBase(mutate: (to: TestDoc) => void): BackupChange[] {
    const to = baseDoc();
    mutate(to);
    return diffMachineBackups(baseDoc(), to);
}

function pathOf(change: BackupChange | undefined): readonly string[] {
    return change !== undefined && 'path' in change ? change.path : [];
}

const ORDERED: BackupChange[] = [
    { kind: 'firmware', path: ['core'], ...changed('8aaf6f0', '9a1b2c3') },
    { kind: 'defaultProfile', from: { id: 4, name: 'Adaptive' }, to: { id: 7, name: 'Filter' } },
    { kind: 'setting', path: ['boiler', 'steamSetPoint'], ...changed(155, 156) },
    { kind: 'setting', path: ['display', 'lcdBrightness'], ...removed(70) },
    { kind: 'setting', path: ['webUi', 'dashboardFontSize'], ...added('large') },
    { kind: 'profileRemoved', profile: { id: 3, name: 'Londinium' } },
    { kind: 'profileRenamed', profile: { id: 4, name: 'Adaptive v2' }, from: 'Adaptive', to: 'Adaptive v2' },
    { kind: 'profilePhase', profile: { id: 4, name: 'Adaptive v2' }, phase: 2, ...changed(PHASE_2, PHASE_2_END_8) },
    { kind: 'profileField', profile: { id: 4, name: 'Adaptive v2' }, path: ['waterTemperature'], ...changed(93, 94) },
    { kind: 'profileAdded', profile: { id: 7, name: 'Filter' } },
    { kind: 'pumpCalibration', change: 'changed' },
    { kind: 'other', key: 'futureKey', ...added(1) },
];

type Case = readonly [name: string, mutate: (to: TestDoc) => void, expected: BackupChange[]];

function runCases(cases: readonly Case[]): void {
    for (const [name, mutate, expected] of cases) it(name, () => expect(diffAgainstBase(mutate)).toStrictEqual(expected));
}

const P4 = { id: 4, name: 'Adaptive' };
const P4_V2 = { id: 4, name: 'Adaptive v2' };
const P3 = { id: 3, name: 'Londinium' };
const PHASE_1 = { type: 0, target: { end: 7 }, stopConditions: { time: 20000 } };
const P3_PHASE_1 = { type: 1, target: { end: 3 }, stopConditions: { time: 6000 } };

const FIRMWARE_CASES: Case[] = [
    ['removes a firmware leaf', (to) => deleteAt(to, ['firmware', 'frontend']),
        [{ kind: 'firmware', path: ['frontend'], ...removed('8aaf6f0') }]],
    ['sorts an added firmware key before a changed one', (to) => {
        setAt(to, ['firmware', 'board'], 'x');
        setAt(to, ['firmware', 'core'], '9a1b2c3');
    }, [{ kind: 'firmware', path: ['board'], ...added('x') },
        { kind: 'firmware', path: ['core'], ...changed('8aaf6f0', '9a1b2c3') }]],
    ['resolves the default profile name on both sides', (to) => setAt(to, ['defaultProfileId'], 3),
        [{ kind: 'defaultProfile', from: P4, to: P3 }]],
    ['reports an unknown default profile without a name', (to) => setAt(to, ['defaultProfileId'], 99),
        [{ kind: 'defaultProfile', from: P4, to: { id: 99, name: null } }]],
    ['reports a missing default profile id as null', (to) => deleteAt(to, ['defaultProfileId']),
        [{ kind: 'defaultProfile', from: P4, to: { id: null, name: null } }]],
];

const SETTINGS_CASES: Case[] = [
    ['walks a nested leaf', (to) => setAt(to, ['settings', 'led', 'color', 'R'], 200),
        [{ kind: 'setting', path: ['led', 'color', 'R'], ...changed(255, 200) }]],
    ['compares an array as a whole value', (to) => setAt(to, ['settings', 'system', 'pumpSpec'], [0, 0, 1, 0]),
        [{ kind: 'setting', path: ['system', 'pumpSpec'], ...changed([0, 0, 0, 0], [0, 0, 1, 0]) }]],
    ['keeps types strict', (to) => setAt(to, ['settings', 'boiler', 'brewDeltaState'], 'true'),
        [{ kind: 'setting', path: ['boiler', 'brewDeltaState'], ...changed(true, 'true') }]],
    ['walks a new category leaf by leaf', (to) => {
        setAt(to, ['settings', 'scales'], { btScalesEnabled: true, forcePredictive: false });
        setAt(to, ['settings', 'led', 'state'], false);
        setAt(to, ['settings', 'system', 'releaseChannel'], 1);
    }, [{ kind: 'setting', path: ['led', 'state'], ...changed(true, false) },
        { kind: 'setting', path: ['scales', 'btScalesEnabled'], ...added(true) },
        { kind: 'setting', path: ['scales', 'forcePredictive'], ...added(false) },
        { kind: 'setting', path: ['system', 'releaseChannel'], ...changed(0, 1) }]],
    ['reports a removed category', (to) => deleteAt(to, ['settings', 'webUi']),
        [{ kind: 'setting', path: ['webUi', 'themeId'], ...removed('espresso') }]],
    ['reports an object replaced by a scalar', (to) => setAt(to, ['settings', 'led', 'color'], 'red'),
        [{ kind: 'setting', path: ['led', 'color'], ...added('red') },
            { kind: 'setting', path: ['led', 'color', 'B'], ...removed(0) },
            { kind: 'setting', path: ['led', 'color', 'G'], ...removed(63) },
            { kind: 'setting', path: ['led', 'color', 'R'], ...removed(255) }]],
    ['treats an empty category and a missing one the same', (to) => setAt(to, ['settings', 'theme'], {}), []],
    ['sorts keys by code unit, not by locale', (to) => {
        setAt(to, ['settings', 'boiler', 'beta'], 1);
        setAt(to, ['settings', 'boiler', 'Zeta'], 2);
        setAt(to, ['settings', 'boiler', 'alpha'], 3);
    }, [{ kind: 'setting', path: ['boiler', 'Zeta'], ...added(2) },
        { kind: 'setting', path: ['boiler', 'alpha'], ...added(3) },
        { kind: 'setting', path: ['boiler', 'beta'], ...added(1) }]],
];

const PROFILE_CASES: Case[] = [
    ['ignores the order of the profiles array', (to) => (to.profiles = [to.profiles[1]!, to.profiles[0]!]), []],
    ['matches a renamed and moved profile by id', (to) => {
        const p4 = to.profiles[0]!;
        p4['name'] = 'Adaptive v2';
        to.profiles = [to.profiles[1]!, p4];
    }, [{ kind: 'profileRenamed', profile: P4_V2, from: 'Adaptive', to: 'Adaptive v2' }]],
    ['reports a non-string name as null and keeps the known name', (to) => (to.profiles[0]!['name'] = 5),
        [{ kind: 'profileRenamed', profile: P4, from: 'Adaptive', to: null }]],
    ['removes a dropped trailing phase', (to) => (to.profiles[0]!['phases'] = [phasesOf(to.profiles[0]!)[0]!]),
        [{ kind: 'profilePhase', profile: P4, phase: 2, ...removed(PHASE_2) }]],
    ['adds an appended phase', (to) => {
        const p3 = to.profiles[1]!;
        p3['phases'] = [...phasesOf(p3), { type: 2, target: { end: 1 }, stopConditions: { time: 1000 } }];
    }, [{ kind: 'profilePhase', profile: P3, phase: 2, ...added({ type: 2, target: { end: 1 }, stopConditions: { time: 1000 } }) }]],
    ['shows a front-inserted phase as changed plus added', (to) => {
        const p3 = to.profiles[1]!;
        p3['phases'] = [{ type: 0, target: { end: 5 }, stopConditions: { time: 1000 } }, ...phasesOf(p3)];
    }, [{ kind: 'profilePhase', profile: P3, phase: 1, ...changed(P3_PHASE_1, { type: 0, target: { end: 5 }, stopConditions: { time: 1000 } }) },
        { kind: 'profilePhase', profile: P3, phase: 2, ...added(P3_PHASE_1) }]],
    ['walks profile fields like settings', (to) => {
        const p4 = to.profiles[0]!;
        setAt(p4, ['recipe', 'coffeeIn'], 16);
        p4['notes'] = 'x';
        setAt(p4, ['globalStopConditions', 'weight'], 38);
    }, [{ kind: 'profileField', profile: P4, path: ['globalStopConditions', 'weight'], ...changed(37, 38) },
        { kind: 'profileField', profile: P4, path: ['notes'], ...added('x') },
        { kind: 'profileField', profile: P4, path: ['recipe', 'coffeeIn'], ...changed(15, 16) }]],
    ['keeps number and string ids apart', (to) => (to.profiles[0]!['id'] = '4'),
        [{ kind: 'profileRemoved', profile: P4 }, { kind: 'profileAdded', profile: { id: '4', name: 'Adaptive' } }]],
    ['ignores unusable entries and later duplicates', (to) => setAt(to, ['profiles'], [
        null, 5, 'x', [], { name: 'no id' }, { id: true }, { id: Number.POSITIVE_INFINITY },
        baseDoc().profiles[0]!, { id: 4, name: 'dup' },
    ]), [{ kind: 'profileRemoved', profile: P3 }]],
    ['treats non-array phases as empty', (to) => setAt(to.profiles[0]!, ['phases'], 'x'),
        [{ kind: 'profilePhase', profile: P4, phase: 1, ...removed(PHASE_1) },
            { kind: 'profilePhase', profile: P4, phase: 2, ...removed(PHASE_2) }]],
];

describe('diffMachineBackups', () => {
    it('lists every kind of change in the fixed order', () => {
        const { from, to } = orderingPair();
        expect(diffMachineBackups(from, to)).toStrictEqual(ORDERED);
    });
    it('is deterministic and ignores key and profile order', () => {
        const { from, to } = orderingPair();
        expect(diffMachineBackups(from, to)).toStrictEqual(ORDERED);
        expect(diffMachineBackups(reorder(from) as BackupDocument, reorder(to) as BackupDocument)).toStrictEqual(ORDERED);
        const doc = baseDoc();
        expect(diffMachineBackups(doc, doc)).toStrictEqual([]);
        expect(diffMachineBackups(baseDoc(), reorder(baseDoc()) as BackupDocument)).toStrictEqual([]);
    });
    it('does not mutate its inputs', () => {
        const { from, to } = orderingPair();
        const before = JSON.stringify({ from, to });
        deepFreeze(from);
        deepFreeze(to);
        expect(() => diffMachineBackups(from, to)).not.toThrow();
        expect(JSON.stringify({ from, to })).toBe(before);
    });
});

describe('firmware and default profile', () => {
    runCases(FIRMWARE_CASES);
});
describe('settings', () => {
    runCases(SETTINGS_CASES);
});
describe('profiles', () => {
    runCases(PROFILE_CASES);
});

describe('secrets are never reported', () => {
    function withSecrets(tag: string): TestDoc {
        const doc = baseDoc();
        setAt(doc, ['wifi'], { ssid: `SECRET-ssid-${tag}`, password: `SECRET-wifi-${tag}` });
        setAt(doc, ['settings', 'system'], {
            ...(doc.settings['system'] as Bag),
            mqttUsername: `SECRET-user-${tag}`,
            mqttPassword: `SECRET-pass-${tag}`,
            visualizerToken: `SECRET-vis-${tag}`,
            sprofilerToken: `SECRET-spro-${tag}`,
        });
        return doc;
    }
    it('drops wifi and the four settings secrets, whatever their shape', () => {
        const from = withSecrets('a');
        const to = withSecrets('b');
        deleteAt(to, ['settings', 'system', 'mqttPassword']);
        setAt(to, ['settings', 'system', 'sprofilerToken'], { nested: 'SECRET-nested-b' });
        const results = [diffMachineBackups(from, to), diffMachineBackups(baseDoc(), from), diffMachineBackups(to, baseDoc())];
        for (const result of results) {
            expect(result).toStrictEqual([]);
            expect(JSON.stringify(result)).not.toContain('SECRET-');
        }
    });
});

describe('pump calibration and other keys', () => {
    it('compares the pump calibration as one value', () => {
        expect(diffAgainstBase((to) => setAt(to, ['pumpCalibration', 'lut'], [0, 0, 0, 1]))).toStrictEqual([
            { kind: 'pumpCalibration', change: 'changed' },
        ]);
        expect(diffAgainstBase((to) => deleteAt(to, ['pumpCalibration']))).toStrictEqual([
            { kind: 'pumpCalibration', change: 'removed' },
        ]);
    });
    it('reports unknown top-level keys as other, sorted by name', () => {
        expect(diffAgainstBase((to) => setAt(to, ['version'], 2))).toStrictEqual([{ kind: 'other', key: 'version', ...changed(1, 2) }]);
        expect(diffAgainstBase((to) => {
            setAt(to, ['b'], 2);
            setAt(to, ['a'], 1);
        })).toStrictEqual([{ kind: 'other', key: 'a', ...added(1) }, { kind: 'other', key: 'b', ...added(2) }]);
    });
    it('never reports a differing wifi block', () => {
        expect(diffAgainstBase((to) => setAt(to, ['wifi'], { ssid: 'x' }))).toStrictEqual([]);
    });
});

describe('malformed and partial documents', () => {
    const EMPTY_INPUTS: unknown[] = [null, undefined, 42, 'x', [], {}];
    const ADDED_KINDS = ['firmware', 'firmware', 'defaultProfile', ...Array.from({ length: 12 }, () => 'setting'), 'profileAdded', 'profileAdded', 'pumpCalibration', 'other', 'other'];
    const TAILS = {
        forward: [
            { kind: 'profileAdded', profile: P3 },
            { kind: 'profileAdded', profile: P4 },
            { kind: 'pumpCalibration', change: 'added' },
            { kind: 'other', key: 'format', ...added('gaggiuino-settings') },
            { kind: 'other', key: 'version', ...added(1) },
        ],
        backward: [
            { kind: 'profileRemoved', profile: P3 },
            { kind: 'profileRemoved', profile: P4 },
            { kind: 'pumpCalibration', change: 'removed' },
            { kind: 'other', key: 'format', ...removed('gaggiuino-settings') },
            { kind: 'other', key: 'version', ...removed(1) },
        ],
    } satisfies Record<string, BackupChange[]>;

    it('treats every non-object document as empty', () => {
        const base = baseDoc();
        for (const empty of EMPTY_INPUTS) {
            const doc = empty as BackupDocument;
            expect(diffMachineBackups(doc, doc)).toStrictEqual([]);

            const forward = diffMachineBackups(doc, base);
            expect(forward).toHaveLength(20);
            expect(forward.every((c) => !('change' in c) || c.change === 'added')).toBe(true);
            expect(forward.map((c) => c.kind)).toStrictEqual(ADDED_KINDS);
            expect(forward[2]).toStrictEqual({ kind: 'defaultProfile', from: { id: null, name: null }, to: P4 });
            expect(forward.slice(-5)).toStrictEqual(TAILS.forward);

            const backward = diffMachineBackups(base, doc);
            expect(backward).toHaveLength(20);
            expect(backward.every((c) => !('change' in c) || c.change === 'removed')).toBe(true);
            expect(backward.map((c) => c.kind)).toStrictEqual(ADDED_KINDS.map((k) => (k === 'profileAdded' ? 'profileRemoved' : k)));
            expect(backward.slice(-5)).toStrictEqual(TAILS.backward);
        }
    });

    it('treats broken sections as empty', () => {
        expect(diffAgainstBase((to) => {
            setAt(to, ['settings'], 'x');
            setAt(to, ['profiles'], { id: 4 });
            setAt(to, ['firmware'], []);
            deleteAt(to, ['pumpCalibration']);
        })).toStrictEqual([
            { kind: 'firmware', path: ['core'], ...removed('8aaf6f0') },
            { kind: 'firmware', path: ['frontend'], ...removed('8aaf6f0') },
            { kind: 'setting', path: ['boiler', 'brewDeltaState'], ...removed(true) },
            { kind: 'setting', path: ['boiler', 'offsetTemp'], ...removed(7) },
            { kind: 'setting', path: ['boiler', 'steamSetPoint'], ...removed(155) },
            { kind: 'setting', path: ['display', 'lcdBrightness'], ...removed(70) },
            { kind: 'setting', path: ['led', 'color', 'B'], ...removed(0) },
            { kind: 'setting', path: ['led', 'color', 'G'], ...removed(63) },
            { kind: 'setting', path: ['led', 'color', 'R'], ...removed(255) },
            { kind: 'setting', path: ['led', 'state'], ...removed(true) },
            { kind: 'setting', path: ['system', 'machineName'], ...removed('Test machine') },
            { kind: 'setting', path: ['system', 'pumpSpec'], ...removed([0, 0, 0, 0]) },
            { kind: 'setting', path: ['system', 'releaseChannel'], ...removed(0) },
            { kind: 'setting', path: ['webUi', 'themeId'], ...removed('espresso') },
            { kind: 'profileRemoved', profile: P3 },
            { kind: 'profileRemoved', profile: P4 },
            { kind: 'pumpCalibration', change: 'removed' },
        ]);
    });
});

describe('hostile input', () => {
    // An object literal { __proto__: ... } sets the prototype, so the hostile
    // documents come from JSON.parse: only that creates a real own key.
    const HOSTILE_FROM = '{"format":"gaggiuino-settings","version":1,"settings":{"boiler":{"constructor":1}},"profiles":[{"id":"__proto__","name":"p"}]}';
    const HOSTILE_TO = '{"format":"gaggiuino-settings","version":1,"__proto__":{"polluted":true},"settings":{"__proto__":{"polluted":true},"boiler":{"toString":2,"hasOwnProperty":3}},"profiles":[{"id":"__proto__","name":"q","__proto__":{"polluted":true}},{"id":"constructor","name":"c"}]}';

    it('reads own keys only and never pollutes prototypes', () => {
        const changes = diffMachineBackups(JSON.parse(HOSTILE_FROM) as BackupDocument, JSON.parse(HOSTILE_TO) as BackupDocument);
        expect(changes).toStrictEqual([
            { kind: 'setting', path: ['__proto__', 'polluted'], ...added(true) },
            { kind: 'setting', path: ['boiler', 'constructor'], ...removed(1) },
            { kind: 'setting', path: ['boiler', 'hasOwnProperty'], ...added(3) },
            { kind: 'setting', path: ['boiler', 'toString'], ...added(2) },
            { kind: 'profileRenamed', profile: { id: '__proto__', name: 'q' }, from: 'p', to: 'q' },
            { kind: 'profileField', profile: { id: '__proto__', name: 'q' }, path: ['__proto__', 'polluted'], ...added(true) },
            { kind: 'profileAdded', profile: { id: 'constructor', name: 'c' } },
            { kind: 'other', key: '__proto__', ...added({ polluted: true }) },
        ]);
        expect(({} as Bag)['polluted']).toBeUndefined();
        expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
        for (const change of changes) expect(Object.getPrototypeOf(change)).toBe(Object.prototype);
    });

    it('caps the depth instead of overflowing the stack', () => {
        const from = baseDoc();
        const to = baseDoc();
        setAt(from, ['settings', 'boiler', 'deep'], deep(10000));
        setAt(to, ['settings', 'boiler', 'deep'], deep(10000));
        const changes = diffMachineBackups(from, to);
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ kind: 'setting', change: 'changed' });
        const path = pathOf(changes[0]);
        expect(path).toHaveLength(MAX_DIFF_DEPTH - 1);
        expect(path.slice(0, 3)).toStrictEqual(['boiler', 'deep', 'a']);

        const listFrom = baseDoc();
        const listTo = baseDoc();
        setAt(listFrom, ['settings', 'boiler', 'list'], deep(10000, true));
        setAt(listTo, ['settings', 'boiler', 'list'], deep(10000, true));
        const leaf = diffMachineBackups(listFrom, listTo);
        expect(leaf).toHaveLength(1);
        expect(leaf[0]).toMatchObject({ kind: 'setting', path: ['boiler', 'list'], change: 'changed' });
    });

    it('caps the depth inside a phase and inside an unknown key', () => {
        const from = baseDoc();
        const to = baseDoc();
        phasesOf(from.profiles[0]!)[0] = deep(10000) as Bag;
        phasesOf(to.profiles[0]!)[0] = deep(10000) as Bag;
        setAt(from, ['future'], deep(10000));
        setAt(to, ['future'], deep(10000));
        const changes = diffMachineBackups(from, to);
        expect(changes).toHaveLength(2);
        expect(changes[0]).toMatchObject({ kind: 'profilePhase', profile: P4, phase: 1, change: 'changed' });
        expect(changes[1]).toMatchObject({ kind: 'other', key: 'future', change: 'changed' });
    });

    it('handles cyclic documents', () => {
        const loop = (): Bag => {
            const node: Bag = {};
            node['self'] = node;
            return node;
        };
        const from = baseDoc();
        const to = baseDoc();
        setAt(from, ['settings', 'boiler', 'loop'], loop());
        setAt(to, ['settings', 'boiler', 'loop'], loop());
        const changes = diffMachineBackups(from, to);
        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ kind: 'setting', change: 'changed' });
        expect(pathOf(changes[0]).slice(0, 2)).toStrictEqual(['boiler', 'loop']);

        const shared = baseDoc();
        const other = baseDoc();
        const same = loop();
        setAt(shared, ['settings', 'boiler', 'loop'], same);
        setAt(other, ['settings', 'boiler', 'loop'], same);
        expect(diffMachineBackups(shared, other)).toStrictEqual([]);
    });
});

it('stays a pure module', () => {
    const source = readFileSync(new URL('../public-src/shared/machine-backup-diff.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
});
