const fs = require('fs');

function log(message, isError = false) {
    const now = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    if (isError) console.error(`[${now}] ${message}`);
    else         console.log(`[${now}] ${message}`);
}

// ── Simple in-memory rate limiter ─────────────────────────────────────────
const _rlWindows = new Map();
function rateLimit(key, maxPerMinute) {
    const now = Date.now();
    const win = 60_000;
    let e = _rlWindows.get(key);
    if (!e || now - e.t > win) { e = { t: now, n: 0 }; _rlWindows.set(key, e); }
    return ++e.n <= maxPerMinute;
}
setInterval(() => {
    const cutoff = Date.now() - 120_000;
    for (const [k, v] of _rlWindows) { if (v.t < cutoff) _rlWindows.delete(k); }
}, 120_000);

// ── Atomic file write (write to .tmp, then rename — crash-safe) ───────────
function writeFileSafe(filePath, data) {
    const tmp     = filePath + '.tmp';
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
}

// ── Per-file async mutex — prevents interleaved load→modify→save ──────────
const _fileLocks = new Map();
async function withFileLock(key, fn) {
    while (_fileLocks.has(key)) await _fileLocks.get(key);
    let resolve;
    _fileLocks.set(key, new Promise(r => { resolve = r; }));
    try { return await fn(); } finally { _fileLocks.delete(key); resolve(); }
}

module.exports = { log, rateLimit, writeFileSafe, withFileLock };
