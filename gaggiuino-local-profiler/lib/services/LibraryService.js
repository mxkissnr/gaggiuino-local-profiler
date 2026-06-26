const repo    = require('../repositories/LibraryRepository');
const shotRepo = require('../repositories/ShotRepository');
const { log } = require('../helpers');

class LibraryService {
    getLibrary()         { return repo.getLibrary(); }
    saveLibrary(lib)     { repo.saveLibrary(lib); }
    getMaintenance()     { return repo.getMaintenance(); }
    saveMaintenance(d)   { repo.saveMaintenance(d); }
    getMaintenanceLog()  { return repo.getMaintenanceLog(); }

    addMaintenanceLogEntry(task, notes, machine) {
        const shotCount = shotRepo.findAll().length;
        return repo.addMaintenanceLogEntry(task, notes, machine, shotCount);
    }

    computeMaintenanceStats(maint) {
        const shots = shotRepo.findAllExcludingTrash();
        const now   = Date.now();
        const result = {};
        for (const [key, task] of Object.entries(maint)) {
            const lastTs     = task.lastDate ? new Date(task.lastDate).getTime() : 0;
            const daysSince  = lastTs ? Math.floor((now - lastTs) / 86400000) : null;
            const shotsSince = shots.filter(s => s.timestamp * 1000 > lastTs).length;
            let pct = 0;
            if (task.threshold_shots && task.threshold_days)
                pct = Math.max(shotsSince / task.threshold_shots, daysSince !== null ? daysSince / task.threshold_days : 0);
            else if (task.threshold_shots)
                pct = shotsSince / task.threshold_shots;
            else if (task.threshold_days)
                pct = daysSince !== null ? daysSince / task.threshold_days : 0;
            const status = !task.lastDate ? 'never' : pct >= 1 ? 'due' : pct >= 0.8 ? 'soon' : 'ok';
            result[key] = { ...task, daysSince, shotsSince, pct: Math.min(pct, 1), status };
        }
        return result;
    }
}

module.exports = new LibraryService();
