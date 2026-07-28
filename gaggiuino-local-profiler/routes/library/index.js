// #550: routes/library.js used to serve five distinct resources (whole
// library, beans, images, milks, grinders, recipes) from one 567-line
// router. Split into per-resource modules for readability, but all still
// register onto this ONE shared express.Router() rather than each getting
// its own Router mounted as a sub-router of this one.
//
// That distinction matters at runtime, not just style: the `router` package
// Express 5 uses defers to `setImmediate` once per Router instance whenever
// that instance's own layer stack is exhausted without a match (see
// node_modules/router/index.js's "no more matching layers" branch). A flat
// router hits that at most once per request; nested Router-in-Router
// mounting hits it once per non-matching sub-router. Harmless in real time,
// but it silently starves any test using vi.useFakeTimers() elsewhere in
// the request path (setImmediate never fires without a manual timer
// advance) — this happened once during the split and is the reason for
// this comment.
const express = require('express');
const router  = express.Router();

const { loadLibrary } = require('../../lib/data');
const libraryService = require('../../lib/services/LibraryService');

router.get('/api/library', (req, res) => {
    const lib = loadLibrary();
    if (Array.isArray(lib.grinders)) {
        lib.grinders = lib.grinders.map(g => ({ ...g, wear: libraryService.computeGrinderWearStats(g) }));
    }
    res.json(lib);
});

require('./beans')(router);
require('./milks')(router);
require('./grinders')(router);
require('./recipes')(router);

module.exports = router;
