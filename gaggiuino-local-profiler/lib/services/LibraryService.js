const repo    = require('../repositories/LibraryRepository');
const shotRepo = require('../repositories/ShotRepository');
const { log } = require('../helpers');
const { LOW_STOCK_THRESHOLD_G } = require('../constants');

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

    // Remaining grams for a stock-tracked bean — mirrors the library view's math
    // (public-src/views/library.js): consumed = sum of annotated doses of shots
    // matching the bean name (case-insensitive) since the active bag was opened;
    // without bags, all matching shots count. Returns null when stock is untracked.
    computeBeanRemaining(bean, doseRows) {
        if (!(bean.stock_g > 0)) return null;
        const bags      = Array.isArray(bean.bags) ? bean.bags : [];
        const activeBag = bags.length ? bags[bags.length - 1] : null;
        const openedAt  = activeBag?.openedAt || 0;
        const name      = String(bean.name || '').toLowerCase();
        const consumed  = doseRows.reduce((sum, r) => {
            const d = parseFloat(r.dose);
            if (!d) return sum;
            if (String(r.coffee || '').toLowerCase() !== name) return sum;
            if (activeBag && r.timestamp * 1000 < openedAt) return sum;
            return sum + d;
        }, 0);
        return Math.round(bean.stock_g - Math.round(consumed));
    }

    // Beans that are actually still in stock, shaped for the order card
    getActiveBeans() {
        const doseRows = shotRepo.getAnnotatedDoses();
        return (this.getLibrary().beans || [])
            .map(b => ({ bean: b, remaining: this.computeBeanRemaining(b, doseRows) }))
            .filter(({ remaining }) => remaining !== null && remaining > 0)
            .map(({ bean, remaining }) => ({
                id: bean.id, name: bean.name, roaster: bean.roaster || null,
                decaf: !!bean.decaf, remaining,
                // customer-facing description data for the order card
                notes: bean.notes || null, origin: bean.origin || null, process: bean.process || null,
                variety: bean.variety || null,
            }));
    }

    // One-time low-stock push per bag: after a shot annotation, when the
    // named bean's remaining falls below the threshold, notify the barista
    // device (same channel as the preheat notification). The notified flag
    // lives on the active bag, so a new bag re-arms automatically.
    async checkLowStockNotify(coffeeName) {
        if (!coffeeName) return;
        const lib  = this.getLibrary();
        const name = String(coffeeName).toLowerCase();
        const bean = (lib.beans || []).find(b => String(b.name || '').toLowerCase() === name);
        if (!bean) return;
        const bags      = Array.isArray(bean.bags) ? bean.bags : [];
        const activeBag = bags.length ? bags[bags.length - 1] : null;
        if (!activeBag || activeBag.lowStockNotifiedAt) return;
        const remaining = this.computeBeanRemaining(bean, shotRepo.getAnnotatedDoses());
        if (remaining === null || remaining >= LOW_STOCK_THRESHOLD_G) return;
        const { loadOrdersSettings }           = require('../data');
        const { sendHaNotify, getHaLanguage }  = require('../ha');
        const { notifyT }                      = require('../notify-i18n');
        const svc = loadOrdersSettings().baristaNotifyService;
        if (!svc) return;
        const lang = await getHaLanguage();
        await sendHaNotify(svc,
            notifyT(lang, 'low_stock_title'),
            notifyT(lang, 'low_stock_body', bean.name, Math.max(remaining, 0)),
            `glp_low_stock_${bean.id}`);
        activeBag.lowStockNotifiedAt = Date.now();
        this.saveLibrary(lib);
        log(`Low-stock notification sent for bean "${bean.name}" (${remaining} g left)`);
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
