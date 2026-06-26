// Thin compatibility layer — machine config helpers only.
// All data access now lives in lib/repositories/ and lib/services/.

const fs = require('fs');
const { OPTIONS_FILE, ALLOWED_URL_SCHEMES } = require('./constants');
const { log } = require('./helpers');

function loadOptions() {
    try {
        if (fs.existsSync(OPTIONS_FILE))
            return JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
    } catch (e) { log(`Could not read options.json: ${e.message}`, true); }
    return {};
}

function getMachineUrl(opts) {
    const raw = (opts.machine_host || opts.machine_url || process.env.MACHINE_URL || 'gaggia.intern').trim();
    const normalised = /^https?:\/\//i.test(raw) ? raw : `http://${raw}/api/shots`;
    try {
        const u = new URL(normalised);
        if (!ALLOWED_URL_SCHEMES.includes(u.protocol)) {
            log(`Invalid URL scheme: ${u.protocol} -- using default`, true);
            return 'http://gaggia.intern/api/shots';
        }
        return normalised;
    } catch {
        log('Invalid machine_host value -- using default', true);
        return 'http://gaggia.intern/api/shots';
    }
}

function getMachineBaseUrl(opts) {
    try {
        const u = new URL(getMachineUrl(opts));
        return `${u.protocol}//${u.host}`;
    } catch { return 'http://gaggia.intern'; }
}

function getSyncIntervalMs(opts) {
    return (opts.sync_interval || 5) * 60 * 1000;
}

function isOrdersEnabled() { return !!loadOptions().enable_orders; }

module.exports = {
    loadOptions, getMachineUrl, getMachineBaseUrl, getSyncIntervalMs, isOrdersEnabled,
};
