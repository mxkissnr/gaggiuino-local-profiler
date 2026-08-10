// #722: dev-channel-only raw SQLite export for troubleshooting live user bug
// reports (see #721, where support had to reconstruct DB state from a text
// log alone because there was no way to just grab the DB). The existing
// GET/POST /api/backup is a curated, sectioned, secrets-redacted export --
// this route is deliberately the opposite: the entire raw glp.db file,
// unfiltered, meant only for a maintainer troubleshooting a dev-channel
// install, never for a real user's production install.
//
// Safety mechanism: gated on process.env.GLP_DEV_BUILD, the same flag
// routes/system.js's /api/status devBuild field and server.js's startup log
// suffix already use (only ever set by .github/workflows/build-dev.yaml's
// Docker build-arg for the dev-channel image -- never set for a real
// install, even once this code reaches `main` at the next release, since
// `dev` merges fully into `main` and keeping it out of that history is not
// itself a safety mechanism). The check is the first thing the handler does,
// unconditionally, before the database is touched at all.
'use strict';
const express = require('express');
const router  = express.Router();

const { getDb, DB_PATH } = require('../lib/db');
const { log } = require('../lib/helpers');

// Mirrors routes/backup.js's own backupTimestamp() (kept as a separate copy
// rather than a shared helper, same reasoning that file documents for its
// browser-side twin in backup-modal.js).
function exportTimestamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

router.get('/api/debug/export-db', (req, res) => {
    // Must stay first and unconditional: a real install never sets
    // GLP_DEV_BUILD, so this 404s exactly as if the route didn't exist at
    // all -- no distinguishing response that would leak a gated route exists.
    if (!process.env.GLP_DEV_BUILD) return res.status(404).end();

    try {
        // WAL mode (lib/db.js) means recent writes can still be sitting in
        // the -wal file rather than glp.db itself -- checkpoint first so the
        // downloaded file actually reflects everything committed so far.
        getDb().pragma('wal_checkpoint(TRUNCATE)');
        const filename = `glp-db-export-${exportTimestamp()}.db`;
        res.download(DB_PATH, filename, (err) => {
            if (err) log(`DB export download failed: ${err.message}`, true);
        });
    } catch (err) {
        log(`DB export failed: ${err.message}`, true);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
