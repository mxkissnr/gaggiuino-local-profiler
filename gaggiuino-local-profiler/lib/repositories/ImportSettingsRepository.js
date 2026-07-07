const { getDb } = require('../db');

const DEFAULTS = { disabledProviders: [], customShopifyDomains: [] };

class ImportSettingsRepository {
    getSettings() {
        const db  = getDb();
        const row = db.prepare("SELECT value FROM kv WHERE key = 'import_settings'").get();
        if (!row) return { ...DEFAULTS };
        try {
            const saved = JSON.parse(row.value);
            return {
                disabledProviders:    Array.isArray(saved.disabledProviders)    ? saved.disabledProviders    : [],
                customShopifyDomains: Array.isArray(saved.customShopifyDomains) ? saved.customShopifyDomains : [],
            };
        } catch { return { ...DEFAULTS }; }
    }

    saveSettings(settings) {
        getDb().prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('import_settings', ?)").run(JSON.stringify(settings));
    }
}

module.exports = new ImportSettingsRepository();
