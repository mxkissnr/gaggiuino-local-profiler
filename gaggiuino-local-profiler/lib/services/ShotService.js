const repo              = require('../repositories/ShotRepository');
const { calcShotScore } = require('../score');
const libraryService    = require('./LibraryService');
const { log }           = require('../helpers');
const { MAX_SHOT_ID, ALLOWED_URL_SCHEMES } = require('../constants');

class ShotService {
    // machineId optional (#341) — omitted keeps the original all-machines
    // behavior every pre-existing call site (shots list, backup export)
    // relies on; pass it to scope to one machine (e.g. sync's own-machine
    // max-id lookups, which must never be confused by another machine's
    // shots living in the same table under disjoint synthetic ids).
    getAll(machineId) { return repo.findAllExcludingTrash(machineId); }
    getById(id)       { return repo.findById(id); }
    getAnnotation(id) { return repo.getAnnotation(id); }
    getLatestId(machineId) { return repo.getLatestId(machineId); }

    // #402: same-profile auto-compare reference for the shot detail view.
    getPreviousByProfile(shot) {
        if (!shot || !shot.profileName) return null;
        return repo.findPreviousByProfile(shot.id, shot.profileName, shot.machineId ?? 1);
    }

    saveAnnotation(shotId, annotation) {
        repo.saveAnnotation(shotId, annotation);
        return repo.getAnnotation(shotId);
    }

    setImage(id, ext)  { return repo.setImage(id, ext); }
    clearImage(id)     { return repo.clearImage(id); }

    trashShot(id) {
        if (!repo.findById(id)) throw Object.assign(new Error('Shot not found'), { status: 404 });
        repo.moveToTrash(id);
    }

    restoreShot(id) {
        repo.restoreFromTrash(id);
    }

    permanentDelete(id) {
        repo.deleteById(id);
    }

    getTrash() {
        const trash = repo.getTrash();
        const allIds = Object.keys(trash).map(Number);
        return allIds.map(id => repo.findById(id)).filter(Boolean);
    }

    getBlocklist()     { return repo.getBlocklist(); }
    saveBlocklist(list) { repo.saveBlocklist(list); }

    purgeExpiredTrash() {
        const purged = repo.purgeExpiredTrash();
        if (purged.length) log(`Auto-purged ${purged.length} shot(s) from trash (>30 days)`);
        return purged;
    }

    importShots(incoming) {
        const existing = new Set(repo.findAll().map(s => s.id));
        const newShots = incoming.filter(s => !existing.has(s.id) && s.id <= MAX_SHOT_ID);
        if (newShots.length) {
            repo.upsertMany(newShots);
            log(`Imported ${newShots.length} new shot(s)`);
        }
        return newShots.length;
    }

    upsertShot(shot) {
        return repo.upsert(shot);
    }

    // #450: scores against the bean's own brewTempC/brewRatio recommendation
    // (resolved via the shot's annotation.coffee name) when the library has
    // one set, instead of only the generic fixed bands — see lib/score.js.
    computeScore(shot) {
        const bean = libraryService.findBeanByName(shot?.annotation?.coffee);
        return calcShotScore(shot, bean);
    }
}

module.exports = new ShotService();
