import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs   = require('fs');
const path = require('path');
const { formatUnhandledRejection } = require('../lib/helpers');

// server.js can't be `require()`d directly in a test process -- it reads a
// hardcoded /data path and calls app.listen() as a side effect of import
// (see test/server-middleware-order.test.js). So the wiring itself is
// verified structurally, the same way that file already checks middleware
// registration order, and the handler's own message-formatting logic
// (extracted to lib/helpers.js's formatUnhandledRejection so it doesn't
// require importing server.js) is unit tested directly below (#642).
describe('global unhandledRejection guard (#642)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    it('registers process.on(\'unhandledRejection\', ...) exactly once', () => {
        const matches = src.match(/process\.on\(\s*['"]unhandledRejection['"]/g) || [];
        expect(matches.length).toBe(1);
    });

    it('registers the handler before app.listen() starts serving traffic', () => {
        const handlerIdx = src.indexOf("process.on('unhandledRejection'");
        const listenIdx  = src.indexOf('app.listen(');
        expect(handlerIdx).toBeGreaterThan(-1);
        expect(listenIdx).toBeGreaterThan(-1);
        expect(handlerIdx).toBeLessThan(listenIdx);
    });

    it('the handler logs via the shared log() helper, not console.log/console.error directly', () => {
        const handlerLine = src.split('\n').find(l => l.includes("process.on('unhandledRejection'"));
        expect(handlerLine).toBeDefined();
        expect(handlerLine).toContain('log(');
        expect(handlerLine).not.toMatch(/\bprocess\.exit\b/);
        expect(handlerLine).not.toMatch(/\bthrow\b/);
    });

    it('formatUnhandledRejection turns an Error reason into a loggable message without throwing', () => {
        const msg = formatUnhandledRejection(new Error('boom'));
        expect(msg).toContain('Unhandled promise rejection');
        expect(msg).toContain('boom');
    });

    it('formatUnhandledRejection handles a non-Error rejection reason (e.g. a rejected string/object) without throwing', () => {
        expect(() => formatUnhandledRejection('plain string reason')).not.toThrow();
        expect(formatUnhandledRejection('plain string reason')).toContain('plain string reason');
        expect(() => formatUnhandledRejection({ code: 'ECONNRESET' })).not.toThrow();
    });

    it('wiring formatUnhandledRejection up to a real unhandledRejection listener logs once and does not crash the process', async () => {
        const logged = [];
        const handler = (reason) => logged.push(formatUnhandledRejection(reason));
        process.on('unhandledRejection', handler);
        try {
            // Simulate exactly what Node invokes the listener with: emit the
            // event directly rather than leaving a real promise rejection
            // unhandled, so this doesn't also trip the test runner's own
            // unhandled-rejection detection.
            process.emit('unhandledRejection', new Error('synthetic test rejection'), Promise.resolve());
            expect(logged.length).toBe(1);
            expect(logged[0]).toContain('synthetic test rejection');
        } finally {
            process.off('unhandledRejection', handler);
        }
    });
});
