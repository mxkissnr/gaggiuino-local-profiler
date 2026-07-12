import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { errorHandler } = require('../lib/middleware/error');

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

describe('errorHandler', () => {
    it('returns a generic message for 5xx and never leaks err.message to the client', () => {
        const err = new Error('ENOENT: no such file /data/secret-internal-path.db');
        const res = makeRes();
        errorHandler(err, { method: 'GET', path: '/api/status' }, res, () => {});
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
        expect(JSON.stringify(res.body)).not.toContain('secret-internal-path');
    });

    it('preserves the explicit status code for a custom 5xx error but still masks the message', () => {
        const err = Object.assign(new Error('upstream DB connection string leaked here'), { status: 503 });
        const res = makeRes();
        errorHandler(err, { method: 'POST', path: '/api/restore' }, res, () => {});
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({ error: 'Internal server error' });
    });

    it('keeps the specific message for 4xx errors (validation feedback is not sensitive)', () => {
        const err = Object.assign(new Error('invalid backup file'), { status: 400 });
        const res = makeRes();
        errorHandler(err, { method: 'POST', path: '/api/restore' }, res, () => {});
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'invalid backup file' });
    });

    it('defaults to 500 when no status is set on the error', () => {
        const err = new Error('boom');
        const res = makeRes();
        errorHandler(err, { method: 'GET', path: '/x' }, res, () => {});
        expect(res.statusCode).toBe(500);
    });
});
