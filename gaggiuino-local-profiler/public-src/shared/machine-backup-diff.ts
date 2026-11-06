// Compare engine for two stored Gaggiuino settings backups (#1878). Pure and
// deterministic: it takes JSON-shaped documents, never throws, never mutates
// its inputs and never touches Object.prototype. It only lists differences
// with their raw key paths; the compare view (U3) turns them into translated
// sentences, humanised setting names and the curated labels with units
// (PLAN-1878.md decision 6). No imports: no DOM, no i18n, no API types.

/** Containers at this depth (counted from the document root, `settings` = 1) are not walked: they
 *  are compared as one value, and two values at the cap are equal only when identical (fail safe). */
export const MAX_DIFF_DEPTH = 32;

/** The secret-free gaggiuino-settings document as GET /api/machine/backups/{id} returns it.
 *  Every field is optional and unchecked; the engine validates while it walks. */
export interface BackupDocument {
  readonly [key: string]: unknown;
  readonly format?: unknown; // "gaggiuino-settings"
  readonly version?: unknown; // 1
  readonly firmware?: unknown; // { core: string, frontend: string }
  readonly defaultProfileId?: unknown; // a profile id
  readonly settings?: unknown; // { <category>: { <key>: value | { ... } } }
  readonly profiles?: unknown; // [{ id, name, phases: [...], <field>: value | { ... } }]
  readonly pumpCalibration?: unknown; // compared as one value
}

export type LeafChange = 'changed' | 'added' | 'removed';

/** A key path below its section, never empty, e.g. ['boiler', 'steamSetPoint'] under settings
 *  or ['recipe', 'coffeeIn'] under a profile. U3 maps it to a label; keys are raw, never humanised. */
export type KeyPath = readonly [string, ...string[]];

export interface ProfileRef {
  /** The profile id as stored; null when missing or neither a finite number nor a string. */
  readonly id: number | string | null;
  /** null when that document has no such profile or its name is not a string. */
  readonly name: string | null;
}

/** `from` is absent for 'added', `to` is absent for 'removed' (never set to undefined).
 *  Values are the raw JSON values; null is a real JSON null. */
export interface ValueChange {
  readonly change: LeafChange;
  readonly from?: unknown;
  readonly to?: unknown;
}

export type BackupChange =
  | ({ readonly kind: 'firmware'; readonly path: KeyPath } & ValueChange)
  | { readonly kind: 'defaultProfile'; readonly from: ProfileRef; readonly to: ProfileRef }
  | ({ readonly kind: 'setting'; readonly path: KeyPath } & ValueChange) // path[0] is the category
  | { readonly kind: 'profileAdded'; readonly profile: ProfileRef }
  | { readonly kind: 'profileRemoved'; readonly profile: ProfileRef }
  | { readonly kind: 'profileRenamed'; readonly profile: ProfileRef; readonly from: string | null; readonly to: string | null }
  | ({ readonly kind: 'profilePhase'; readonly profile: ProfileRef; readonly phase: number } & ValueChange) // 1-based
  | ({ readonly kind: 'profileField'; readonly profile: ProfileRef; readonly path: KeyPath } & ValueChange)
  | { readonly kind: 'pumpCalibration'; readonly change: LeafChange }
  | ({ readonly kind: 'other'; readonly key: string } & ValueChange);

type Bag = Record<string, unknown>;

/** A plain JSON object: not null, not an array. Arrays are containers too, but compared whole. */
function isPlainObject(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Array.isArray() narrows to any[], which would make every element read an
// unsafe-any access; this keeps the elements unknown.
function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isKeyPath(path: readonly string[]): path is KeyPath {
  return path.length > 0;
}

/** The own value only: an inherited key counts as missing, never as a read. */
function own(o: Bag, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Code-unit order, element by element, a shorter prefix first; never locale-aware. */
function comparePaths(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const [left, right] = [a[i], b[i]];
    if (left !== undefined && right !== undefined && left !== right) return left < right ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function deepEqual(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  // Fail safe: a value the walk did not look at is never "equal".
  if (depth >= MAX_DIFF_DEPTH) return false;
  if (isList(a)) return isList(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i], depth + 1));
  if (isList(b) || !isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k], depth + 1));
}

type Leaf = { readonly path: readonly string[]; readonly value: unknown };

function flatten(value: unknown, depth: number, prefix: readonly string[], out: Map<string, Leaf>): void {
  if (isPlainObject(value) && depth < MAX_DIFF_DEPTH) {
    for (const [key, child] of Object.entries(value)) flatten(child, depth + 1, [...prefix, key], out);
    return;
  }
  // The section value itself is never a leaf, so an empty or non-object section yields none either.
  if (prefix.length > 0) out.set(JSON.stringify(prefix), { path: prefix, value });
}

type LeafDiff = { readonly path: KeyPath; readonly change: LeafChange; readonly from?: unknown; readonly to?: unknown };

/** One leaf diff for `firmware`, `settings` or a profile's own fields; `skip` drops a path. */
function diffSectionLeaves(
  fromSection: unknown,
  toSection: unknown,
  sectionDepth: number,
  skip: (path: readonly string[]) => boolean = () => false,
): LeafDiff[] {
  const fromLeaves = new Map<string, Leaf>();
  const toLeaves = new Map<string, Leaf>();
  flatten(fromSection, sectionDepth, [], fromLeaves);
  flatten(toSection, sectionDepth, [], toLeaves);
  const changes: LeafDiff[] = [];
  for (const key of new Set([...fromLeaves.keys(), ...toLeaves.keys()])) {
    const before = fromLeaves.get(key);
    const after = toLeaves.get(key);
    const path = (after ?? before)?.path;
    if (path === undefined || !isKeyPath(path) || skip(path)) continue;
    if (before === undefined && after !== undefined) changes.push({ path, change: 'added', to: after.value });
    else if (before !== undefined && after === undefined) changes.push({ path, change: 'removed', from: before.value });
    else if (before !== undefined && after !== undefined && !deepEqual(before.value, after.value, sectionDepth + path.length)) {
      changes.push({ path, change: 'changed', from: before.value, to: after.value });
    }
  }
  return changes.sort((a, b) => comparePaths(a.path, b.path));
}

/** `from` is only set for 'removed'/'changed', `to` only for 'added'/'changed'. */
function valueChange(leaf: LeafDiff): ValueChange {
  const from = Object.hasOwn(leaf, 'from') ? { from: leaf.from } : {};
  return { change: leaf.change, ...from, ...(Object.hasOwn(leaf, 'to') ? { to: leaf.to } : {}) };
}

/** 'added'/'removed' by own-key presence, otherwise 'changed'. */
function presenceChange(before: Bag, after: Bag, key: string): LeafChange {
  if (!Object.hasOwn(before, key)) return 'added';
  return Object.hasOwn(after, key) ? 'changed' : 'removed';
}

// Keep in step with secretPaths in go/internal/machinebackups/backups.go: a
// stored document never carries these values, and the engine never shows one
// even if a document slips through. The whole top-level `wifi` block is a
// secret too, so `other` never reports it.
const SECRET_SETTING_KEYS = new Set(['mqttUsername', 'mqttPassword', 'visualizerToken', 'sprofilerToken']);
const HANDLED_TOP_LEVEL = new Set(['firmware', 'defaultProfileId', 'settings', 'profiles', 'pumpCalibration', 'wifi']);
const PROFILE_META_KEYS = new Set(['id', 'name', 'phases']);

const isSecretSetting = (p: readonly string[]): boolean =>
  p[0] === 'system' && p[1] !== undefined && SECRET_SETTING_KEYS.has(p[1]);

const isProfileMeta = (p: readonly string[]): boolean =>
  p.length === 1 && p[0] !== undefined && PROFILE_META_KEYS.has(p[0]);

type ProfileEntry = { readonly id: number | string; readonly profile: Bag };

function isProfileId(value: unknown): value is number | string {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

const profileKey = (id: number | string): string => `${typeof id}:${String(id)}`;

/** Index of the usable profile entries; the first entry for an id wins, the rest is ignored. */
function indexProfiles(doc: Bag): Map<string, ProfileEntry> {
  const index = new Map<string, ProfileEntry>();
  const profiles = own(doc, 'profiles');
  if (!isList(profiles)) return index;
  for (const entry of profiles) {
    if (!isPlainObject(entry) || !Object.hasOwn(entry, 'id')) continue;
    const id = entry['id'];
    if (!isProfileId(id) || index.has(profileKey(id))) continue;
    index.set(profileKey(id), { id, profile: entry });
  }
  return index;
}

function profileName(profile: Bag | undefined): string | null {
  const name = profile === undefined ? undefined : own(profile, 'name');
  return typeof name === 'string' ? name : null;
}

function defaultProfileRef(doc: Bag, index: Map<string, ProfileEntry>): ProfileRef {
  const id = own(doc, 'defaultProfileId');
  if (!isProfileId(id)) return { id: null, name: null };
  const entry = index.get(profileKey(id));
  return { id, name: entry === undefined ? null : profileName(entry.profile) };
}

/** Number ids ascending, then string ids by code unit; `4` and `"4"` are different profiles. */
function compareProfileIds(a: number | string, b: number | string): number {
  if (typeof a === 'number') return typeof b === 'string' ? -1 : a < b ? -1 : a > b ? 1 : 0;
  return typeof b === 'number' ? 1 : compareStrings(a, b);
}

const phasesOf = (profile: Bag): readonly unknown[] => {
  const phases = own(profile, 'phases');
  return isList(phases) ? phases : [];
};

function diffProfiles(beforeIndex: Map<string, ProfileEntry>, afterIndex: Map<string, ProfileEntry>): BackupChange[] {
  type Pair = { readonly id: number | string; readonly before?: ProfileEntry; readonly after?: ProfileEntry };
  const pairs: Pair[] = [];
  for (const key of new Set([...beforeIndex.keys(), ...afterIndex.keys()])) {
    const before = beforeIndex.get(key);
    const after = afterIndex.get(key);
    const id = after?.id ?? before?.id;
    if (id === undefined) continue;
    pairs.push({ id, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
  }
  pairs.sort((a, b) => compareProfileIds(a.id, b.id));

  const changes: BackupChange[] = [];
  for (const { id, before, after } of pairs) {
    if (before === undefined) {
      if (after !== undefined) changes.push({ kind: 'profileAdded', profile: { id, name: profileName(after.profile) } });
      continue;
    }
    if (after === undefined) {
      changes.push({ kind: 'profileRemoved', profile: { id, name: profileName(before.profile) } });
      continue;
    }
    const beforeName = profileName(before.profile);
    const afterName = profileName(after.profile);
    const profile: ProfileRef = { id, name: afterName ?? beforeName };
    if (beforeName !== afterName) changes.push({ kind: 'profileRenamed', profile, from: beforeName, to: afterName });
    const beforePhases = phasesOf(before.profile);
    const afterPhases = phasesOf(after.profile);
    // Index-wise, 1-based: an inserted phase shows as changed phases plus one added at the end.
    for (let i = 0; i < Math.max(beforePhases.length, afterPhases.length); i += 1) {
      const phase = i + 1;
      const [phaseBefore, phaseAfter] = [beforePhases[i], afterPhases[i]];
      if (i >= beforePhases.length) changes.push({ kind: 'profilePhase', profile, phase, change: 'added', to: phaseAfter });
      else if (i >= afterPhases.length) changes.push({ kind: 'profilePhase', profile, phase, change: 'removed', from: phaseBefore });
      else if (!deepEqual(phaseBefore, phaseAfter, 4)) {
        changes.push({ kind: 'profilePhase', profile, phase, change: 'changed', from: phaseBefore, to: phaseAfter });
      }
    }
    for (const leaf of diffSectionLeaves(before.profile, after.profile, 2, isProfileMeta)) {
      changes.push({ kind: 'profileField', profile, path: leaf.path, ...valueChange(leaf) });
    }
  }
  return changes;
}

function diffOther(before: Bag, after: Bag): BackupChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !HANDLED_TOP_LEVEL.has(key))
    .sort(compareStrings);
  const changes: BackupChange[] = [];
  for (const key of keys) {
    if (!Object.hasOwn(before, key)) changes.push({ kind: 'other', key, change: 'added', to: own(after, key) });
    else if (!Object.hasOwn(after, key)) changes.push({ kind: 'other', key, change: 'removed', from: own(before, key) });
    else if (!deepEqual(own(before, key), own(after, key), 1)) {
      changes.push({ kind: 'other', key, change: 'changed', from: own(before, key), to: own(after, key) });
    }
  }
  return changes;
}

/** Differences from `from` (the older backup) to `to` (the newer one), in a fixed order. */
export function diffMachineBackups(
  from: BackupDocument | null | undefined,
  to: BackupDocument | null | undefined,
): BackupChange[] {
  const before: Bag = isPlainObject(from) ? from : {};
  const after: Bag = isPlainObject(to) ? to : {};
  const beforeProfiles = indexProfiles(before);
  const afterProfiles = indexProfiles(after);
  const changes: BackupChange[] = [];

  for (const leaf of diffSectionLeaves(own(before, 'firmware'), own(after, 'firmware'), 1)) {
    changes.push({ kind: 'firmware', path: leaf.path, ...valueChange(leaf) });
  }
  if (!deepEqual(own(before, 'defaultProfileId'), own(after, 'defaultProfileId'), 1)) {
    changes.push({ kind: 'defaultProfile', from: defaultProfileRef(before, beforeProfiles), to: defaultProfileRef(after, afterProfiles) });
  }
  for (const leaf of diffSectionLeaves(own(before, 'settings'), own(after, 'settings'), 1, isSecretSetting)) {
    changes.push({ kind: 'setting', path: leaf.path, ...valueChange(leaf) });
  }
  changes.push(...diffProfiles(beforeProfiles, afterProfiles));
  if (!deepEqual(own(before, 'pumpCalibration'), own(after, 'pumpCalibration'), 1)) {
    changes.push({ kind: 'pumpCalibration', change: presenceChange(before, after, 'pumpCalibration') });
  }
  changes.push(...diffOther(before, after));
  return changes;
}
