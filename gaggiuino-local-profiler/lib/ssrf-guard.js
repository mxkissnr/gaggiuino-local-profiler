// Resolves a hostname (or accepts a literal IP) and rejects private, loopback
// and link-local addresses before a fetch is allowed to proceed. Used by the
// import route for both the initial URL and any redirect target it follows,
// since the generic import fallback (work package 2) now fetches arbitrary
// hostnames instead of a fixed 3-shop allowlist.
//
// `dns` is a Node core singleton — required once here and monkeypatchable in
// tests via `vi.spyOn(require('dns').promises, 'lookup')`, no require.cache
// tricks needed (unlike npm-package mocks such as axios).
const dns = require('dns');
const net = require('net');

class SsrfBlockedError extends Error {}

function isPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return true; // fail closed on garbage
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;            // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;    // RFC1918
    if (a === 192 && b === 168) return true;             // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT (RFC6598) — extra hardening
    return false;
}

function isPrivateIPv6(ip) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('::ffff:')) {
        const v4 = lower.slice(7);
        if (net.isIPv4(v4)) return isPrivateIPv4(v4);
    }
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
    if (/^f[cd][0-9a-f]{2}:/.test(lower))  return true; // fc00::/7 unique local
    return false;
}

function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) return isPrivateIPv4(ip);
    if (net.isIPv6(ip)) return isPrivateIPv6(ip);
    return true; // unrecognised format — fail closed
}

// Throws SsrfBlockedError when the host resolves to (or literally is) a
// blocked address. Throws a plain Error when the hostname can't be resolved
// at all (treated as an ordinary fetch failure by callers, not a security
// rejection). Resolves with no return value when the host is safe to fetch.
async function assertPublicHost(hostname) {
    const bare = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bare)) {
        if (isPrivateAddress(bare)) throw new SsrfBlockedError(`blocked address: ${bare}`);
        return;
    }
    const addresses = await dns.promises.lookup(bare, { all: true });
    if (!addresses || !addresses.length) throw new Error(`could not resolve host: ${bare}`);
    for (const { address } of addresses) {
        if (isPrivateAddress(address)) throw new SsrfBlockedError(`blocked address: ${address} (${bare})`);
    }
}

module.exports = { assertPublicHost, isPrivateAddress, SsrfBlockedError };
