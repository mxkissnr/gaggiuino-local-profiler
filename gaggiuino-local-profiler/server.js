const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const { GLP_VERSION, DEFAULT_PORT, DATA_DIR, TOKEN_FILE, HA_INGRESS_PATH } = require('./lib/constants');
const { log, writeFileSafe }                         = require('./lib/helpers');
const state                                          = require('./lib/state');
const { getDb }                                      = require('./lib/db');
const shotService                                    = require('./lib/services/ShotService');
const { errorHandler }                               = require('./lib/middleware/error');
const { loadPreheatState, startPreheatWatcher }                              = require('./lib/preheat');
const { syncShots, scheduleNextSync }                                        = require('./lib/sync');
const { fetchMachineVersion, checkAndApplyMachinePower, backgroundHaCheck } = require('./lib/poll');

// ── Init data dir & SQLite DB ────────────────────────────────────────────
try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    getDb(); // initialises schema + migrates JSON files on first run
    const libraryService = require('./lib/services/LibraryService');
    libraryService.migrateImportedNotes();
    libraryService.migrateNotesToFlavors();
    log('Database ready');
} catch (err) {
    log(`Init error: ${err.message}`, true);
}

// ── API token ─────────────────────────────────────────────────────────────
function loadOrCreateApiToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            state.apiToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        } else {
            state.apiToken = crypto.randomBytes(32).toString('hex');
            writeFileSafe(TOKEN_FILE, state.apiToken);
            log('API token generated');
        }
    } catch (e) {
        log(`Could not load/create API token: ${e.message}`, true);
    }
}

// Constant-time token comparison to prevent timing attacks (M3)
function isTokenValid(token) {
    if (!state.apiToken || !token) return false;
    try {
        const a = Buffer.from(token);
        const b = Buffer.from(state.apiToken);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch { return false; }
}

// ── Express app ───────────────────────────────────────────────────────────
const app = express();

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Chart.js and QRCode are loaded from jsdelivr; Figtree font from bunny.net
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' https://cdn.jsdelivr.net; " +
        "style-src 'self' 'unsafe-inline' https://fonts.bunny.net; " +
        "font-src 'self' data: https://fonts.bunny.net; " +
        "img-src 'self' data: blob:; " +
        "connect-src 'self';");
    next();
});

// Restore needs a larger body limit — register BEFORE the global json middleware
app.use('/api/restore', express.json({ limit: '50mb' }));
app.use(express.json({ limit: '16kb' }));

// Returns true only for requests originating from the HA Supervisor internal network.
// The Supervisor proxies ingress traffic from 172.30.0.0/16; external LAN clients
// arrive with their own IP and must not receive the same trust level.
function isFromSupervisor(req) {
    const ip = req.socket?.remoteAddress || req.ip || '';
    // Strip IPv6-mapped IPv4 prefix (::ffff:172.30.x.x)
    const plain = ip.replace(/^::ffff:/, '');
    return plain === '127.0.0.1' || plain.startsWith('172.30.');
}

// API token auth
app.use((req, res, next) => {
    req.glpAuthenticated = isTokenValid(req.headers['x-glp-token']);
    if (!state.apiToken) return next();
    // Ingress bypass: only trust X-Ingress-Path when the request genuinely
    // originates from the HA Supervisor (172.30.x.x), preventing header spoofing
    // from external LAN clients who can also reach port 8099.
    const ingressPath = req.headers['x-ingress-path'];
    if (ingressPath !== undefined && ingressPath.startsWith(HA_INGRESS_PATH) && isFromSupervisor(req)) return next();
    if (req.path === '/api/status') return next();
    if (req.path === '/api/token') return next(); // endpoint handles its own IP-based check
    if (!req.path.startsWith('/api/') && req.path !== '/shots.json') return next();
    if (req.glpAuthenticated) return next();
    res.status(401).json({ error: 'Unauthorized' });
});

// ── Routes ────────────────────────────────────────────────────────────────
app.use(require('./routes/shots'));
app.use(require('./routes/library'));
app.use(require('./routes/maintenance'));
app.use(require('./routes/orders'));
app.use(require('./routes/system'));
app.use(require('./routes/backup'));
app.use(require('./routes/import'));

// ── Centralized error handling ────────────────────────────────────────────
app.use(errorHandler);

// ── Static files ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ── Start ─────────────────────────────────────────────────────────────────
loadOrCreateApiToken();
loadPreheatState();

const PORT = DEFAULT_PORT;
app.listen(PORT, () => {
    const { loadOptions, getMachineUrl } = require('./lib/data');
    const opts = loadOptions();
    log(`Gaggiuino Local Profiler v${GLP_VERSION} started on port ${PORT}`);
    log(`Machine URL: ${getMachineUrl(opts)} | sync every ${opts.sync_interval || 5} min`);
    log(`HA integration: ${require('./lib/constants').HA_TOKEN ? 'active (auto-sync via latest_shot_id)' : 'unavailable (no SUPERVISOR_TOKEN)'}`);
    setInterval(backgroundHaCheck, 30000);
    startPreheatWatcher();
    shotService.purgeExpiredTrash();
    setInterval(() => shotService.purgeExpiredTrash(), 24 * 60 * 60 * 1000);
    fetchMachineVersion();
    (async () => {
        try { await checkAndApplyMachinePower(); }
        catch (e) { log(`Machine power check failed on startup: ${e.message}`, true); }
        try {
            const ok = await syncShots();
            scheduleNextSync(ok ? 0 : 1);
        } catch (e) {
            log(`Initial sync failed: ${e.message}`, true);
            scheduleNextSync(1);
        }
    })();
});
