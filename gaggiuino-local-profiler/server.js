const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const { GLP_VERSION, DEFAULT_PORT, DATA_DIR, DATA_FILE, ANNOTATIONS_FILE,
        LIBRARY_FILE, TOKEN_FILE, HA_INGRESS_PATH } = require('./lib/constants');
const { log, writeFileSafe }                         = require('./lib/helpers');
const state                                          = require('./lib/state');
const { purgeExpiredTrash }                          = require('./lib/data');
const { fetchMachineVersion, checkAndApplyMachinePower,
        backgroundHaCheck, scheduleNextSync, syncShots,
        loadPreheatState }                           = require('./lib/live-sync');

// ── Init data dir & default files ─────────────────────────────────────────
try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
        writeFileSafe(DATA_FILE, []);
        log(`Database initialized: ${DATA_FILE}`);
    } else {
        log(`Database loaded: ${DATA_FILE}`);
    }
    if (!fs.existsSync(ANNOTATIONS_FILE)) writeFileSafe(ANNOTATIONS_FILE, {});
    if (!fs.existsSync(LIBRARY_FILE))     writeFileSafe(LIBRARY_FILE, { beans: [], grinders: [] });
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

// ── Express app ───────────────────────────────────────────────────────────
const app = express();

// Security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});

// Restore needs a larger body limit — register BEFORE the global json middleware
app.use('/api/restore', express.json({ limit: '50mb' }));
app.use(express.json({ limit: '16kb' }));

// API token auth
app.use((req, res, next) => {
    if (!state.apiToken) return next();
    const ingressPath = req.headers['x-ingress-path'];
    if (ingressPath !== undefined && ingressPath.startsWith(HA_INGRESS_PATH)) return next();
    if (req.path === '/api/status') return next();
    if (!req.path.startsWith('/api/') && req.path !== '/shots.json') return next();
    if (req.headers['x-glp-token'] === state.apiToken) return next();
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
    purgeExpiredTrash();
    setInterval(purgeExpiredTrash, 24 * 60 * 60 * 1000);
    fetchMachineVersion();
    checkAndApplyMachinePower().then(() => syncShots().then(scheduleNextSync));
});
