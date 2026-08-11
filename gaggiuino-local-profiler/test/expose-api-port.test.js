// #803: expose_api_port add-on option and its isApiPortExposed() helper in
// lib/data.js. The real end-to-end proof that GET /api/token honors this
// option through the real isIngressRequest() wiring lives in
// test/expose-api-port-default-live.test.js and
// test/expose-api-port-closed-live.test.js (real HTTP server, per the
// issue's explicit ask not to re-implement isIngressRequest() in a test).
// This file covers the pure options.json -> boolean logic in isolation,
// same pattern as test/debug-logging.test.js.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);

function withOptions(options) {
    const optionsPath = require.resolve('../lib/constants');
    const realConstants = require(optionsPath);
    const tmpFile = path.join(os.tmpdir(), `glp-test-options-${Date.now()}-${Math.random()}.json`);
    if (options != null) fs.writeFileSync(tmpFile, JSON.stringify(options));
    require.cache[optionsPath].exports = { ...realConstants, OPTIONS_FILE: tmpFile };
    delete require.cache[require.resolve('../lib/data')];
    return { tmpFile, restore: () => {
        fs.existsSync(tmpFile) && fs.unlinkSync(tmpFile);
        require.cache[optionsPath].exports = realConstants;
        delete require.cache[require.resolve('../lib/data')];
    }};
}

describe('isApiPortExposed', () => {
    afterEach(() => { delete require.cache[require.resolve('../lib/data')]; });

    it('is true when there is no options.json at all (standalone Docker, no Supervisor)', () => {
        const { restore } = withOptions(null);
        const { isApiPortExposed } = require('../lib/data');
        expect(isApiPortExposed()).toBe(true);
        restore();
    });

    // The realistic upgrade case: options.json exists (Supervisor always
    // writes one) but predates this option -- must behave exactly as today,
    // per the issue's explicit "no existing install may change behaviour on
    // upgrade" requirement.
    it('is true when options.json exists but has no expose_api_port key', () => {
        const { restore } = withOptions({ sync_interval: 5 });
        const { isApiPortExposed } = require('../lib/data');
        expect(isApiPortExposed()).toBe(true);
        restore();
    });

    it('is true when expose_api_port is explicitly true', () => {
        const { restore } = withOptions({ expose_api_port: true });
        const { isApiPortExposed } = require('../lib/data');
        expect(isApiPortExposed()).toBe(true);
        restore();
    });

    it('is false when expose_api_port is explicitly false', () => {
        const { restore } = withOptions({ expose_api_port: false });
        const { isApiPortExposed } = require('../lib/data');
        expect(isApiPortExposed()).toBe(false);
        restore();
    });
});
