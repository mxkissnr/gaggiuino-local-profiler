import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { annotationSchema, beanSchema, orderSchema } = require('../lib/validation/schemas');

describe('annotationSchema', () => {
    it('accepts a valid annotation', () => {
        const result = annotationSchema.safeParse({
            coffee: 'Lucky Punch Espresso', grindSetting: '12', rating: 4, notes: 'great',
        });
        expect(result.success).toBe(true);
    });

    it('rejects rating out of range', () => {
        const result = annotationSchema.safeParse({ rating: 9 });
        expect(result.success).toBe(false);
    });

    it('rejects notes exceeding max length', () => {
        const result = annotationSchema.safeParse({ notes: 'x'.repeat(2001) });
        expect(result.success).toBe(false);
    });
});

describe('beanSchema', () => {
    it('requires a name', () => {
        const result = beanSchema.safeParse({ roaster: 'Test' });
        expect(result.success).toBe(false);
    });

    it('accepts a full bean', () => {
        const result = beanSchema.safeParse({ name: 'Ethiopia Yirgacheffe', roaster: 'Roastery', weight: 250 });
        expect(result.success).toBe(true);
    });
});

describe('orderSchema', () => {
    it('requires drinkId and personName', () => {
        expect(orderSchema.safeParse({}).success).toBe(false);
        expect(orderSchema.safeParse({ drinkId: 'espresso' }).success).toBe(false);
    });

    it('accepts a valid order', () => {
        const result = orderSchema.safeParse({ drinkId: 'espresso', personName: 'Max' });
        expect(result.success).toBe(true);
    });
});
