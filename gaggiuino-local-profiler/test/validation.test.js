import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { annotationSchema, beanSchema, orderSchema, machineSchema } = require('../lib/validation/schemas');
const { THEME_PRESET_KEYS } = require('../lib/machines/theme-presets');
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

    // #502: frontend always sends frozenPortionId: null for "not frozen"
    // explicitly picked (same shape as beanId/beanBagId above it).
    it('accepts a numeric frozenPortionId', () => {
        const result = annotationSchema.safeParse({ coffee: 'Bean', frozenPortionId: 1721234567890 });
        expect(result.success).toBe(true);
    });

    it('accepts frozenPortionId: null (not frozen explicitly picked)', () => {
        const result = annotationSchema.safeParse({ coffee: 'Bean', frozenPortionId: null });
        expect(result.success).toBe(true);
    });

    it('rejects a non-integer frozenPortionId', () => {
        const result = annotationSchema.safeParse({ coffee: 'Bean', frozenPortionId: 1.5 });
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

describe('machineSchema theme (#594)', () => {
    const base = { name: 'Kitchen', type: 'gaggiuino', host: 'gaggiuino.local' };

    it('accepts a machine with no theme (default appearance)', () => {
        expect(machineSchema.safeParse(base).success).toBe(true);
        expect(machineSchema.safeParse({ ...base, theme: null }).success).toBe(true);
    });

    it('accepts every known preset key', () => {
        for (const key of THEME_PRESET_KEYS) {
            const result = machineSchema.safeParse({ ...base, theme: { preset: key } });
            expect(result.success).toBe(true);
        }
    });

    it('rejects a preset key that is not one of the approved presets', () => {
        const result = machineSchema.safeParse({ ...base, theme: { preset: 'made-up-preset' } });
        expect(result.success).toBe(false);
    });

    it('accepts a custom flat colour (a === b)', () => {
        const result = machineSchema.safeParse({ ...base, theme: { a: '#f59e0b', b: '#f59e0b' } });
        expect(result.success).toBe(true);
    });

    it('accepts a custom two-stop gradient (a !== b)', () => {
        const result = machineSchema.safeParse({ ...base, theme: { a: '#f59e0b', b: '#0891b2' } });
        expect(result.success).toBe(true);
    });

    it('rejects a custom colour missing the b stop', () => {
        const result = machineSchema.safeParse({ ...base, theme: { a: '#f59e0b' } });
        expect(result.success).toBe(false);
    });

    it('rejects CSS colour keywords and functions, not just malformed hex — only strict #rrggbb is trusted downstream in SVG/CSS', () => {
        for (const bad of ['red', 'rgb(255,0,0)', '#fff', '#gggggg', 'javascript:alert(1)']) {
            const result = machineSchema.safeParse({ ...base, theme: { a: bad, b: bad } });
            expect(result.success).toBe(false);
        }
    });

    it('rejects an XSS payload smuggled into a hex field', () => {
        const result = machineSchema.safeParse({
            ...base, theme: { a: '"><script>alert(1)</script>', b: '#f59e0b' },
        });
        expect(result.success).toBe(false);
    });

    it('rejects mixing preset and custom colour keys on the same theme object (.strict())', () => {
        const result = machineSchema.safeParse({ ...base, theme: { preset: 'amber-americano', a: '#f59e0b' } });
        expect(result.success).toBe(false);
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
