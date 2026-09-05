const express       = require('express');
const router         = express.Router();
const fs             = require('fs');
const path           = require('path');
const shotService    = require('../lib/services/ShotService');
const shotRepo       = require('../lib/repositories/ShotRepository');
const libService     = require('../lib/services/LibraryService');
const libraryRepo    = require('../lib/repositories/LibraryRepository');
const orderRepo      = require('../lib/repositories/OrderRepository');
const registry       = require('../lib/machines/registry');
const mqttSettingsRepo   = require('../lib/repositories/MqttSettingsRepository');
const importSettingsRepo = require('../lib/repositories/ImportSettingsRepository');
const { loadMenu, saveMenu, loadOrdersSettings, saveOrdersSettings,
        loadNotifyMapping, saveNotifyMapping } = require('../lib/data');
const { getDb }                    = require('../lib/db');
const { GLP_VERSION, MAX_SHOT_ID, BEAN_IMAGE_DIR, BEAN_IMAGE_MAX_BYTES, TOKEN_FILE } = require('../lib/constants');
const { log, rateLimit, writeFileSafe } = require('../lib/helpers');
const { annotationSchema, maintenanceLogSchema } = require('../lib/validation/schemas');
const { sanitizeBeanFields, sanitizeGrinderFields, sanitizeRecipeFields,
        sanitizeMilkFields, sanitizeBasketFields, sanitizePuckScreenFields } = require('../lib/sanitize-bean');
const { imagePath, imageFilename, matchesImageMagicBytes, CONTENT_TYPE_EXT } = require('../lib/services/ImageService');
const { encryptSecrets, decryptSecrets } = require('../lib/backup-crypto');
const { createZip, readZip } = require('../lib/zip');
const state = require('../lib/state');
const { bus, EVENTS } = require('../lib/events');

// Filename-safe local-time timestamp, e.g. "2026-08-06_08-32-05" -- a bare
// date (the previous `.toISOString().slice(0, 10)`) collapsed every backup
// taken on the same day into one filename, forcing the browser to append
// "(1)"/"(2)" or silently overwrite the earlier one. Not `formatLogTimestamp`
// (lib/helpers.js): that one uses `:` separators, invalid in a Windows
// filename. Local time (not UTC, unlike the old `toISOString()` version) to
// match what the user actually sees on their own clock.
function backupTimestamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// The library entity types that can carry an uploaded image, and the
// filename prefix each uses under BEAN_IMAGE_DIR (see routes/library/*.js).
// Export no longer depends on this list (see buildBackupBundle()'s directory
// scan) -- restore still does, deliberately: writing a restored image file
// is only ever allowed for a filename an actually-restored entity claims via
// its own id + prefix, which is the path-traversal/integrity guard below.
// Shots aren't in this list -- their images validate separately in the
// restore transaction (prefix 'shot-', id = shot.id), since shots live at
// the backup's top level, not nested under coffee_library like these do.
const IMAGE_ENTITY_TYPES = [
    ['beans', ''],
    ['grinders', 'grinder-'],
    ['baskets', 'basket-'],
    ['puckScreens', 'puckscreen-'],
];

// A restored coffee_library bypasses the regular POST/PUT bean/grinder/recipe
// routes entirely (it's written straight to the DB), so it never went through
// their field sanitizers — a crafted backup could otherwise inject
// unsanitized strings (e.g. into bean.notes/flavors) that later render
// unescaped in the frontend. Re-run the same per-field sanitizers here.
//
// #635: milks used to be missing from this list entirely (bug/inconsistency
// — every other library entity was already covered); fixed alongside adding
// baskets/puckScreens rather than leaving it for a separate round.
function sanitizeRestoredLibrary(lib) {
    if (!lib || typeof lib !== 'object') return lib;
    return {
        ...lib,
        beans:       Array.isArray(lib.beans)       ? lib.beans.map(sanitizeBeanFields)             : lib.beans,
        grinders:    Array.isArray(lib.grinders)    ? lib.grinders.map(sanitizeGrinderFields)        : lib.grinders,
        recipes:     Array.isArray(lib.recipes)     ? lib.recipes.map(sanitizeRecipeFields)          : lib.recipes,
        milks:       Array.isArray(lib.milks)       ? lib.milks.map(sanitizeMilkFields)               : lib.milks,
        baskets:     Array.isArray(lib.baskets)     ? lib.baskets.map(sanitizeBasketFields)           : lib.baskets,
        puckScreens: Array.isArray(lib.puckScreens) ? lib.puckScreens.map(sanitizePuckScreenFields)   : lib.puckScreens,
    };
}

// Validates one entity list's id/image fields against the actual restored
// `images` blob and pushes a {path, buffer} entry onto pendingImageWrites for
// each image that survives every check — this is the actual path-traversal
// guard. Callers' sanitizers (sanitizeBeanFields/sanitizeGrinderFields/etc.,
// and the raw shot objects on the restore path) deliberately never touch
// `.id`/`.image`, so both arrive here as fully attacker-controlled strings
// straight from the backup JSON; neither is ever used to build a filesystem
// path until both pass every check below. Any entity whose image fails
// validation for any reason (including simply having no matching key in
// `imagesMap`, i.e. every backup from before images were included at all)
// has its `.image` field cleared rather than left pointing at a file that
// will never exist.
function validateEntityImages(list, prefix, imagesMap, pendingImageWrites) {
    for (const entity of Array.isArray(list) ? list : []) {
        if (!entity || !entity.image) continue;
        const ext = entity.image;
        if (!Object.values(CONTENT_TYPE_EXT).includes(ext)) { entity.image = null; continue; }
        const id = entity.id;
        if (!Number.isInteger(id) || id <= 0) { entity.image = null; continue; }
        const filename = imageFilename(id, ext, prefix);
        const buffer = imagesMap && typeof imagesMap === 'object' ? imagesMap[filename] : undefined;
        if (!Buffer.isBuffer(buffer)) { entity.image = null; continue; }
        if (!buffer.length || buffer.length > BEAN_IMAGE_MAX_BYTES) { entity.image = null; continue; }
        if (!matchesImageMagicBytes(buffer, ext)) { entity.image = null; continue; }
        pendingImageWrites.push({ path: imagePath(id, ext, prefix), buffer });
    }
}

// One call per library entity type (beans/grinders/baskets/puckScreens) —
// shot images validate separately via validateEntityImages(b.shots, 'shot-',
// ...) directly in the restore transaction, since shots aren't nested under
// coffee_library.
function validateRestoredLibraryImages(lib, imagesMap, pendingImageWrites) {
    if (!lib || typeof lib !== 'object') return;
    for (const [key, prefix] of IMAGE_ENTITY_TYPES) {
        validateEntityImages(lib[key], prefix, imagesMap, pendingImageWrites);
    }
}

// Loosely validates one raw `maintenance` export row ({machineId, key, data})
// on restore. `data`'s shape follows MAINTENANCE_DEFAULTS as a guide (not a
// rigid schema, since per-grinder keys aren't in that constant) — nested
// string fields are length-capped defensively, everything else whitelisted
// to number/string/null.
function sanitizeMaintenanceRow(r) {
    if (!r || typeof r !== 'object') return null;
    if (!Number.isInteger(r.machineId) || r.machineId <= 0) return null;
    if (typeof r.key !== 'string' || !r.key.trim() || r.key.length > 100) return null;
    if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) return null;
    const data = {};
    for (const [k, v] of Object.entries(r.data)) {
        if (typeof k !== 'string' || k.length > 50) continue;
        if (v === null || (typeof v === 'number' && Number.isFinite(v))) { data[k] = v; continue; }
        if (typeof v === 'string') { data[k] = v.slice(0, 500); continue; }
        // booleans/objects/arrays aren't part of any known maintenance task's shape — dropped.
    }
    return { machineId: r.machineId, key: r.key.trim().slice(0, 100), data };
}

function sanitizeMaintenanceLogRow(r) {
    if (!r || typeof r !== 'object') return null;
    if (!Number.isFinite(r.id) || !Number.isFinite(r.ts)) return null;
    if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
    const parsed = maintenanceLogSchema.safeParse({ task: r.task, notes: r.notes, machine: r.machine });
    if (!parsed.success) return null;
    return {
        id: r.id, ts: r.ts, date: r.date,
        task: parsed.data.task, machine: parsed.data.machine, notes: parsed.data.notes,
        shotCount: Number.isFinite(r.shotCount) ? r.shotCount : 0,
        machineId: Number.isInteger(r.machineId) && r.machineId > 0 ? r.machineId : 1,
    };
}

const ORDER_STATUSES = ['pending', 'accepted', 'done', 'declined'];
function _str(v, max) { return typeof v === 'string' ? v.slice(0, max) : null; }
function _num(v)      { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

// Loosely validates one raw order row on restore — mirrors the field set/
// length caps POST /api/orders and its lifecycle actions (accept/complete/
// decline, see lib/services/OrderService.js) already accept, since this is a
// round-trip of the same shape rather than a new order being placed.
function sanitizeOrderRow(o) {
    if (!o || typeof o !== 'object') return null;
    if (typeof o.id !== 'string' || !o.id.trim() || o.id.length > 100) return null;
    if (!ORDER_STATUSES.includes(o.status)) return null;
    return {
        id:            o.id.trim().slice(0, 100),
        status:        o.status,
        item:          _str(o.item, 100) ?? '',
        customer:      _str(o.customer, 50) ?? '',
        note:          _str(o.note, 200) ?? '',
        variant:       o.variant != null ? _str(o.variant, 50) : null,
        notifyService: o.notifyService != null ? _str(o.notifyService, 100) : null,
        declineReason: o.declineReason != null ? _str(o.declineReason, 200) : null,
        haUserId:      o.haUserId != null ? _str(o.haUserId, 100) : null,
        machine:       o.machine != null ? _str(o.machine, 100) : null,
        createdAt:     _num(o.createdAt) ?? Date.now(),
        completedAt:   _num(o.completedAt),
        acceptedAt:    _num(o.acceptedAt),
        eta:           _num(o.eta),
        machineId:     Number.isInteger(o.machineId) && o.machineId > 0 ? o.machineId : 1,
        beanId:        Number.isInteger(o.beanId) ? o.beanId : null,
        shotId:        Number.isInteger(o.shotId) ? o.shotId : null,
    };
}

// Six independently selectable backup domains -- the same set is used for
// export scope selection and restore scope selection, so a user picks
// between identical options on both ends (matches the "Restore Settings
// only" vs. "Restore Maintenance only" request the backup-completeness fix
// this file belongs to was filed alongside).
//
// 'shots' is deliberately one bucket covering shots/annotations/trash/
// blocklist/coffee_library/images rather than several finer-grained toggles:
// annotations and trash both key off shot ids, and shots reference library
// entities (beans/grinders/...) by id, so splitting library out from shots
// would let a restore recreate a shot whose bean was never restored.
const BACKUP_SECTIONS = ['shots', 'maintenance', 'orders', 'machines', 'settings', 'secrets'];

const SECTION_BUNDLE_KEYS = {
    shots:       ['shots', 'annotations', 'coffee_library', 'blocklist', 'trash', 'images'],
    maintenance: ['maintenance', 'maintenance_log'],
    orders:      ['orders'],
    machines:    ['machines'],
    settings:    ['kv'],
    secrets:     ['secrets'],
};

// Which top-level bundle key(s) prove a section is actually *present* in a
// file being restored -- a narrower question than SECTION_BUNDLE_KEYS above
// (which also lists the export-only keys a present section carries, e.g.
// 'shots' pulls in 'images' too). Mirrors the frontend's own
// SECTION_PRESENCE_KEYS (public-src/components/backup-modal.js) exactly;
// kept as two copies rather than one shared module since one runs in the
// browser and one in Node, same reasoning SECTION_KEYS/BACKUP_SECTIONS
// already accept.
const SECTION_PRESENCE_BUNDLE_KEYS = {
    shots:       ['shots'],
    maintenance: ['maintenance', 'maintenance_log'],
    orders:      ['orders'],
    machines:    ['machines'],
    settings:    ['kv'],
    secrets:     ['secrets'],
};

// `raw` is the caller-supplied `sections` field (export request body or a
// restore's own bundle). Three distinct outcomes:
//   undefined / not an array  -> null            ("all sections" -- the
//                                                  original, still-default
//                                                  behavior, and what keeps
//                                                  every pre-existing script/
//                                                  test/backup file working
//                                                  unchanged)
//   []                        -> empty Set        (caller explicitly chose
//                                                  nothing -- respected as-is,
//                                                  not silently upgraded to
//                                                  "all")
//   ['maintenance', 'orders'] -> Set{those two}   (unknown section names are
//                                                  dropped rather than
//                                                  rejected, so a future
//                                                  section name a newer
//                                                  export adds doesn't 400 an
//                                                  older client's request)
function normaliseSections(raw) {
    if (!Array.isArray(raw)) return null;
    return new Set(raw.filter(s => BACKUP_SECTIONS.includes(s)));
}

// Shared by every export entry point below (GET/POST /api/backup, both the
// legacy self-contained-JSON shape and the zip shape). `passphrase` is only
// ever non-null on a POST path (see there for why GET can never carry one)
// and gates whether an encrypted `secrets` block (API token + MQTT
// credentials) is appended to the bundle. `sections`: null for a full export
// (legacy/default), or a Set from normaliseSections() to restrict the bundle
// to only those domains.
//
// Returns `{ bundle, imageFiles, imagesRequested }` rather than a single
// ready-to-send object: `bundle` never carries image bytes at all (not even
// base64) -- callers decide how to attach `imageFiles` (raw {filename,
// buffer} pairs) depending on the output format (base64-embedded for the
// legacy JSON shape, real files for the zip shape). `imagesRequested`
// mirrors the section-filtering `'images' in fullBundle` check the old
// single-function version did, so a caller building a scoped export can tell
// "images weren't asked for" apart from "images were asked for but the
// directory was empty" -- both leave `imageFiles` as `[]`.
function gatherBackupData(passphrase, sections) {
    // findAll() (not the trash-excluding getAll()) — a trashed shot's full
    // payload must be part of the export, or the recycle bin is
    // unrecoverable after a restore (the bug this fixes).
    const shots = shotRepo.findAll();
    const trash = shotService.getTrash();
    const annotationsObj = Object.fromEntries(
        shots.map(s => [String(s.id), s.annotation]).filter(([, a]) => a && Object.keys(a).length)
    );
    const trashObj = Object.fromEntries(
        trash.map(s => [String(s.id), shotRepo.getTrashEntry(s.id) ?? Date.now()])
    );

    const lib = libService.getLibrary();
    // Reads BEAN_IMAGE_DIR directly rather than deriving the file list from
    // "each library entity type that can carry a photo" (the previous
    // approach): that list had to be updated by hand every time a new
    // photo-bearing entity type was added, and silently missed shot photos
    // entirely -- reported after they showed up fine in the Library/shot
    // view but never appeared in an export. BEAN_IMAGE_DIR is a single flat
    // directory every entity type's photo upload writes into (see
    // lib/services/ImageService.js), so scanning it can't miss a category
    // again, current or future, without needing to know what a "shot" or a
    // "bean" even is.
    const imageFiles = [];
    if (fs.existsSync(BEAN_IMAGE_DIR)) {
        for (const filename of fs.readdirSync(BEAN_IMAGE_DIR)) {
            const filePath = path.join(BEAN_IMAGE_DIR, filename);
            try {
                if (!fs.statSync(filePath).isFile()) continue;
                imageFiles.push({ filename, buffer: fs.readFileSync(filePath) });
            } catch (e) {
                // Best-effort: one unreadable file must not fail the whole
                // export. But silently continuing here previously made a
                // 38-of-39-images-missing gap indistinguishable from "there
                // were only ever 1-2 photos" -- log which file and why so a
                // pattern (e.g. a permissions mismatch on older uploads) is
                // diagnosable from the add-on log instead of invisible.
                log(`Backup: skipping unreadable image file ${filename}: ${e.message}`, true);
            }
        }
    }

    // MQTT broker credentials are deliberately excluded from the plaintext
    // export: this JSON file routinely ends up in Downloads/cloud backups,
    // and a plaintext broker password sitting there is not an acceptable
    // trade-off for restore convenience. Do not "fix" this back to a raw kv
    // dump — MqttSettingsRepository.saveSettings() merges into the
    // *currently stored* settings rather than overwriting wholesale, which
    // is what lets a locally configured password survive a restore from a
    // backup that never had one. A passphrase-encrypted copy travels
    // separately, in `secrets` below.
    const { username: _mqttUser, password: _mqttPass, ...safeMqttSettings } = mqttSettingsRepo.getSettings();

    // Every domain is gathered unconditionally above and filtered down to the
    // requested sections at the very end (rather than skipping the DB reads
    // for deselected sections) — trivial cost for a Settings-page action on a
    // home-sized dataset, and it keeps this function's data-gathering half
    // simple and single-purpose instead of threading `sections` through every
    // branch of it.
    const fullBundle = {
        glp_backup:      true,
        version:         GLP_VERSION,
        created:         new Date().toISOString(),
        shots:           shots.map(({ annotation: _, score: __, ...rest }) => rest),
        annotations:     annotationsObj,
        coffee_library:  lib,
        blocklist:       shotService.getBlocklist(),
        trash:           trashObj,
        maintenance:     libraryRepo.getAllMaintenanceRaw(),
        maintenance_log: libraryRepo.getAllMaintenanceLogRaw(),
        orders:          orderRepo.findAll(),
        machines:        registry.listMachines(),
        kv: {
            menu:            loadMenu(),
            orders_settings: loadOrdersSettings(),
            notify_mapping:  loadNotifyMapping(),
            import_settings: importSettingsRepo.getSettings(),
            mqtt_settings:   safeMqttSettings,
        },
    };

    // The API token grants full API access (including this very restore
    // endpoint) and the MQTT username/password are real infrastructure
    // credentials -- both are withheld from every plaintext field above and
    // only ever included, encrypted, when the caller opted in with a
    // passphrase. `secrets` is entirely absent (not an empty object) when
    // there is nothing worth encrypting, so an old-format-compatible reader
    // sees no difference from a backup with no secrets at all. Computed even
    // when 'secrets' isn't a requested section, since the section filter
    // below is what actually decides whether it ends up in the response --
    // one code path, not two.
    if (passphrase) {
        const rawMqtt = mqttSettingsRepo.getSettings();
        const secretPayload = {};
        if (state.apiToken) secretPayload.apiToken = state.apiToken;
        if (rawMqtt.username || rawMqtt.password) {
            secretPayload.mqtt = { username: rawMqtt.username, password: rawMqtt.password };
        }
        if (Object.keys(secretPayload).length) {
            fullBundle.secrets = encryptSecrets(secretPayload, passphrase);
        }
    }

    const imagesRequested = sections === null || sections.has('images') || sections.has('shots');

    if (sections === null) return { bundle: fullBundle, imageFiles, imagesRequested };

    const bundle = { glp_backup: true, version: fullBundle.version, created: fullBundle.created, sections: [...sections] };
    for (const section of sections) {
        for (const key of SECTION_BUNDLE_KEYS[section] || []) {
            if (key in fullBundle) bundle[key] = fullBundle[key];
        }
    }
    return { bundle, imageFiles: imagesRequested ? imageFiles : [], imagesRequested };
}

// The legacy self-contained export shape: `bundle.images` embeds every image
// as base64, exactly what GET /api/backup has always returned and what any
// existing bookmark/tooling (or an already-downloaded backup file) expects.
// Used for GET (always) and kept around for anything that still wants a
// single self-contained JSON object instead of the zip shape below.
function buildBackupBundleJson(passphrase, sections) {
    const { bundle, imageFiles, imagesRequested } = gatherBackupData(passphrase, sections);
    if (imagesRequested) {
        bundle.images = Object.fromEntries(imageFiles.map(f => [f.filename, f.buffer.toString('base64')]));
    }
    return bundle;
}

// The zip export shape: `backup.json` (this same bundle, minus any embedded
// image bytes -- images travel as real files instead, see the module doc
// comment at the top of lib/zip.js for why) plus one `images/<filename>`
// entry per photo. Used by POST /api/backup, the only endpoint the export
// modal actually calls.
function buildBackupZip(passphrase, sections) {
    const { bundle, imageFiles, imagesRequested } = gatherBackupData(passphrase, sections);
    const entries = [{ name: 'backup.json', data: Buffer.from(JSON.stringify(bundle)) }];
    if (imagesRequested) {
        for (const { filename, buffer } of imageFiles) entries.push({ name: `images/${filename}`, data: buffer });
    }
    return createZip(entries);
}

router.get('/api/backup', (req, res, next) => {
    try {
        const bundle   = buildBackupBundleJson(null, null);
        const filename = `glp-backup-${backupTimestamp()}.json`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        bus.emit(EVENTS.BACKUP_EXPORTED, {});
        res.json(bundle);
    } catch (err) { next(err); }
});

// A passphrase must never travel in a URL (query strings end up in access
// logs, proxy logs and browser history), so including one is only possible
// via this POST variant's JSON body. GET above stays the plain, secrets-free,
// all-sections legacy JSON export for any existing bookmark/tooling and
// needs no request body at all.
//
// This is the only export endpoint the app's own UI calls, and it returns a
// zip (backup.json + real image files) rather than a single JSON object --
// see buildBackupZip() above for why. GET's JSON shape stays exactly as it
// was for anything external still depending on it.
router.post('/api/backup', (req, res, next) => {
    try {
        const passphrase = typeof req.body?.passphrase === 'string' && req.body.passphrase ? req.body.passphrase : null;
        const zip         = buildBackupZip(passphrase, normaliseSections(req.body?.sections));
        const filename    = `glp-backup-${backupTimestamp()}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        bus.emit(EVENTS.BACKUP_EXPORTED, {});
        res.send(zip);
    } catch (err) { next(err); }
});

// Restore accepts either the legacy self-contained JSON body (the shape
// every backup before #658 used, and what an already-downloaded .json file's
// restore request still sends -- old backups must keep working) or a zip
// body (backup.json + real image files, see buildBackupZip() above and
// lib/zip.js's module doc comment for why zip exists at all). Both are
// normalized here into the exact same `{ b, imagesMap }` shape the rest of
// the route already expects -- `b` mirrors the old `req.body` (the bundle
// object with dryRun/sections/passphrase mixed in), `imagesMap` is always
// `{ filename: Buffer }` (no base64 anywhere below this point).
//
// sections/passphrase/dryRun travel as headers on the zip path rather than
// inside the (binary) body -- specifically never as URL query parameters,
// same reasoning already documented above POST /api/backup for why a
// passphrase can't go in a URL (access logs, proxy logs, browser history).
// Headers aren't subject to any of those, and this app already has a
// precedent for carrying auth-adjacent data in a header (X-GLP-Token).
function normaliseRestoreRequest(req) {
    if (!req.is('application/zip')) {
        return { b: req.body, imagesMap: legacyImagesMap(req.body) };
    }
    if (!Buffer.isBuffer(req.body)) return { error: 'Invalid zip body' };
    let entries;
    try { entries = readZip(req.body); } catch (e) { return { error: `Invalid zip file: ${e.message}` }; }
    const backupJsonEntry = entries['backup.json'];
    if (!backupJsonEntry) return { error: 'Invalid backup file (no backup.json in zip)' };
    let parsed;
    try { parsed = JSON.parse(backupJsonEntry.toString('utf8')); } catch { return { error: 'Invalid backup file (backup.json is not valid JSON)' }; }

    let sectionsHeader;
    const sectionsHeaderRaw = req.get('X-GLP-Sections');
    if (sectionsHeaderRaw !== undefined) {
        try { sectionsHeader = JSON.parse(sectionsHeaderRaw); } catch { return { error: 'Invalid X-GLP-Sections header' }; }
    }
    const b = {
        ...parsed,
        dryRun:     req.get('X-GLP-Dry-Run') === 'true',
        sections:   sectionsHeader !== undefined ? sectionsHeader : parsed.sections,
        passphrase: req.get('X-GLP-Passphrase') || undefined,
    };
    const imagesMap = {};
    for (const [name, buf] of Object.entries(entries)) {
        if (name.startsWith('images/')) imagesMap[name.slice('images/'.length)] = buf;
    }
    return { b, imagesMap };
}

function legacyImagesMap(b) {
    const raw = b && typeof b === 'object' ? b.images : null;
    return Object.fromEntries(
        Object.entries(raw || {}).map(([name, base64]) => [name, Buffer.from(base64, 'base64')])
    );
}

router.post('/api/restore', (req, res, next) => {
    const { b, imagesMap, error } = normaliseRestoreRequest(req);
    if (error) return res.status(400).json({ error });

    // A dry run is read-only preview traffic the modal fires on every
    // section-checkbox toggle and passphrase keystroke (debounced, but still
    // several calls per interaction) — sharing the real restore's 3/min limit
    // meant just opening the modal and ticking a couple of boxes could 429
    // before the user ever clicked "Restore" (reported by Max). Real restores
    // stay tightly capped, since they wipe and replace live data; the dry-run
    // limit only needs to bound abuse, not user interaction speed.
    const isDryRun = b?.dryRun === true;
    const limitOk  = isDryRun
        ? rateLimit(`restore-preview:${req.ip}`, 30)
        : rateLimit(`restore:${req.ip}`, 3);
    if (!limitOk) return res.status(429).json({ error: 'Rate limit exceeded' });
    try {
        if (!b || b.glp_backup !== true || !Array.isArray(b.shots))
            return res.status(400).json({ error: 'Invalid backup file' });
        if (b.shots.length > MAX_SHOT_ID)
            return res.status(400).json({ error: `Backup contains too many shots (max ${MAX_SHOT_ID})` });

        // sections: which of the six domains (see BACKUP_SECTIONS above) to
        // actually apply. null = every domain present in the file, the
        // original/default behavior. A file's own top-level `sections` field
        // (written by an export that itself used a subset) is the fallback
        // when the restore request doesn't specify one explicitly, so
        // re-uploading a scoped export without picking anything on the
        // restore side still only touches what it was scoped to on export.
        const sections = normaliseSections(b.sections);
        const wantsShots = sections === null || sections.has('shots');
        const dryRun     = b.dryRun === true;

        // Per-shot validation only matters for data that will actually be
        // applied — if 'shots' isn't a selected section, garbage in an
        // array that's about to be ignored must not block restoring
        // everything else the caller did ask for.
        if (wantsShots) {
            for (let i = 0; i < b.shots.length; i++) {
                const s = b.shots[i];
                if (s === null || typeof s !== 'object')
                    return res.status(400).json({ error: `Backup shot #${i} is not a valid object` });
                if (!Number.isInteger(s.id) || s.id <= 0)
                    return res.status(400).json({ error: `Backup shot #${i} has an invalid id (${s.id})` });
                if (typeof s.timestamp !== 'number')
                    return res.status(400).json({ error: `Backup shot #${i} (id=${s.id}) has an invalid or missing timestamp` });
            }
        }

        // Decryption is pure in-memory work (no DB/filesystem side effects),
        // so it happens up front rather than inside the transaction below.
        // A wrong or missing passphrase must never fail the whole restore --
        // everything else still applies -- so this only ever downgrades to
        // "secrets not restored", reported back in the response so the UI can
        // tell the user their token/MQTT login specifically didn't come back.
        // Successful decryption is not, on its own, proof the values are
        // safe to use as-is: whoever can call this authenticated endpoint at
        // all already holds a valid API token (see the trust model above
        // GET /api/token) and could pick their own passphrase for a crafted
        // blob, so the decrypted apiToken is still bounded/sanitised below
        // exactly like every other restored field in this file.
        const wantsSecrets = sections === null || sections.has('secrets');
        const passphrase   = typeof b.passphrase === 'string' && b.passphrase ? b.passphrase : null;
        const secretsPresent   = wantsSecrets && !!(b.secrets && typeof b.secrets === 'object');
        const decryptedSecrets = secretsPresent && passphrase ? decryptSecrets(b.secrets, passphrase) : null;
        const secretsRestored  = decryptedSecrets !== null;

        // Every "what would actually be written" computation happens here,
        // before any DB/filesystem mutation and identically whether or not
        // this is a dry run -- a dry run's preview counts and the real
        // restore's applied counts can never drift apart, because they're
        // the same numbers.
        const pendingImageWrites = [];
        let sanitizedLib = null;
        if (wantsShots) {
            if (b.coffee_library) {
                sanitizedLib = sanitizeRestoredLibrary(b.coffee_library);
                validateRestoredLibraryImages(sanitizedLib, imagesMap, pendingImageWrites);
            }
            // Shot photos: same validation as library images, just not
            // nested under coffee_library -- each shot's own `.image`
            // field is mutated in place here, before shotService.upsertShot()
            // writes these same objects further down.
            validateEntityImages(b.shots, 'shot-', imagesMap, pendingImageWrites);
        }
        const validMaintenance = (sections === null || sections.has('maintenance')) && Array.isArray(b.maintenance)
            ? b.maintenance.map(sanitizeMaintenanceRow).filter(Boolean) : [];
        const validMaintenanceLog = (sections === null || sections.has('maintenance')) && Array.isArray(b.maintenance_log)
            ? b.maintenance_log.map(sanitizeMaintenanceLogRow).filter(Boolean) : [];
        const validOrders = (sections === null || sections.has('orders')) && Array.isArray(b.orders)
            ? b.orders.map(sanitizeOrderRow).filter(Boolean) : [];
        const wantsMachines = (sections === null || sections.has('machines')) && Array.isArray(b.machines);
        const wantsSettings = sections === null || sections.has('settings');
        const restoredToken = typeof decryptedSecrets?.apiToken === 'string'
            ? decryptedSecrets.apiToken.replace(/[\r\n\0]/g, '').trim().slice(0, 200) : '';

        if (dryRun) {
            return res.json({
                ok: true, dryRun: true,
                preview: {
                    shots:            wantsShots ? b.shots.length : 0,
                    library:          wantsShots && b.coffee_library ? true : false,
                    maintenance:      validMaintenance.length,
                    maintenanceTotal: Array.isArray(b.maintenance) ? b.maintenance.length : 0,
                    maintenanceLog:      validMaintenanceLog.length,
                    maintenanceLogTotal: Array.isArray(b.maintenance_log) ? b.maintenance_log.length : 0,
                    orders:      validOrders.length,
                    ordersTotal: Array.isArray(b.orders) ? b.orders.length : 0,
                    machines:    wantsMachines ? b.machines.length : 0,
                    settings:    wantsSettings && !!b.kv,
                    images:      pendingImageWrites.length,
                    secretsPresent, secretsRestored,
                    // Which of the six domains actually have their defining
                    // key(s) in `b` at all -- independent of `sections`
                    // filtering above, and independent of count (a section
                    // with e.g. zero shots is still a present, deliberately
                    // empty one, not an absent one -- see the comment on
                    // SECTION_PRESENCE_BUNDLE_KEYS). The zip restore path
                    // (public-src/components/backup-modal.js) has no local
                    // copy of the uploaded file to inspect the way the
                    // legacy JSON path does, so it needs this from the
                    // server to render the same restore checkboxes.
                    sectionsPresent: Object.keys(SECTION_PRESENCE_BUNDLE_KEYS)
                        .filter(key => SECTION_PRESENCE_BUNDLE_KEYS[key].some(k => k in b)),
                },
            });
        }

        // Single atomic transaction over the whole restore (wipe + re-insert +
        // library/blocklist/maintenance/orders/machines/kv) — shotRepo.wipeAll()
        // and the other repos' write methods each run their own db.transaction()
        // internally, which better-sqlite3 nests as a SAVEPOINT when already
        // inside this outer one, so the guarantee is unchanged: a failure
        // anywhere below rolls back the whole restore, including the wipe.
        // Every write is gated by the same section checks the preview above
        // used, so a deselected domain is left completely untouched rather
        // than wiped-then-left-empty.
        getDb().transaction(() => {
            if (wantsShots) {
                shotRepo.wipeAll();

                // #978: shotRepo.upsert() (not shotService.upsertShot()) --
                // the latter emits SHOT_SAVED per call, which would trigger a
                // full achievement-registry re-evaluation (a full context
                // rebuild + every badge's check()) once per restored shot. On
                // a large backup restored into a non-empty install that's
                // thousands of synchronous, increasingly expensive passes
                // back to back, blocking the event loop long enough for the
                // Supervisor watchdog to consider the process unresponsive
                // and kill it mid-transaction -- losing the entire restore
                // (see the single evaluateAll() trigger after the
                // transaction below for the fix, mirroring how
                // BACKUP_EXPORTED already evaluates once per export rather
                // than once per exported row).
                for (const shot of b.shots) shotRepo.upsert(shot);
                if (b.annotations && typeof b.annotations === 'object') {
                    for (const [id, ann] of Object.entries(b.annotations)) {
                        const parsed = annotationSchema.safeParse(ann);
                        if (parsed.success) shotService.saveAnnotation(parseInt(id), parsed.data);
                    }
                }

                // Trash: skip any entry whose shot id isn't among the shots
                // that were just restored above — defensive, and also what
                // makes a backup whose own trash refers to shot ids absent
                // from its own `shots` array (a real bug in pre-fix exports)
                // restore cleanly instead of creating a dangling trash row.
                if (b.trash && typeof b.trash === 'object' && !Array.isArray(b.trash)) {
                    const restoredShotIds = new Set(b.shots.map(s => s.id));
                    for (const [idStr, deletedAtRaw] of Object.entries(b.trash)) {
                        const id = parseInt(idStr, 10);
                        if (!Number.isInteger(id) || !restoredShotIds.has(id)) continue;
                        const deletedAt = Number.isFinite(deletedAtRaw) ? deletedAtRaw : Date.now();
                        shotRepo.setTrashEntry(id, deletedAt);
                    }
                }

                if (sanitizedLib) libService.saveLibrary(sanitizedLib);
                if (Array.isArray(b.blocklist)) shotService.saveBlocklist(b.blocklist.map(Number));
            }

            if (sections === null || sections.has('maintenance')) {
                if (Array.isArray(b.maintenance))     libraryRepo.restoreMaintenanceRaw(validMaintenance);
                if (Array.isArray(b.maintenance_log)) libraryRepo.restoreMaintenanceLogRaw(validMaintenanceLog);
            }
            if ((sections === null || sections.has('orders')) && Array.isArray(b.orders)) {
                orderRepo.replaceAll(validOrders);
            }
            if (wantsMachines) registry.restoreMachines(b.machines);

            if (wantsSettings && b.kv && typeof b.kv === 'object' && !Array.isArray(b.kv)) {
                if (Array.isArray(b.kv.menu)) saveMenu(b.kv.menu);
                if (b.kv.orders_settings && typeof b.kv.orders_settings === 'object') saveOrdersSettings(b.kv.orders_settings);
                if (b.kv.notify_mapping && typeof b.kv.notify_mapping === 'object') saveNotifyMapping(b.kv.notify_mapping);
                if (b.kv.import_settings && typeof b.kv.import_settings === 'object') importSettingsRepo.saveSettings(b.kv.import_settings);
                if (b.kv.mqtt_settings && typeof b.kv.mqtt_settings === 'object') {
                    // Defense in depth: strip username/password even though our
                    // own export never includes them, in case a hand-edited
                    // backup file smuggles them back in. saveSettings() merges
                    // into the currently stored settings rather than
                    // overwriting, so an existing local password already
                    // survives this regardless.
                    const { username: _u, password: _p, ...rest } = b.kv.mqtt_settings;
                    mqttSettingsRepo.saveSettings(rest);
                }
            }

            // Decrypted MQTT credentials, independent of the b.kv block above
            // (a secrets-only restore is valid) — saveSettings() merges
            // rather than overwrites, matching the plaintext path.
            if (decryptedSecrets?.mqtt && typeof decryptedSecrets.mqtt === 'object') {
                const { username, password } = decryptedSecrets.mqtt;
                mqttSettingsRepo.saveSettings({
                    username: typeof username === 'string' ? username.slice(0, 200) : '',
                    password: typeof password === 'string' ? password.slice(0, 500) : '',
                });
            }
        })();

        // #978: one achievement re-evaluation pass for the whole restore,
        // once every restored domain (shots, library, maintenance, orders --
        // all of it, since this fires after the transaction above commits)
        // is actually in place, instead of one storm-triggering SHOT_SAVED
        // per shot inside the loop above. No badge's check() keys off
        // SHOT_SAVED's payload (see lib/achievements/registry.js), so a
        // single bare emit here reaches the exact same end state.
        if (wantsShots && b.shots.length) bus.emit(EVENTS.SHOT_SAVED, {});

        // Deferred until after the DB transaction commits, same reasoning as
        // the image writes below: TOKEN_FILE is a filesystem write and can't
        // roll back with the SQLite transaction. Every character that isn't
        // safe in an HTTP header value (this token round-trips through
        // X-GLP-Token on every subsequent request) was already stripped
        // above rather than rejecting the whole restore over it.
        if (restoredToken) {
            try {
                state.apiToken = restoredToken;
                writeFileSafe(TOKEN_FILE, restoredToken);
            } catch (e) {
                log(`Restore: failed to write restored API token: ${e.message}`, true);
            }
        }

        for (const { path: filePath, buffer } of pendingImageWrites) {
            try {
                fs.mkdirSync(BEAN_IMAGE_DIR, { recursive: true });
                fs.writeFileSync(filePath, buffer);
            } catch (e) {
                log(`Restore: failed to write image ${filePath}: ${e.message}`, true);
            }
        }

        log(`Restore completed from backup v${b.version || '?'} (${wantsShots ? b.shots.length : 0} shots, `
            + `${validMaintenance.length} maintenance rows, ${validMaintenanceLog.length} log entries, `
            + `${validOrders.length} orders, ${wantsMachines ? b.machines.length : 0} machines, ${pendingImageWrites.length} images)`
            + (secretsPresent ? `, secrets ${secretsRestored ? 'restored' : 'NOT restored (wrong/missing passphrase?)'}` : ''));
        res.json({
            ok: true, shots: wantsShots ? b.shots.length : 0,
            // Only meaningful when the backup actually had a `secrets` block;
            // the frontend uses secretsPresent to decide whether to even
            // mention secrets in its result message at all.
            secretsPresent, secretsRestored,
        });
    } catch (err) { next(err); }
});

module.exports = router;
