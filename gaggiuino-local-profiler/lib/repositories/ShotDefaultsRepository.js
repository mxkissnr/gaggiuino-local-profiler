// #654: optional per-install defaults auto-prefilled into a brand-new shot's
// annotation panel (Drink Type, Coffee/Bean, Basket, Puck Screen, Grinder,
// Dose) — same kv-table storage pattern as ImportSettingsRepository. Never
// applied to a shot that already has any annotation data; that decision is
// made client-side (public-src/views/shots/annotation.js's
// _applyShotDefaults()), this repository just persists the configured values.
const { getDb } = require('../db');

const DEFAULTS = {
    drinkType:    null,
    coffee:       null,
    beanId:       null,
    basketId:     null,
    puckScreenId: null,
    grinder:      '',
    dose:         null,
};

class ShotDefaultsRepository {
    getDefaults() {
        const db  = getDb();
        const row = db.prepare("SELECT value FROM kv WHERE key = 'shot_defaults'").get();
        if (!row) return { ...DEFAULTS };
        try {
            return { ...DEFAULTS, ...JSON.parse(row.value) };
        } catch { return { ...DEFAULTS }; }
    }

    saveDefaults(defaults) {
        getDb().prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('shot_defaults', ?)").run(JSON.stringify(defaults));
    }
}

module.exports = new ShotDefaultsRepository();
