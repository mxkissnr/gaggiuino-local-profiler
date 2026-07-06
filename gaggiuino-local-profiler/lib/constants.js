// Polyfill File global for Node.js < 20
if (typeof File === 'undefined') {
    try { global.File = require('buffer').File; } catch (_) { global.File = class File {}; }
}

const GLP_VERSION  = '1.104.0';
const DEFAULT_PORT = 8099;

const DATA_DIR             = '/data';
const TOKEN_FILE           = '/data/api_token.txt';
const PREHEAT_STATE_FILE   = '/data/preheat_state.json';
const OPTIONS_FILE         = '/data/options.json';
const PROFILES_CACHE_FILE  = '/data/profiles_cache.json';
// Legacy per-entity JSON files live on only as one-time migration sources —
// their paths are owned by lib/db.js (JSON_FILES); nothing else may touch them.

const TRASH_TTL_MS          = 30 * 24 * 60 * 60 * 1000;
const ORDERS_HISTORY_TTL_MS = 7  * 24 * 60 * 60 * 1000;
const MAX_SHOT_ID           = 100000;
const HA_INGRESS_PATH       = '/api/hassio_ingress/gaggiuino_local_profiler';
const HA_API                = 'http://supervisor/core/api';
const HA_TOKEN              = process.env.SUPERVISOR_TOKEN;
const ALLOWED_URL_SCHEMES   = ['http:', 'https:'];
const ALLOWED_IMPORT_HOSTS  = ['kaffeebraun.com', 'www.kaffeebraun.com',
    'hoppenworth-ploch.de', 'www.hoppenworth-ploch.de',
    'elbgold.com', 'www.elbgold.com'];

// Bean images are only ever downloaded from an import source's own host or
// its CDN — never an arbitrary URL a client sends.
const ALLOWED_IMAGE_HOSTS  = [...ALLOWED_IMPORT_HOSTS, 'cdn.shopify.com'];
const BEAN_IMAGE_DIR       = '/data/bean-images';
const BEAN_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;

const LOW_STOCK_THRESHOLD_G = 100; // remaining grams below which a bean counts as low stock

const TEMP_HISTORY_MAX  = 60;   // max rolling history entries (1 per second)
const TEMP_STABLE_MIN   = 30;   // minimum window length to consider stability (seconds)
const TEMP_STABLE_VAR   = 1.5;  // max allowed range (max-min, °C) over the stability window
const PREHEAT_STATE_TTL = 24 * 60 * 60 * 1000;
const WARM_TEMP_MIN     = 80;
const WARM_OFF_MAX_MS   = 5 * 60 * 1000;

const DEFAULT_MENU = [
    { id: 'espresso',   name: 'Espresso',       emoji: '☕' },
    { id: 'ristretto',  name: 'Ristretto',       emoji: '☕' },
    { id: 'lungo',      name: 'Lungo',           emoji: '☕' },
    { id: 'cappuccino', name: 'Cappuccino',       emoji: '🥛' },
    { id: 'latte',      name: 'Latte Macchiato', emoji: '🥛' },
    { id: 'flat_white', name: 'Flat White',       emoji: '🥛' },
];

const MAINTENANCE_DEFAULTS = {
    descaling:   { lastDate: null, threshold_shots: 200, threshold_days: 60  },
    backflush:   { lastDate: null, threshold_shots: 20,  threshold_days: null },
    grouphead:   { lastDate: null, threshold_shots: null, threshold_days: 180 },
    gaskets:     { lastDate: null, threshold_shots: null, threshold_days: 365 },
    waterfilter: { lastDate: null, threshold_shots: null, threshold_days: 90  },
};

const STATIC_MAINTENANCE_TASKS = new Set(['descaling', 'backflush', 'grouphead', 'gaskets', 'waterfilter']);

module.exports = {
    GLP_VERSION, DEFAULT_PORT,
    DATA_DIR, TOKEN_FILE, PREHEAT_STATE_FILE, OPTIONS_FILE, PROFILES_CACHE_FILE,
    TRASH_TTL_MS, ORDERS_HISTORY_TTL_MS, MAX_SHOT_ID,
    HA_INGRESS_PATH, HA_API, HA_TOKEN, ALLOWED_URL_SCHEMES, ALLOWED_IMPORT_HOSTS,
    TEMP_HISTORY_MAX, TEMP_STABLE_MIN, TEMP_STABLE_VAR, PREHEAT_STATE_TTL,
    WARM_TEMP_MIN, WARM_OFF_MAX_MS,
    DEFAULT_MENU, MAINTENANCE_DEFAULTS, STATIC_MAINTENANCE_TASKS,
    LOW_STOCK_THRESHOLD_G,
    ALLOWED_IMAGE_HOSTS, BEAN_IMAGE_DIR, BEAN_IMAGE_MAX_BYTES,
};
