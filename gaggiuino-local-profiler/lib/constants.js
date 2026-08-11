// Polyfill File global for Node.js < 20
if (typeof File === 'undefined') {
    try { global.File = require('buffer').File; } catch { global.File = class File {}; }
}

const GLP_VERSION  = '2.33.3';
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
// Raised from 100000 (#317) to make room for synthetic multi-machine shot
// ids: additional machines (machine id > 1) get id = machineId *
// MACHINE_ID_OFFSET + nativeId (see lib/machines/index.js) so their shots
// never collide with the default machine's native ids, which stay untouched.
const MAX_SHOT_ID           = 99_999_999;
// #801: this is a PREFIX, not the add-on's own path. HA Core sets
// X-Ingress-Path to `/api/hassio_ingress/<per-session random token>`
// (homeassistant/components/hassio/ingress.py), never the add-on slug, and
// the token differs per install and even per dev-add-on install -- there is
// no fixed suffix to pin. The Supervisor-IP check alongside every use of
// this prefix is what makes the header trustworthy (any LAN client that can
// reach port 8099 can otherwise send an arbitrary X-Ingress-Path).
const HA_INGRESS_PREFIX     = '/api/hassio_ingress/';
// #764: standalone Docker (no Supervisor, e.g. HA Container on Unraid/
// TrueNAS) has no SUPERVISOR_TOKEN and can't reach the internal `supervisor`
// hostname — GLP_HA_URL + GLP_HA_TOKEN (a normal HA long-lived access token,
// Profile -> Security) is the opt-in substitute so lib/ha.js's HA
// auto-sync/switch-control/notify calls still work outside HA OS. The two
// must be set together; HA_TOKEN otherwise stays falsy exactly like before,
// so every existing `if (!HA_TOKEN)` guard in lib/ha.js needs no change.
const GLP_HA_URL             = process.env.GLP_HA_URL ? process.env.GLP_HA_URL.replace(/\/$/, '') : null;
const HA_API                = process.env.SUPERVISOR_TOKEN
    ? 'http://supervisor/core/api'
    : (GLP_HA_URL ? `${GLP_HA_URL}/api` : null);
// #598: the Supervisor's own API root, distinct from HA_API above (which is
// the *Core* API proxied through the Supervisor) — service discovery
// (/services/mqtt) lives directly under this root, not under /core. No
// standalone-Docker equivalent exists (Settings' manual MQTT host/port/user/
// pass entry is the documented fallback there, see config.yaml).
const SUPERVISOR_API        = 'http://supervisor';
const HA_TOKEN              = process.env.SUPERVISOR_TOKEN || (GLP_HA_URL ? process.env.GLP_HA_TOKEN : undefined);
const ALLOWED_URL_SCHEMES   = ['http:', 'https:'];
const ALLOWED_IMPORT_HOSTS  = ['kaffeebraun.com', 'www.kaffeebraun.com',
    'hoppenworth-ploch.de', 'www.hoppenworth-ploch.de',
    'elbgold.com', 'www.elbgold.com'];

// Bean images are only ever downloaded from an import source's own host or
// its CDN — never an arbitrary URL a client sends.
const ALLOWED_IMAGE_HOSTS  = [...ALLOWED_IMPORT_HOSTS, 'cdn.shopify.com'];
const BEAN_IMAGE_DIR       = '/data/bean-images';
// #433: 1.5MB silently dropped a real roaster product photo (1.7MB,
// verified against sproutcoffeeroasters.art's Shopify CDN image) — the
// download's own maxContentLength threw, was swallowed by the caller's
// fire-and-forget .catch(() => {}), and the bean was saved with no image at
// all. 4MB comfortably covers realistic product photography (incl. 2x/retina
// exports) while still bounding the download.
const BEAN_IMAGE_MAX_BYTES  = 4 * 1024 * 1024;
const IMPORT_FETCH_MAX_BYTES = 5 * 1024 * 1024; // product JSON/HTML pages, generous for Shopify's inline data
const SCAN_FETCH_MAX_BYTES   = 1 * 1024 * 1024; // Open Food Facts product JSON only, much smaller than a Shopify page

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

// machineSyncedAt (descaling/backflush only): the raw machine-reported Unix
// timestamp last applied by lib/maintenance-sync.js's auto-sync, kept apart
// from lastDate so a manual "done" click (which sets lastDate alone) is
// never mistaken for an already-applied machine event.
const MAINTENANCE_DEFAULTS = {
    descaling:   { lastDate: null, threshold_shots: 200, threshold_days: 60,  machineSyncedAt: null },
    backflush:   { lastDate: null, threshold_shots: 20,  threshold_days: null, machineSyncedAt: null },
    grouphead:   { lastDate: null, threshold_shots: null, threshold_days: 180 },
    gaskets:     { lastDate: null, threshold_shots: null, threshold_days: 365 },
    waterfilter: { lastDate: null, threshold_shots: null, threshold_days: 90  },
};

const STATIC_MAINTENANCE_TASKS = new Set(['descaling', 'backflush', 'grouphead', 'gaskets', 'waterfilter']);

// #597: Gaggiuino REST settings categories (GET/POST /api/settings/{category}
// — see rest-api.md). 'versions' is intentionally excluded: it's read-only
// (no POST), so it's only valid on the GET side (routes/machine-control.js
// allows it separately rather than folding it into this writable list).
const GAGGIUINO_SETTINGS_CATEGORIES = ['boiler', 'system', 'display', 'scales', 'led', 'theme'];

// waterfilter and grinder_* tasks track shared equipment (one water filter /
// one grinder used across machines, #338) — they never split per machine and
// always live under the sentinel machine_id 1 in the `maintenance` table,
// regardless of which machine is currently active. descaling/backflush/
// grouphead/gaskets are boiler/group-head specific and DO split per machine.
function isGlobalMaintenanceTask(key) {
    return key === 'waterfilter' || key.startsWith('grinder_');
}

module.exports = {
    GLP_VERSION, DEFAULT_PORT,
    DATA_DIR, TOKEN_FILE, PREHEAT_STATE_FILE, OPTIONS_FILE, PROFILES_CACHE_FILE,
    TRASH_TTL_MS, ORDERS_HISTORY_TTL_MS, MAX_SHOT_ID,
    HA_INGRESS_PREFIX, HA_API, SUPERVISOR_API, HA_TOKEN, ALLOWED_URL_SCHEMES, ALLOWED_IMPORT_HOSTS,
    TEMP_HISTORY_MAX, TEMP_STABLE_MIN, TEMP_STABLE_VAR, PREHEAT_STATE_TTL,
    WARM_TEMP_MIN, WARM_OFF_MAX_MS,
    DEFAULT_MENU, MAINTENANCE_DEFAULTS, STATIC_MAINTENANCE_TASKS, isGlobalMaintenanceTask,
    GAGGIUINO_SETTINGS_CATEGORIES,
    LOW_STOCK_THRESHOLD_G,
    ALLOWED_IMAGE_HOSTS, BEAN_IMAGE_DIR, BEAN_IMAGE_MAX_BYTES, IMPORT_FETCH_MAX_BYTES, SCAN_FETCH_MAX_BYTES,
};
