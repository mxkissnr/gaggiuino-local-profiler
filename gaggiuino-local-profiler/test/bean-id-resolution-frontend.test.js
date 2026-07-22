import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Same stubbing approach as grind-baseline.test.js/best-grind-combo.test.js:
// views/shots/utils.js pulls in state.js, which needs localStorage/navigator
// at module load.
let resolveBeanForAnnotation, S;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'en' },
    configurable: true, writable: true,
  });
  ({ resolveBeanForAnnotation } = await import('../public-src/views/shots/utils.js'));
  ({ S } = await import('../public-src/state.js'));
});

beforeEach(() => {
  S.coffeeLibrary = { beans: [{ id: 1, name: 'Lucky Punch' }, { id: 2, name: 'El Cubanito' }] };
});

describe('resolveBeanForAnnotation (#456, frontend mirror)', () => {
  it('resolves by beanId, even if the name in the annotation is stale (renamed since)', () => {
    const bean = resolveBeanForAnnotation({ coffee: 'Old Name', beanId: 1 });
    expect(bean?.id).toBe(1);
  });

  it('falls back to case-insensitive name matching when beanId is absent', () => {
    const bean = resolveBeanForAnnotation({ coffee: 'lucky punch' });
    expect(bean?.id).toBe(1);
  });

  it('falls back to a name match (advisory best-guess) when beanId points at a bean that no longer exists', () => {
    S.coffeeLibrary = { beans: [{ id: 99, name: 'Lucky Punch' }] };
    expect(resolveBeanForAnnotation({ coffee: 'Lucky Punch', beanId: 1 })?.id).toBe(99);
  });

  it('returns null when neither beanId nor name resolve', () => {
    expect(resolveBeanForAnnotation({ coffee: 'Nonexistent' })).toBeNull();
    expect(resolveBeanForAnnotation({})).toBeNull();
    expect(resolveBeanForAnnotation(null)).toBeNull();
  });
});
