import { describe, it, expect } from 'vitest';
import {
  MAX_DERIVED_ROWS,
  MAX_PINNED_PROFILES,
  MIN_AVG_RATING,
  MIN_RATED_SHOTS,
  isSimilarBean,
  pinnedProfilesOf,
  profileKey,
  provenProfilesForBean,
  shotProfileName,
  suggestProfilesForBean,
  togglePinnedProfile,
} from '../public-src/shared/bean-profiles.js';
import type {
  PinnedProfile,
  ProfileBean,
  ProfileContext,
  ProfileShot,
} from '../public-src/shared/bean-profiles.js';

// #1963 slice 2: the pure module behind the bean detail sheet. Every case here
// pins one product default from the plan: the proven bar, the ranking, the
// pin toggling, the similarity table, and that more history or a pin on a
// similar bean each changes the suggestion while thin evidence gives none.
let _seq = 0;
const ts = (): number => 1_700_000_000 + ++_seq;

// Every field is spelled `| undefined`: the helpers spread a partial spec into
// an object literal, which exactOptionalPropertyTypes otherwise rejects.
interface ShotSpec {
  beanId?: number | undefined;
  coffee?: string | null | undefined;
  profile?: string | undefined;
  flat?: string | undefined;
  rating?: number | string | null | undefined;
  machineId?: number | null | undefined;
  timestamp?: number | undefined;
  mixed?: boolean | undefined;
}

function shot(spec: ShotSpec = {}): ProfileShot {
  const annotation: NonNullable<ProfileShot['annotation']> = {};
  if (spec.beanId !== undefined) annotation.beanId = spec.beanId;
  if (spec.coffee !== undefined) annotation.coffee = spec.coffee;
  if (spec.rating !== undefined) annotation.rating = spec.rating;
  if (spec.mixed) {
    annotation.beanMix = [
      { coffee: 'Bean 1', grams: 10 },
      { coffee: 'Bean 2', grams: 8 },
    ];
  }
  const out: ProfileShot = { timestamp: spec.timestamp ?? ts(), annotation };
  if (spec.machineId !== undefined) out.machineId = spec.machineId;
  if (spec.profile !== undefined) out.profile = { name: spec.profile };
  if (spec.flat !== undefined) out.profileName = spec.flat;
  return out;
}

function bean(id: number, over: Partial<Omit<ProfileBean, 'id'>> = {}): ProfileBean {
  return { id, name: `Bean ${id}`, ...over };
}

interface ContextOverrides {
  machineId?: number | null | undefined;
  availableNames?: ReadonlySet<string> | null | undefined;
}

function context(
  shots: ProfileShot[],
  beans: ProfileBean[],
  over: ContextOverrides = {},
): ProfileContext {
  const ctx: ProfileContext = { shots, beans, machineId: over.machineId ?? null };
  if (over.availableNames !== undefined) ctx.availableNames = over.availableNames;
  return ctx;
}

/** One rated shot of `profile` for the bean per entry in `ratings`. */
function rated(
  beanId: number,
  profile: string,
  ratings: number[],
  machineId = 1,
  over: ShotSpec = {},
): ProfileShot[] {
  return ratings.map(rating => shot({ beanId, profile, rating, machineId, ...over }));
}

const LONDINIUM = bean(1, { name: 'Londinium', roastLevel: 'medium', process: 'Washed' });

describe('profile naming helpers', () => {
  it('keys a profile by machine and trimmed lower-cased name', () => {
    expect(profileKey(1, '  Blooming ')).toBe('1:blooming');
    expect(profileKey(2, 'Blooming')).not.toBe(profileKey(1, 'Blooming'));
  });

  it('prefers profile.name over the flat profileName', () => {
    expect(shotProfileName(shot({ profile: ' Blooming ', flat: 'Flat' }))).toBe('Blooming');
    expect(shotProfileName(shot({ flat: ' Flat ' }))).toBe('Flat');
    expect(shotProfileName(shot({ profile: '   ', flat: 'Flat' }))).toBe('Flat');
    expect(shotProfileName(shot({ profile: '   ' }))).toBe('');
    expect(shotProfileName({ timestamp: 1 })).toBe('');
  });
});

describe('pinnedProfilesOf', () => {
  it('drops entries without a positive integer machine id or a usable name', () => {
    const pins = pinnedProfilesOf(bean(1, {
      pinnedProfiles: [
        { machineId: 1, name: ' Blooming ' },
        { machineId: 0, name: 'Zero' },
        { machineId: 1.5, name: 'Fraction' },
        { machineId: '2', name: 'String id' },
        { machineId: 2, name: '   ' },
        { machineId: 2 },
        'nonsense',
        null,
      ],
    }));
    expect(pins).toEqual([{ machineId: 1, name: 'Blooming' }]);
  });

  it('reads a missing or malformed list as no pins', () => {
    expect(pinnedProfilesOf(bean(1))).toEqual([]);
    expect(pinnedProfilesOf(bean(1, { pinnedProfiles: { machineId: 1, name: 'X' } }))).toEqual([]);
    expect(pinnedProfilesOf(bean(1, { pinnedProfiles: 'x' }))).toEqual([]);
  });
});

describe('togglePinnedProfile', () => {
  it('prepends a new pin and returns a new array', () => {
    const before: PinnedProfile[] = [{ machineId: 1, name: 'Blooming' }];
    const after = togglePinnedProfile(before, 1, '  Londinium ');
    expect(after).toEqual([
      { machineId: 1, name: 'Londinium' },
      { machineId: 1, name: 'Blooming' },
    ]);
    expect(before).toEqual([{ machineId: 1, name: 'Blooming' }]);
    expect(after).not.toBe(before);
  });

  it('matches the existing pin case-insensitively and per machine', () => {
    const pins: PinnedProfile[] = [{ machineId: 1, name: 'Blooming' }];
    expect(togglePinnedProfile(pins, 1, 'bLoOmInG')).toEqual([]);
    expect(togglePinnedProfile(pins, 2, 'blooming')).toEqual([
      { machineId: 2, name: 'blooming' },
      { machineId: 1, name: 'Blooming' },
    ]);
  });

  it('caps the list at the server limit', () => {
    let pins: PinnedProfile[] = [];
    for (let i = 0; i < MAX_PINNED_PROFILES + 5; i++) pins = togglePinnedProfile(pins, 1, `P${i}`);
    expect(pins).toHaveLength(MAX_PINNED_PROFILES);
    expect(pins[0]).toEqual({ machineId: 1, name: `P${MAX_PINNED_PROFILES + 4}` });
  });
});

describe('provenProfilesForBean', () => {
  it('reports a profile with three rated shots averaging at least 4', () => {
    const rows = provenProfilesForBean(
      LONDINIUM,
      context(rated(1, 'Londinium', [5, 4, 4]), [LONDINIUM]),
    );
    expect(rows).toEqual([{
      machineId: 1,
      name: 'Londinium',
      ratedShots: 3,
      avgRating: 4.3,
      pinned: false,
      beanCount: 1,
      pinnedBy: 0,
      missing: false,
    }]);
  });

  it('needs three rated shots', () => {
    const two = rated(1, 'Londinium', [5, 5]);
    expect(provenProfilesForBean(LONDINIUM, context(two, [LONDINIUM]))).toEqual([]);
    expect(two).toHaveLength(MIN_RATED_SHOTS - 1);
    expect(provenProfilesForBean(LONDINIUM, context(rated(1, 'Londinium', [5, 5, 5]), [LONDINIUM]))).toHaveLength(1);
  });

  it('rejects an average below the bar', () => {
    expect(provenProfilesForBean(LONDINIUM, context(rated(1, 'Londinium', [4, 4, 3]), [LONDINIUM]))).toEqual([]);
    // Exactly the bar still counts; half a star below is thin evidence.
    expect(provenProfilesForBean(LONDINIUM, context(rated(1, 'Londinium', [4, 4, MIN_AVG_RATING]), [LONDINIUM])))
      .toHaveLength(1);
  });

  it('keeps the spelling of the most recent shot', () => {
    const shots = [
      shot({ beanId: 1, profile: 'londinium', rating: 5, timestamp: 10 }),
      shot({ beanId: 1, profile: 'Londinium', rating: 5, timestamp: 20 }),
      shot({ beanId: 1, profile: 'LONDINIUM', rating: 5, timestamp: 30 }),
    ];
    expect(provenProfilesForBean(LONDINIUM, context(shots, [LONDINIUM]))[0]?.name).toBe('LONDINIUM');
  });

  it('accepts string ratings and ignores out-of-range ones', () => {
    const shots = [
      shot({ beanId: 1, profile: 'Londinium', rating: '5' }),
      shot({ beanId: 1, profile: 'Londinium', rating: '4.5' }),
      shot({ beanId: 1, profile: 'Londinium', rating: '4' }),
      shot({ beanId: 1, profile: 'Londinium', rating: 9 }),
      shot({ beanId: 1, profile: 'Londinium', rating: 0 }),
      shot({ beanId: 1, profile: 'Londinium', rating: 'not a number' }),
    ];
    const rows = provenProfilesForBean(LONDINIUM, context(shots, [LONDINIUM]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ratedShots: 3, avgRating: 4.5 });
  });

  it('never counts an unrated shot toward the bar', () => {
    const shots = [
      shot({ beanId: 1, profile: 'Londinium', rating: 5 }),
      shot({ beanId: 1, profile: 'Londinium', rating: 5 }),
      shot({ beanId: 1, profile: 'Londinium' }),
    ];
    expect(provenProfilesForBean(LONDINIUM, context(shots, [LONDINIUM]))).toEqual([]);
  });

  it('ignores shots without a profile name and mixed beans', () => {
    const shots = [
      shot({ beanId: 1, profile: 'Londinium', rating: 5, mixed: true }),
      shot({ beanId: 1, profile: 'Londinium', rating: 5, mixed: true }),
      shot({ beanId: 1, profile: 'Londinium', rating: 5, mixed: true }),
      shot({ beanId: 1, rating: 5 }),
      shot({ beanId: 1, rating: 5 }),
      shot({ beanId: 1, rating: 5 }),
    ];
    expect(provenProfilesForBean(LONDINIUM, context(shots, [LONDINIUM]))).toEqual([]);
  });

  it('ranks by average rating before shot count', () => {
    const shots = [
      ...rated(1, 'Four Eight', [5, 5, 4.4]),
      ...rated(1, 'Four Two', [5, 5, 4, 4, 4, 4, 4, 4, 4]),
    ];
    const rows = provenProfilesForBean(LONDINIUM, context(shots, [LONDINIUM]));
    expect(rows.map(r => [r.name, r.avgRating, r.ratedShots])).toEqual([
      ['Four Eight', 4.8, 3],
      ['Four Two', 4.2, 9],
    ]);
  });

  it('returns at most MAX_DERIVED_ROWS derived rows', () => {
    const shots = ['A', 'B', 'C', 'D'].flatMap(name => rated(1, name, [5, 5, 5]));
    expect(provenProfilesForBean(LONDINIUM, context(shots, [LONDINIUM]))).toHaveLength(MAX_DERIVED_ROWS);
  });
});

describe('provenProfilesForBean: bean join', () => {
  it('joins a shot to its bean by name when it carries no bean id', () => {
    const shots = [1, 2, 3].map(() => shot({ coffee: 'londinium', profile: 'Londinium', rating: 5 }));
    expect(provenProfilesForBean(LONDINIUM, context(shots, [LONDINIUM]))).toHaveLength(1);
  });

  it('trusts a resolved bean id over the coffee name', () => {
    const other = bean(2, { name: 'Other' });
    const shots = [1, 2, 3].map(() => shot({ beanId: 2, coffee: 'Londinium', profile: 'Londinium', rating: 5 }));
    expect(provenProfilesForBean(LONDINIUM, context(shots, [LONDINIUM, other]))).toEqual([]);
    expect(provenProfilesForBean(other, context(shots, [LONDINIUM, other]))).toHaveLength(1);
  });
});

describe('provenProfilesForBean: pins', () => {
  const pinned = bean(1, {
    name: 'Londinium',
    roastLevel: 'medium',
    process: 'Washed',
    pinnedProfiles: [{ machineId: 1, name: 'Blooming' }],
  });

  it('lists a pinned profile with no shots first', () => {
    const shots = rated(1, 'Londinium', [5, 4, 4]);
    const rows = provenProfilesForBean(pinned, context(shots, [pinned]));
    expect(rows[0]).toEqual({
      machineId: 1,
      name: 'Blooming',
      ratedShots: 0,
      avgRating: null,
      pinned: true,
      beanCount: 1,
      pinnedBy: 0,
      missing: false,
    });
    expect(rows[1]?.name).toBe('Londinium');
  });

  it('lists a pinned profile that also meets the bar only once', () => {
    const shots = [
      ...rated(1, 'Londinium', [5, 4, 4]),
      ...rated(1, 'blooming', [5, 5, 5]),
    ];
    const rows = provenProfilesForBean(pinned, context(shots, [pinned]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'Blooming', pinned: true, ratedShots: 3, avgRating: 5 });
    expect(rows.filter(r => r.name.toLowerCase() === 'blooming')).toHaveLength(1);
  });

  it('drops the row after the pin is toggled off', () => {
    const shots = rated(1, 'Londinium', [5, 4, 4]);
    const unpinned = { ...pinned, pinnedProfiles: togglePinnedProfile(pinnedProfilesOf(pinned), 1, 'Blooming') };
    const rows = provenProfilesForBean(unpinned, context(shots, [unpinned]));
    expect(rows.map(r => [r.name, r.pinned])).toEqual([['Londinium', false]]);
  });

  it('keeps a pinned profile that gained a poor history', () => {
    const shots = rated(1, 'Blooming', [1, 1, 1]);
    const rows = provenProfilesForBean(pinned, context(shots, [pinned]));
    expect(rows[0]).toMatchObject({ name: 'Blooming', pinned: true, ratedShots: 3, avgRating: 1 });
  });
});

describe('provenProfilesForBean: machines', () => {
  it('forms one row per machine when the context spans all machines', () => {
    const shots = [
      ...rated(1, 'Londinium', [5, 5, 5], 1),
      ...rated(1, 'Londinium', [4, 4, 4], 2),
    ];
    const rows = provenProfilesForBean(LONDINIUM, context(shots, [LONDINIUM]));
    expect(rows.map(r => [r.machineId, r.ratedShots, r.avgRating])).toEqual([
      [1, 3, 5],
      [2, 3, 4],
    ]);
  });

  it('scopes rows and pins to the selected machine', () => {
    const both = bean(1, {
      pinnedProfiles: [
        { machineId: 1, name: 'Machine one' },
        { machineId: 2, name: 'Machine two' },
      ],
    });
    const shots = rated(1, 'Londinium', [5, 5, 5], 2);
    const rows = provenProfilesForBean(both, context(shots, [both], { machineId: 2 }));
    expect(rows.map(r => r.name)).toEqual(['Machine two', 'Londinium']);
    expect(rows.every(r => r.machineId === 2)).toBe(true);
  });

  it('treats a shot without a machineId as machine 1', () => {
    const shots = [1, 2, 3].map(() => shot({ beanId: 1, profile: 'Londinium', rating: 5 }));
    const rows = provenProfilesForBean(LONDINIUM, context(shots, [LONDINIUM], { machineId: 1 }));
    expect(rows[0]?.machineId).toBe(1);
    expect(rows[0]?.ratedShots).toBe(MIN_RATED_SHOTS);
  });
});

describe('isSimilarBean', () => {
  it('excludes a decaf mismatch', () => {
    expect(isSimilarBean(bean(1, { decaf: true }), bean(2, { decaf: false }))).toBe(false);
    expect(isSimilarBean(bean(1, { decaf: true }), bean(2, { decaf: true }))).toBe(true);
  });

  it('allows one roast-level step and rejects two', () => {
    expect(isSimilarBean(bean(1, { roastLevel: 'light' }), bean(2, { roastLevel: 'medium-light' }))).toBe(true);
    expect(isSimilarBean(bean(1, { roastLevel: 'light' }), bean(2, { roastLevel: 'medium' }))).toBe(false);
  });

  it('falls back to the coarse roast type when a level is missing', () => {
    expect(isSimilarBean(bean(1, { roastType: 'espresso' }), bean(2, { roastType: 'filter' }))).toBe(false);
    expect(isSimilarBean(bean(1, { roastType: 'espresso' }), bean(2, { roastType: 'omni' }))).toBe(true);
    expect(isSimilarBean(bean(1, { roastLevel: 'light' }), bean(2, { roastType: 'filter' }))).toBe(true);
  });

  it('compares process trimmed and case-insensitively, and tolerates it missing', () => {
    expect(isSimilarBean(bean(1, { process: 'Washed' }), bean(2, { process: 'washed ' }))).toBe(true);
    expect(isSimilarBean(bean(1, { process: 'Washed' }), bean(2, { process: 'Natural' }))).toBe(false);
    expect(isSimilarBean(bean(1, { process: 'Washed' }), bean(2))).toBe(true);
  });

  it('never calls a bean similar to itself', () => {
    expect(isSimilarBean(bean(1, { process: 'Washed' }), bean(1, { process: 'Washed' }))).toBe(false);
  });
});

describe('suggestProfilesForBean', () => {
  const target = bean(1, { name: 'Target', roastLevel: 'medium', process: 'Washed' });
  const similar = bean(2, { name: 'Similar', roastLevel: 'medium-dark', process: 'washed' });

  it('gives a bean with no similarity data no suggestions', () => {
    const shots = rated(2, 'Blooming', [5, 5, 5]);
    expect(suggestProfilesForBean(bean(1, { name: 'Empty' }), context(shots, [bean(1, { name: 'Empty' }), similar])))
      .toEqual([]);
  });

  it('waits for three rated shots of a similar bean', () => {
    const thin = context(rated(2, 'Blooming', [5, 5]), [target, similar]);
    expect(suggestProfilesForBean(target, thin)).toEqual([]);

    const enough = context(rated(2, 'Blooming', [5, 5, 4]), [target, similar]);
    expect(suggestProfilesForBean(target, enough)).toEqual([{
      machineId: 1,
      name: 'Blooming',
      ratedShots: 3,
      avgRating: 4.7,
      pinned: false,
      beanCount: 1,
      pinnedBy: 0,
      missing: false,
    }]);
  });

  it('never suggests the target bean\'s own history', () => {
    const shots = rated(1, 'Own', [5, 5, 5]);
    expect(suggestProfilesForBean(target, context(shots, [target, similar]))).toEqual([]);
  });

  it('suggests a profile pinned on a similar bean despite thin statistics', () => {
    const pinnedSimilar = { ...similar, pinnedProfiles: [{ machineId: 1, name: 'Blooming' }] };
    const thin = context(rated(2, 'Blooming', [5, 5]), [target, pinnedSimilar]);
    expect(suggestProfilesForBean(target, thin)).toEqual([{
      machineId: 1,
      name: 'Blooming',
      ratedShots: 2,
      avgRating: 5,
      pinned: false,
      beanCount: 1,
      pinnedBy: 1,
      missing: false,
    }]);
  });

  it('ignores a pin on a dissimilar bean', () => {
    const dissimilar = {
      ...bean(3, { roastLevel: 'dark' }),
      pinnedProfiles: [{ machineId: 1, name: 'Blooming' }],
    };
    const thin = context(rated(2, 'Blooming', [5, 5]), [target, similar, dissimilar]);
    expect(suggestProfilesForBean(target, thin).filter(r => r.name === 'Blooming')).toEqual([]);
  });

  it('excludes what the bean already has as pinned or proven', () => {
    const shots = rated(2, 'Blooming', [5, 5, 5]);
    const ownPinned = { ...target, pinnedProfiles: [{ machineId: 1, name: 'Blooming' }] };
    expect(suggestProfilesForBean(ownPinned, context(shots, [ownPinned, similar]))).toEqual([]);

    const ownProven = rated(1, 'Blooming', [4, 4, 4]);
    expect(suggestProfilesForBean(target, context([...shots, ...ownProven], [target, similar]))).toEqual([]);
  });

  it('pools similar beans but counts each one once', () => {
    const second = bean(3, { roastLevel: 'medium-light', process: 'Washed' });
    const shots = [
      ...rated(2, 'Blooming', [5, 5, 5]),
      ...rated(3, 'Blooming', [4, 4, 4]),
      ...rated(3, 'Blooming', [4, 4, 4]),
    ];
    const rows = suggestProfilesForBean(target, context(shots, [target, similar, second]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ratedShots: 9, avgRating: 4.3, beanCount: 2 });
  });

  it('ranks by rating, then count, then pins, then name, and caps the rows', () => {
    const second = bean(3, { roastLevel: 'medium-light', process: 'Washed' });
    const shots = [
      ...rated(2, 'Alpha', [5, 5, 5]),
      ...rated(2, 'Beta', [4, 4, 4]),
      ...rated(2, 'Charlie', [4, 4, 4]),
      ...rated(2, 'Delta', [4, 4, 4]),
    ];
    const rows = suggestProfilesForBean(target, context(shots, [target, similar, second]));
    expect(rows).toHaveLength(MAX_DERIVED_ROWS);
    expect(rows[0]?.name).toBe('Alpha');
    expect(rows.map(r => r.name)).toEqual(['Alpha', 'Beta', 'Charlie']);
  });

  it('puts rows without rated shots after rated ones', () => {
    const pinnedSimilar = {
      ...similar,
      pinnedProfiles: [
        { machineId: 1, name: 'Pinned Only' },
        { machineId: 1, name: 'Zulu' },
      ],
    };
    const shots = rated(2, 'Rated', [4, 4, 4]);
    const rows = suggestProfilesForBean(target, context(shots, [target, pinnedSimilar]));
    expect(rows.map(r => [r.name, r.avgRating])).toEqual([
      ['Rated', 4],
      ['Pinned Only', null],
      ['Zulu', null],
    ]);
  });

  it('suggests only on the selected machine', () => {
    const shots = [
      ...rated(2, 'Blooming', [5, 5, 5], 1),
      ...rated(2, 'Blooming', [5, 5, 5], 2),
    ];
    const rows = suggestProfilesForBean(target, context(shots, [target, similar], { machineId: 2 }));
    expect(rows.map(r => [r.machineId, r.ratedShots])).toEqual([[2, 3]]);
  });
});

describe('availableNames and renames', () => {
  const target = bean(1, { name: 'Target', roastLevel: 'medium', process: 'Washed' });
  const similar = bean(2, { name: 'Similar', roastLevel: 'medium', process: 'Washed' });

  it('drops a suggestion whose profile no longer exists', () => {
    const shots = rated(2, 'Blooming', [5, 5, 5]);
    const ctx = context(shots, [target, similar], { availableNames: new Set(['londinium']) });
    expect(suggestProfilesForBean(target, ctx)).toEqual([]);
  });

  it('keeps a suggestion whose name exists, compared case-insensitively', () => {
    const shots = rated(2, 'Blooming', [5, 5, 5]);
    const ctx = context(shots, [target, similar], { availableNames: new Set(['blooming']) });
    expect(suggestProfilesForBean(target, ctx).map(r => r.name)).toEqual(['Blooming']);
  });

  it('flags a pinned row as missing but keeps it', () => {
    const withPin = { ...target, pinnedProfiles: [{ machineId: 1, name: 'Blooming' }] };
    const ctx = context([], [withPin], { availableNames: new Set(['londinium']) });
    const rows = provenProfilesForBean(withPin, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Blooming', pinned: true, missing: true });
  });

  it('flags nothing when the caller passes no names', () => {
    const withPin = { ...target, pinnedProfiles: [{ machineId: 1, name: 'Blooming' }] };
    const rows = provenProfilesForBean(withPin, context([], [withPin], { availableNames: null }));
    expect(rows[0]?.missing).toBe(false);
  });
});
