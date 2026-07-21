import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { annotationSchema, beanSchema, orderSchema } = require('../lib/validation/schemas');
const { validate } = require('../lib/middleware/validate');

function runMiddleware(schema, body) {
    let statusCode, jsonBody;
    const req = { body };
    const res = {
        status(code) { statusCode = code; return this; },
        json(payload) { jsonBody = payload; return this; },
    };
    let nextCalled = false;
    validate(schema)(req, res, () => { nextCalled = true; });
    return { statusCode, jsonBody, nextCalled, body: req.body };
}

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

    // #434: the frontend always sends drinkType: null for "no drink assigned"
    // (see annotation.js) — every save with no drink selected 400'd until
    // this field got the same .nullable() treatment milkType already has.
    it('accepts drinkType: null (no drink assigned)', () => {
        const result = annotationSchema.safeParse({ coffee: 'Bean', drinkType: null });
        expect(result.success).toBe(true);
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

describe('validate middleware error shape', () => {
    it('returns a stable 400 shape for a missing required field', () => {
        const { statusCode, jsonBody, nextCalled } = runMiddleware(orderSchema, {});
        expect(statusCode).toBe(400);
        expect(nextCalled).toBe(false);
        expect(jsonBody.error).toBe('Validation failed');
        expect(Array.isArray(jsonBody.issues)).toBe(true);
        expect(jsonBody.issues.length).toBeGreaterThan(0);
        for (const issue of jsonBody.issues) {
            expect(typeof issue.path).toBe('string');
            expect(typeof issue.message).toBe('string');
        }
        expect(jsonBody.issues.map(i => i.path)).toEqual(expect.arrayContaining(['drinkId', 'personName']));
    });

    it('returns a stable 400 shape for a wrong-type field', () => {
        const { statusCode, jsonBody } = runMiddleware(orderSchema, { drinkId: 123, personName: 'Max' });
        expect(statusCode).toBe(400);
        expect(jsonBody.issues).toEqual([{ path: 'drinkId', message: expect.any(String) }]);
    });

    it('passes through unknown extra fields on the schema (passthrough) rather than rejecting them', () => {
        const { nextCalled, body } = runMiddleware(orderSchema, {
            drinkId: 'espresso', personName: 'Max', weirdField: 'zzz',
        });
        expect(nextCalled).toBe(true);
        expect(body.weirdField).toBe('zzz');
    });

    it('calls next() with the parsed data on a valid payload', () => {
        const { nextCalled, statusCode, body } = runMiddleware(orderSchema, {
            drinkId: 'espresso', personName: 'Max',
        });
        expect(nextCalled).toBe(true);
        expect(statusCode).toBeUndefined();
        expect(body).toEqual({ drinkId: 'espresso', personName: 'Max', notes: '' });
    });
});
