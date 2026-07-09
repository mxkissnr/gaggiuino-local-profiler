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

    // Beans that are actually still in stock, shaped for the order card.
    // bean.enabled is a manual override, independent of stock — a bean can
    // have stock left but the user doesn't want it offered right now. Checked
    // with `!== false` (not `=== true`) so beans without the field (all
    // pre-existing beans) keep showing up.
    getActiveBeans() {
        const doseRows = shotRepo.getAnnotatedDoses();
        return (this.getLibrary().beans || [])
            .map(b => ({ bean: b, remaining: this.computeBeanRemaining(b, doseRows) }))
            .filter(({ remaining, bean }) => remaining !== null && remaining > 0 && bean.enabled !== false)
            .map(({ bean, remaining }) => ({
                id: bean.id, name: bean.name, roaster: bean.roaster || null,
                decaf: !!bean.decaf, remaining,
                // customer-facing description data for the order card
                notes: bean.notes || null, origin: bean.origin || null, process: bean.process || null,
                variety: bean.variety || null, species: bean.species || null,
            }));
    }

    // Milks that still have stock, shaped for the order card — mirrors
    // getActiveBeans(), but milk stock is an explicit running total (deducted
    // on order completion) rather than inferred from shot annotations.
    getActiveMilks() {
        return (this.getLibrary().milks || [])
            .filter(m => (m.stockMl || 0) > 0)
            .map(m => ({ id: m.id, name: m.name, emoji: m.emoji || null, remaining: m.stockMl }));
    }

    // Deducts ml from a milk by name (case-insensitive, same join precedent as
    // bean/grinder name matching elsewhere). No-op if no matching milk or the
    // milk is already out of stock. Returns the updated milk, or null.
    deductMilkByName(name, ml) {
        if (!name || !(ml > 0)) return null;
        const lib  = this.getLibrary();
        const key  = String(name).toLowerCase();
        const milk = (lib.milks || []).find(m => String(m.name || '').toLowerCase() === key);
        if (!milk) return null;
        milk.stockMl = Math.max(0, (milk.stockMl || 0) - ml);
        milk.updatedAt = Date.now();
        this.saveLibrary(lib);
        return milk;
    }

    // Beans imported before 1.96.0 carry "Herkunft: X" / "Aufbereitung: Y" as
    // free text in notes (the structured fields did not exist yet) and the old
    // import join left ", ," artifacts from empty spans. Idempotent startup
    // migration: extract into the structured fields when they are empty and
    // clean the artifacts.
    migrateImportedNotes() {
        const { mapOriginToCode } = require('../coffee-countries');
        const lib = this.getLibrary();
        let changed = 0;
        for (const bean of lib.beans || []) {
            if (typeof bean.notes !== 'string' || !bean.notes) continue;
            let dirty = false;
            let segments = bean.notes.split('·').map(s => s.trim()).filter(Boolean);
            segments = segments.filter(seg => {
                const hm = seg.match(/^Herkunft:\s*(.+)$/i);
                if (hm && !bean.origin) {
                    const code = mapOriginToCode(hm[1].trim());
                    if (code) { bean.origin = code; dirty = true; return false; }
                    return true;
                }
                const pm = seg.match(/^Aufbereitung:\s*(.+)$/i);
                if (pm && !bean.process) {
                    bean.process = pm[1].trim().slice(0, 200);
                    dirty = true;
                    return false;
                }
                return true;
            });
            // ", ," artifacts only — leave ordinary commas (incl. decimals) alone
            const cleaned = segments.map(seg => /,\s*,/.test(seg)
                ? seg.split(',').map(s => s.trim()).filter(Boolean).join(', ')
                : seg
            ).join(' · ');
            if (cleaned !== bean.notes) { bean.notes = cleaned; dirty = true; }
            if (dirty) changed++;
        }
        if (changed) {
            this.saveLibrary(lib);
            log(`Migrated imported notes into structured fields on ${changed} bean(s)`);
        }
        return changed;
    }

    // Lightweight bean metadata for external consumers (Lovelace shot card):
    // descriptive fields only, no stock math. roastDate prefers the active bag.
    // Deliberately NOT gated by bean.enabled: this is a "describe this bean"
    // lookup for shots that already reference the bean by name (e.g. past
    // shots logged while it was enabled), not an "offer for selection" list
    // like getActiveBeans() — disabling a bean shouldn't make historical shot
    // cards unable to resolve its metadata.
    getBeansInfo() {
        return (this.getLibrary().beans || []).map(bean => {
            const bags      = Array.isArray(bean.bags) ? bean.bags : [];
            const activeBag = bags.length ? bags[bags.length - 1] : null;
            return {
                id:        bean.id,
                name:      bean.name,
                roaster:   bean.roaster || null,
                origin:    bean.origin  || null,
                variety:   bean.variety || null,
                species:   bean.species || null,
                process:   bean.process || null,
                flavors:   Array.isArray(bean.flavors) && bean.flavors.length ? bean.flavors : null,
                roastType: bean.roastType || null,
                hasImage:  !!bean.image,
                roastDate: activeBag?.roastDate || bean.roastDate || null,
                decaf:     !!bean.decaf,
            };
        });
    }

    // Imported beans stored their aroma list as the first notes segment before
    // flavors existed. Idempotent startup migration: only beans with `source`
    // (imported) and empty flavors; the segment must look like an aroma list
    // (no key prefix, no sentence punctuation, short comma tokens) so personal
    // notes are never touched.
    migrateNotesToFlavors() {
        const lib = this.getLibrary();
        let changed = 0;
        for (const bean of lib.beans || []) {
            if (!bean.source) continue;
            if (Array.isArray(bean.flavors) && bean.flavors.length) continue;
            if (typeof bean.notes !== 'string' || !bean.notes) continue;
            const segments = bean.notes.split('·').map(s => s.trim()).filter(Boolean);
            const first = segments[0];
            if (!first) continue;
            if (/^(Herkunft|Röstgrad|Aufbereitung|Prozess|Varietät|Importeur|Ernte):/i.test(first)) continue;
            if (/[.!?]/.test(first) || first.length > 120) continue;
            const tokens = first.split(',').map(s => s.trim()).filter(Boolean);
            if (!tokens.length || tokens.length > 8 || tokens.some(t => t.length > 40)) continue;
            bean.flavors = tokens;
            bean.notes   = segments.slice(1).join(' · ');
            changed++;
        }
        if (changed) {
            this.saveLibrary(lib);
            log(`Migrated notes aroma segment into flavors on ${changed} bean(s)`);
        }
        return changed;
    }

    // Beans predate the blend-capable origins[] array and only have a single
    // `origin` string. Idempotent (guarded by Array.isArray) — safe to call
    // on every boot.
    migrateOriginToOrigins() {
        const lib = this.getLibrary();
        let changed = 0;
        for (const bean of lib.beans || []) {
            if (Array.isArray(bean.origins)) continue;
            bean.origins = bean.origin ? [{ code: bean.origin }] : [];
            changed++;
        }
        if (changed) {
            this.saveLibrary(lib);
            log(`Migrated origin to origins on ${changed} bean(s)`);
        }
        return changed;
    }

    // The "Varietät" field used to hold species names (Arabica/Robusta/Blend)
    // alongside real cultivars (Bourbon, Geisha, ...) — see SPECIES_OPTIONS
    // vs VARIETY_SUGGESTIONS in public-src/constants.js. Idempotent startup
    // migration: only exact species matches (case-insensitive, trimmed) are
    // moved; anything else (e.g. "Red Bourbon") is left untouched — no fuzzy
    // matching, since variety is free text and guessing would misfire.
    migrateVarietyToSpecies() {
        const SPECIES_BY_KEY = { arabica: 'Arabica', robusta: 'Robusta', blend: 'Blend' };
        const lib = this.getLibrary();
        let changed = 0;
        for (const bean of lib.beans || []) {
            if (bean.species) continue;
            if (typeof bean.variety !== 'string') continue;
            const key = bean.variety.trim().toLowerCase();
            const species = SPECIES_BY_KEY[key];
            if (!species) continue;
            bean.species = species;
            bean.variety = '';
            changed++;
        }
        if (changed) {
            this.saveLibrary(lib);
            log(`Migrated variety to species on ${changed} bean(s)`);
        }
        return changed;
    }

    // Fire-and-forget after bean save: download the imported image once and
    // record its extension. Never blocks the response; a failed download
    // simply leaves the bean without an image.
    async setBeanImage(beanId, imageUrl) {
        const { fetchBeanImage, deleteBeanImage } = require('./ImageService');
        const ext = await fetchBeanImage(beanId, imageUrl);
        if (!ext) return;
        const lib  = this.getLibrary();
        const bean = (lib.beans || []).find(b => b.id === beanId);
        if (!bean) { deleteBeanImage(beanId, ext); return; }
        if (bean.image && bean.image !== ext) deleteBeanImage(beanId, bean.image);
        bean.image = ext;
        this.saveLibrary(lib);
    }

    // Fire-and-forget after bean save: resolve the growing region to
    // coordinates for the origin map. Never blocks the response; results
    // land in bean.location on a later library read.
    async geocodeBean(beanId) {
        const { geocodeRegion } = require('../geo');
        const lib  = this.getLibrary();
        const bean = (lib.beans || []).find(b => b.id === beanId);
        if (!bean || !bean.region) return;
        let countryName = '';
        if (bean.origin) {
            try { countryName = new Intl.DisplayNames(['en'], { type: 'region' }).of(bean.origin) || ''; }
            catch { /* raw code is fine as fallback */ }
        }
        const location = await geocodeRegion(bean.region, countryName);
        // re-load: the bean may have changed while we were waiting
        const fresh = this.getLibrary();
        const target = (fresh.beans || []).find(b => b.id === beanId);
        if (!target || target.region !== bean.region) return;
        target.location = location;
        this.saveLibrary(fresh);
        if (location) log(`Geocoded bean "${bean.name}" region "${bean.region}" -> ${location.lat},${location.lon}`);
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
