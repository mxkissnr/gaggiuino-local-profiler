import { describe, it, expect } from 'vitest';
import { calcBeanRating } from '../public-src/utils.js';

const shot = (coffee, rating) => ({ annotation: { coffee, rating } });

describe('calcBeanRating', () => {
  it('averages ratings for shots matching the bean name case-insensitively', () => {
    const shots = [shot('Lucky Punch', 5), shot('lucky punch', 3), shot('El Cubanito', 4)];
    expect(calcBeanRating('Lucky Punch', shots)).toEqual({ avg: 4, count: 2 });
  });

  it('rounds to one decimal', () => {
    const shots = [shot('Dolce', 5), shot('Dolce', 4), shot('Dolce', 4)];
    expect(calcBeanRating('Dolce', shots)).toEqual({ avg: 4.3, count: 3 });
  });

  it('ignores shots without a rating or with an out-of-range rating', () => {
    const shots = [shot('Dolce', undefined), shot('Dolce', 0), shot('Dolce', 6), shot('Dolce', 5)];
    expect(calcBeanRating('Dolce', shots)).toEqual({ avg: 5, count: 1 });
  });

  it('returns null when nothing matches', () => {
    expect(calcBeanRating('Ghost Bean', [shot('Dolce', 5)])).toBeNull();
    expect(calcBeanRating('Dolce', [])).toBeNull();
    expect(calcBeanRating('', [shot('Dolce', 5)])).toBeNull();
    expect(calcBeanRating('Dolce', null)).toBeNull();
  });
});
