const repo              = require('../repositories/ShotRepository');
const { calcShotScore } = require('../score');
const { log }           = require('../helpers');
const { MAX_SHOT_ID, ALLOWED_URL_SCHEMES } = require('../constants');

class ShotService {
    getAll()          { return repo.findAllExcludingTrash(); }
    getById(id)       { return repo.findById(id); }
    getAnnotation(id) { return repo.getAnnotation(id); }

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

    computeScore(shot) {
        return calcShotScore(shot);
    }
}

module.exports = new ShotService();
