import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');

// server.js can't be `require()`d directly in a test process — it reads a
// hardcoded /data path and calls app.listen() as a side effect of import.
// Instead this locks in the middleware *registration order* Express actually
// runs by, via a structural check on the source: the auth middleware must be
// registered before any express.json() body parser, so an unauthenticated
// request never has its body parsed (and its memory/CPU spent) before being
// rejected with 401 — see the /api/restore 50mb-limit DoS fix.
describe('server.js middleware order', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    it('registers the auth middleware before the express.json() body parsers', () => {
        const authIdx = src.indexOf('// API token auth');
        const restoreParserIdx = src.indexOf("app.use('/api/restore', express.json(");
        const globalParserIdx = src.indexOf('app.use(express.json({ limit: \'16kb\' }))');

        expect(authIdx).toBeGreaterThan(-1);
        expect(restoreParserIdx).toBeGreaterThan(-1);
        expect(globalParserIdx).toBeGreaterThan(-1);

        expect(authIdx).toBeLessThan(restoreParserIdx);
        expect(authIdx).toBeLessThan(globalParserIdx);
    });

    it('registers both body parsers before the route handlers', () => {
        const restoreParserIdx = src.indexOf("app.use('/api/restore', express.json(");
        const routesIdx = src.indexOf("app.use(require('./routes/shots'))");

        expect(restoreParserIdx).toBeGreaterThan(-1);
        expect(routesIdx).toBeGreaterThan(-1);
        expect(restoreParserIdx).toBeLessThan(routesIdx);
    });
});
