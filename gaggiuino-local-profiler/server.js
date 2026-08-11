const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const { GLP_VERSION, DEFAULT_PORT, DATA_DIR, TOKEN_FILE, HA_INGRESS_PATH } = require('./lib/constants');
const { log, writeFileSafe, isSupervisorIp, formatUnhandledRejection } = require('./lib/helpers');
const { loadOptions }                                = require('./lib/data');
const state                                          = require('./lib/state');
const { getDb }                                      = require('./lib/db');
const shotService                                    = require('./lib/services/ShotService');
const { errorHandler }                               = require('./lib/middleware/error');
const { createApiRateLimiter }                       = require('./lib/middleware/rateLimit');
const { loadPreheatState, startPreheatWatcher }                              = require('./lib/preheat');
const { syncAllMachines, scheduleNextSync }                                  = require('./lib/sync');
const { fetchMachineVersion, checkAndApplyMachinePower, backgroundHaCheck } = require('./lib/poll');

// #642: Node >=15 terminates the whole process on an unhandled promise
// rejection by default. Every setInterval/setTimeout callback in this file
// already guards its own promise (backgroundHaCheck below, lib/preheat.js's
// watcher, lib/sync.js's scheduleNextSync) -- this is a last-resort net so a
// future change that drops one of those guards logs instead of killing the
// entire backend process.
process.on('unhandledRejection', (reason) => log(formatUnhandledRejection(reason), true));

// ── Init data dir & SQLite DB ────────────────────────────────────────────
try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    getDb(); // initialises schema + migrates JSON files on first run
    const libraryService = require('./lib/services/LibraryService');
    libraryService.migrateImportedNotes();
    libraryService.migrateNotesToFlavors();
    libraryService.migrateOriginToOrigins();
    libraryService.migrateVarietyToSpecies();
    libraryService.migrateAnnotationBeanIds();
    require('./lib/machines/registry').ensureDefaultMachine(); // #317: seed machine #1 from legacy options
    // Must run after the seed: adopts machine_host/switch_entity edits made
    // in the HA add-on configuration *after* first run, which the seed above
    // can no longer pick up. See lib/machines/options-adoption.js.
    require('./lib/machines/options-adoption').adoptOptionChanges();
    log('Database ready');
    // #706: keys only, never values (machine_host can be a private
    // hostname/IP) -- lets a stale Supervisor-side config.yaml schema
    // (add-on version bumped, but the repository's schema cache wasn't
    // refreshed in lockstep) be confirmed or ruled out from the log tab
    // alone, without shell access to the affected instance.
    log(`options.json keys: ${Object.keys(loadOptions()).sort().join(', ') || '(none)'}`);
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
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    // Chart.js, ECharts, topojson-client, QRCode and both fonts (Figtree,
    // Fraunces) are bundled into the app — no third-party host needed.
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "font-src 'self' data:; " +
        "img-src 'self' data: blob:; " +
        "connect-src 'self';");
    next();
});

// App-level rate limiter — runs ahead of auth/routes so it also caps
// unauthenticated traffic (login/token probing) and the index.html/static
// handlers below (see lib/middleware/rateLimit.js for the ceiling and
// trust-proxy reasoning).
app.use(createApiRateLimiter());

// Returns true only for requests originating from the HA Supervisor internal network.
// The Supervisor proxies ingress traffic from 172.30.0.0/16; external LAN clients
// arrive with their own IP and must not receive the same trust level.
function isFromSupervisor(req) {
    return isSupervisorIp(req.socket?.remoteAddress || req.ip || '');
}

// True only for requests that genuinely arrive through HA Ingress (Supervisor
// IP + X-Ingress-Path header — same trust check the auth bypass below uses).
// Also used to decide whether index.html gets the PWA manifest link / service
// worker registration: the HA Companion App loads GLP through Ingress inside
// an embedded WebView, and the v1.102.0 PWA service worker broke its live
// shot graph there (see CHANGELOG "Reverted the v1.102.0 installable-PWA
// service worker"). Gating server-side — not just client-side — means the
// Companion App's WebView can never see the manifest link or SW registration
// call at all, so it structurally cannot regress the same way again.
function isIngressRequest(req) {
    const ingressPath = req.headers['x-ingress-path'];
    return ingressPath !== undefined && ingressPath.startsWith(HA_INGRESS_PATH) && isFromSupervisor(req);
}

// API token auth
app.use((req, res, next) => {
    req.glpAuthenticated = isTokenValid(req.headers['x-glp-token']);
    // #735: EventSource can't send custom headers, so /api/events -- and only
    // that route -- also accepts the token as a query param. Same "reaching
    // the port is the boundary, not the token" reasoning as GET /api/token
    // above (routes/system.js): a token passed in a URL is visible in
    // access logs, which is why this isn't done for every route, only the
    // one that has no other way to authenticate a browser-native EventSource
    // connection.
    if (!req.glpAuthenticated && req.path === '/api/events') {
        req.glpAuthenticated = isTokenValid(req.query.token);
    }
    // Fail closed, not open: if the token couldn't be loaded/created (disk
    // error at startup), deny everything instead of letting every request
    // through unauthenticated.
    if (!state.apiToken) return res.status(503).json({ error: 'API token unavailable' });
    // Ingress bypass: only trust X-Ingress-Path when the request genuinely
    // originates from the HA Supervisor (172.30.x.x), preventing header spoofing
    // from external LAN clients who can also reach port 8099.
    if (isIngressRequest(req)) return next();
    if (req.path === '/api/status') return next();
    if (req.path === '/api/token') return next(); // endpoint handles its own IP-based check
    if (!req.path.startsWith('/api/') && req.path !== '/shots.json') return next();
    if (req.glpAuthenticated) return next();
    res.status(401).json({ error: 'Unauthorized' });
});

// Body parsers run AFTER auth so an unauthenticated caller can't force a full
// parse of a large payload (esp. /api/restore's 50mb limit) before being
// rejected — the auth middleware above only reads headers/path, never body.
app.use('/api/restore', express.json({ limit: '50mb' }));
// A restore body is either JSON (legacy/already-downloaded backups) or a zip
// (backup.json + real image files, see routes/backup.js's buildBackupZip()).
// Express only invokes whichever of these matches the request's actual
// Content-Type, so stacking both here is safe -- req.body ends up as either
// a parsed object or a raw Buffer depending on what the client sent, same
// size ceiling as the JSON path above (a zip is typically smaller than the
// base64 JSON it replaces for the same content).
app.use('/api/restore', express.raw({ type: 'application/zip', limit: '50mb' }));
// #755: raw SQLite DB upload for routes/debug.js's dev-only import-db route
// (counterpart to its existing export-db route) -- a DB with years of shot
// history (no images, those live outside the DB, see BEAN_IMAGE_DIR) can
// still run well past a typical JSON payload, same generous ceiling as the
// zip restore body above.
app.use('/api/debug/import-db', express.raw({ type: 'application/octet-stream', limit: '500mb' }));
app.use(express.json({ limit: '16kb' }));

// ── Routes ────────────────────────────────────────────────────────────────
app.use(require('./routes/shots'));
app.use(require('./routes/library'));
app.use(require('./routes/maintenance'));
app.use(require('./routes/orders'));
app.use(require('./routes/system'));
app.use(require('./routes/machines'));
app.use(require('./routes/machine-control'));
app.use(require('./routes/mqtt'));
app.use(require('./routes/backup'));
app.use(require('./routes/import'));
app.use(require('./routes/debug'));
app.use(require('./routes/sse'));

// ── Centralized error handling ────────────────────────────────────────────
app.use(errorHandler);

// ── index.html: server-templated PWA gating ─────────────────────────────────
// Serves the built index.html, injecting the manifest link only for requests
// that did NOT arrive through HA Ingress (see isIngressRequest above). This
// runs ahead of express.static so the templated response wins over the
// static file of the same name. manifest.json/sw.js themselves are still
// served as plain static files even under Ingress — harmless, since a page
// that never gets the manifest link or SW registration call never fetches
// them either.
app.get(['/', '/index.html'], (req, res, next) => {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, 'utf8', (err, html) => {
        if (err) return next();
        if (!isIngressRequest(req)) {
            html = html.replace('</head>', '    <link rel="manifest" href="manifest.json">\n</head>');
        }
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.type('html').send(html);
    });
});

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
const server = app.listen(PORT, () => {
    const { loadOptions } = require('./lib/data');
    const opts = loadOptions();
    // #711: GLP_VERSION is frozen at the last real release on the dev
    // branch (see #704) -- without the dev build tag appended here, a raw
    // downloaded log gives no way to tell a GLP DEV build apart from
    // stable, short of cross-referencing the separate "UNSTABLE DEV BUILD"
    // UI banner.
    const devSuffix = process.env.GLP_DEV_BUILD ? ` (${process.env.GLP_DEV_BUILD})` : '';
    log(`Gaggiuino Local Profiler v${GLP_VERSION}${devSuffix} started on port ${PORT}`);
    // #712: registry.apiUrlFor() (the source of truth since #662, matching
    // every real poll/sync request path), not raw getMachineUrl(opts) --
    // opts.machine_host is permanently empty post-#662 (removed from the
    // add-on's Configuration schema), so the raw call always bottomed out
    // at getMachineUrl()'s hardcoded fallback host regardless of whatever
    // was actually configured in Settings -> Machines.
    const registry = require('./lib/machines/registry');
    // #718: apiUrlFor() is null when no host is configured anywhere
    log(`Machine URL: ${registry.apiUrlFor() || '(not configured)'} | sync every ${opts.sync_interval || 5} min`);
    registry.logRegistrySnapshot(); // #714
    log(`HA integration: ${require('./lib/constants').HA_TOKEN ? 'active (auto-sync via latest_shot_id)' : 'unavailable (no SUPERVISOR_TOKEN)'}`);
    setInterval(() => { backgroundHaCheck().catch(e => log(`Background HA check failed: ${e.message}`, true)); }, 30000);
    startPreheatWatcher();
    shotService.purgeExpiredTrash();
    setInterval(() => shotService.purgeExpiredTrash(), 24 * 60 * 60 * 1000);
    fetchMachineVersion();
    (async () => {
        try { await checkAndApplyMachinePower(); }
        catch (e) { log(`Machine power check failed on startup: ${e.message}`, true); }
        try {
            const ok = await syncAllMachines();
            scheduleNextSync(ok ? 0 : 1);
        } catch (e) {
            log(`Initial sync failed: ${e.message}`, true);
            scheduleNextSync(1);
        }
    })();
});

// #675: this process runs as PID 1 in the container (docker-entrypoint.sh
// execs into `gosu node`), and Linux doesn't apply the default signal
// disposition to PID 1 unless a handler is explicitly installed -- without
// this, `docker stop`'s SIGTERM was silently ignored, so Supervisor always
// hit the stop timeout and force-killed the process (exit 137, reported as
// add-on state=error instead of a clean stop).
function gracefulShutdown(signal) {
    log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
