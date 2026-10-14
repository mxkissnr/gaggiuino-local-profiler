// #1622: concreteActiveMachineId() is the one helper the profile editors and
// the dial-in wizard use to turn S.activeMachineId into a concrete numeric id
// (or null for 'all'/unset/non-numeric).
import { describe, it, expect } from 'vitest';

// vitest's node environment has no browser globals; state/index.js reads
// localStorage/navigator at module load — same stub bridge the sibling state
// tests use.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.navigator ??= { language: 'en-US' };

const { S, concreteActiveMachineId } = await import('../public-src/state/index.js');

describe('concreteActiveMachineId (#1622)', () => {
  it('returns a finite numeric machine id as is', () => {
    S.activeMachineId = 2;
    expect(concreteActiveMachineId()).toBe(2);
  });

  it("returns null for the 'all' sentinel", () => {
    S.activeMachineId = 'all';
    expect(concreteActiveMachineId()).toBeNull();
  });

  it('returns null when no machine is loaded', () => {
    S.activeMachineId = null;
    expect(concreteActiveMachineId()).toBeNull();
  });

  it('parses a numeric string', () => {
    S.activeMachineId = '3' as unknown as number;
    expect(concreteActiveMachineId()).toBe(3);
  });

  it('returns null for an empty string', () => {
    S.activeMachineId = '' as unknown as number;
    expect(concreteActiveMachineId()).toBeNull();
  });

  it('returns null for a non-numeric string', () => {
    S.activeMachineId = 'abc' as unknown as number;
    expect(concreteActiveMachineId()).toBeNull();
  });

  it('returns null for NaN', () => {
    S.activeMachineId = NaN;
    expect(concreteActiveMachineId()).toBeNull();
  });
});
