// #483: debug_logging add-on option (Home Assistant → Add-on-Konfiguration) and
// its isDebugLoggingEnabled()/debugLog() helpers in lib/data.js.
import { describe, it, expect, vi, afterEach } from 'vitest';
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

describe('isDebugLoggingEnabled', () => {
    afterEach(() => { delete require.cache[require.resolve('../lib/data')]; });

    it('is false by default (no options.json / no debug_logging key)', () => {
        const { restore } = withOptions(null);
        const { isDebugLoggingEnabled } = require('../lib/data');
        expect(isDebugLoggingEnabled()).toBe(false);
        restore();
    });

    it('is false when debug_logging is explicitly false', () => {
        const { restore } = withOptions({ debug_logging: false });
        const { isDebugLoggingEnabled } = require('../lib/data');
        expect(isDebugLoggingEnabled()).toBe(false);
        restore();
    });

    it('is true when debug_logging is true in options.json', () => {
        const { restore } = withOptions({ debug_logging: true });
        const { isDebugLoggingEnabled } = require('../lib/data');
        expect(isDebugLoggingEnabled()).toBe(true);
        restore();
    });
});

describe('debugLog', () => {
    afterEach(() => { delete require.cache[require.resolve('../lib/data')]; });

    it('stays silent when debug_logging is off', () => {
        const { restore } = withOptions({ debug_logging: false });
        const { debugLog } = require('../lib/data');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        debugLog('should not appear');
        expect(logSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
        restore();
    });

    it('logs with a [debug] prefix when debug_logging is on', () => {
        const { restore } = withOptions({ debug_logging: true });
        const { debugLog } = require('../lib/data');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        debugLog('import step reached');
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[debug] import step reached'));
        logSpy.mockRestore();
        restore();
    });
});
