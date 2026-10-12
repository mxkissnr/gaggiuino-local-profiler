import { describe, it, expect } from 'vitest';
import { calcBeanRating } from '../public-src/utils.js';

// #1625: calcBeanRating() now takes a library bean ({ id, name }) and joins
// shots through resolveBeanForAnnotation — a shot counts for the bean whose
// beanId it carries, even when the free-text coffee name is stale (the bean
// was renamed). A shot that resolves to a DIFFERENT bean is not counted, and
// does not fall back to the name either.
type BeanShot = NonNullable<Parameters<typeof calcBeanRating>[1]>[number];
const shot = (coffee: string | null | undefined, rating: number | null, beanId?: number | null): BeanShot =>
    ({ annotation: { coffee, rating, beanId } } as BeanShot);

const bean = (id: number, name: string): { id: number; name: string } => ({ id, name });

describe('calcBeanRating follows the linked bean (#1625)', () => {
  it('counts a renamed bean\'s shot by its beanId, not the stale coffee name', () => {
    const beans = [bean(1, 'Current Name')];
    const shots = [shot('Old Name', 5, 1)];
    expect(calcBeanRating(bean(1, 'Current Name'), shots, beans)).toEqual({ avg: 5, count: 1 });
  });

  it('does not count a shot that names the bean but links to another bean', () => {
    const beans = [bean(1, 'Target'), bean(2, 'Other')];
    const shots = [shot('Target', 5, 2)];
    expect(calcBeanRating(bean(1, 'Target'), shots, beans)).toBeNull();
  });
});
