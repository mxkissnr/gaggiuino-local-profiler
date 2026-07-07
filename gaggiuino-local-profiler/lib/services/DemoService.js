// Demo mode (#274): seeds/removes a static sample dataset so first-run users
// with no machine reachable yet can still see the app populated. Seeded rows
// are tracked in the kv table (key 'demo_seed') rather than a new `demo`
// column — matches the existing kv-table pattern already used for the
// geocode cache (see lib/geo.js) and is far less invasive than a migration.
const { getDb }        = require('../db');
const shotRepo          = require('../repositories/ShotRepository');
const libraryRepo       = require('../repositories/LibraryRepository');
const { buildDemoDataset } = require('../demo-seed');

const KV_KEY = 'demo_seed';

function _loadSeedRecord() {
    const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(KV_KEY);
    return row ? JSON.parse(row.value) : null;
}

function _saveSeedRecord(record) {
    getDb().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(KV_KEY, JSON.stringify(record));
}

function _clearSeedRecord() {
    getDb().prepare('DELETE FROM kv WHERE key = ?').run(KV_KEY);
}

class DemoService {
    isDemoActive() {
        return !!_loadSeedRecord()?.active;
    }

    // Refuses to seed on top of real data — checked by the route before
    // calling seedDemoData().
    isEmpty() {
        if (shotRepo.count() > 0) return false;
        const lib = libraryRepo.getLibrary();
        return (lib.beans?.length ?? 0) === 0 && (lib.recipes?.length ?? 0) === 0;
    }

    seedDemoData() {
        const { shots, beans, recipes } = buildDemoDataset();

        for (const shot of shots) shotRepo.upsert(shot);

        const lib = libraryRepo.getLibrary();
        lib.beans   = [...(lib.beans ?? []), ...beans];
        lib.recipes = [...(lib.recipes ?? []), ...recipes];
        libraryRepo.saveLibrary(lib);

        _saveSeedRecord({
            active:    true,
            shotIds:   shots.map(s => s.id),
            beanIds:   beans.map(b => b.id),
            recipeIds: recipes.map(r => r.id),
            seededAt:  Date.now(),
        });
    }

    // Deletes exactly the rows recorded at seed time — nothing else.
    endDemo() {
        const record = _loadSeedRecord();
        if (!record) return;

        for (const id of record.shotIds ?? []) shotRepo.deleteById(id);

        const lib = libraryRepo.getLibrary();
        const beanIds   = new Set(record.beanIds ?? []);
        const recipeIds = new Set(record.recipeIds ?? []);
        lib.beans   = (lib.beans ?? []).filter(b => !beanIds.has(b.id));
        lib.recipes = (lib.recipes ?? []).filter(r => !recipeIds.has(r.id));
        libraryRepo.saveLibrary(lib);

        _clearSeedRecord();
    }
}

module.exports = new DemoService();
