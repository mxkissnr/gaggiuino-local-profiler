// Bean/grinder field sanitizers — shared by the regular library POST/PUT
// routes and the /api/restore path, so restored data goes through the same
// validation instead of bypassing it (see routes/backup.js and
// routes/library.js). Pure functions, no Express/DB dependency.

function s(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// Origin is an ISO 3166-1 alpha-2 country code (join key for the origin map);
// anything else is dropped rather than stored.
function sanitizeOrigin(v) {
    if (typeof v !== 'string') return '';
    const code = v.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : '';
}

// Blend-capable origins: an array of { code, percent? }. Percent is an
// optional weighting used by the world map (see LibraryService/analytics);
// it does not need to sum to 100 across entries — it's a weight, not a
// validated composition. Deduped by code, capped at 5 (blends realistically
// rarely exceed 3-4 components).
function sanitizeOrigins(v) {
    if (!Array.isArray(v)) return [];
    const seen = new Set();
    const out  = [];
    for (const item of v) {
        const code = sanitizeOrigin(item?.code);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        let percent = null;
        if (item?.percent !== undefined && item.percent !== null && item.percent !== '') {
            const n = parseFloat(item.percent);
            if (Number.isFinite(n) && n >= 0 && n <= 100) percent = Math.round(n * 10) / 10;
        }
        out.push(percent !== null ? { code, percent } : { code });
        if (out.length >= 5) break;
    }
    return out;
}

const ROAST_TYPES = new Set(['espresso', 'filter', 'omni']);
function sanitizeRoastType(v) {
    return typeof v === 'string' && ROAST_TYPES.has(v) ? v : '';
}

// Flavors are short tags (chips UI); dedupe case-insensitively, cap counts.
function sanitizeFlavors(v) {
    if (!Array.isArray(v)) return [];
    const seen = new Set();
    const out  = [];
    for (const item of v) {
        if (typeof item !== 'string') continue;
        const s = item.trim().slice(0, 50);
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
        if (out.length >= 20) break;
    }
    return out;
}

function sanitizeAltitude(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 && n <= 3000 ? n : null;
}

function sanitizePrice(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 && n <= 500 ? Math.round(n * 100) / 100 : null;
}

// Roaster brew recommendation — manual-only (no import source provides these
// as structured data; see DOCS). Sensible ranges: 80-100°C covers filter
// through near-boiling pour-over, 5-300s covers espresso through cold-adjacent
// filter brews.
function sanitizeBrewTemp(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 80 && n <= 100 ? Math.round(n * 10) / 10 : null;
}

function sanitizeBrewTime(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 5 && n <= 300 ? n : null;
}

// Applies every field sanitizer to a bean-shaped object, preserving
// structural fields (id, bags, image, location, source, importedAt, ...)
// unchanged — used by /api/restore to sanitize a whole restored
// coffee_library without reconstructing bean objects from scratch (which
// would lose bags/image/location and diverge from the regular POST/PUT
// bean routes' behavior).
function sanitizeBeanFields(bean) {
    if (!bean || typeof bean !== 'object') return bean;
    let sanitizedOrigins = sanitizeOrigins(bean.origins);
    if (!sanitizedOrigins.length) {
        const code = sanitizeOrigin(bean.origin);
        if (code) sanitizedOrigins = [{ code }];
    }
    return {
        ...bean,
        name: s(bean.name, 200) || bean.name,
        roaster: s(bean.roaster, 200),
        roastDate: s(bean.roastDate, 10),
        notes: s(bean.notes, 1000),
        origin: sanitizedOrigins[0]?.code || '',
        origins: sanitizedOrigins,
        variety: s(bean.variety, 200),
        process: s(bean.process, 200),
        flavors: sanitizeFlavors(bean.flavors),
        roastType: sanitizeRoastType(bean.roastType),
        region: s(bean.region, 200),
        altitude_m: sanitizeAltitude(bean.altitude_m),
        importer: s(bean.importer, 200),
        harvest: s(bean.harvest, 50),
        price_eur: sanitizePrice(bean.price_eur),
        producer: s(bean.producer, 200),
        certification: s(bean.certification, 200),
        brewTempC: sanitizeBrewTemp(bean.brewTempC),
        brewRatio: s(bean.brewRatio, 20),
        brewTimeS: sanitizeBrewTime(bean.brewTimeS),
        brewNotes: s(bean.brewNotes, 300),
    };
}

// Mirrors the field set/limits from the regular grinder POST/PUT routes.
function sanitizeGrinderFields(grinder) {
    if (!grinder || typeof grinder !== 'object') return grinder;
    return {
        ...grinder,
        name: s(grinder.name, 200) || grinder.name,
        notes: s(grinder.notes, 1000),
        burrType: s(grinder.burrType, 200),
        purchaseDate: s(grinder.purchaseDate, 10),
    };
}

function safeUrl(v) {
    if (!v) return '';
    try {
        const u = new URL(String(v).trim());
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
    } catch { return ''; }
}

const VALID_BREW_METHODS = new Set(['espresso', 'aeropress', 'v60', 'french_press', 'moka', 'cold_brew', 'other']);

function sanitizeRecipeSteps(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 30).map(step => ({
        text:       typeof step?.text === 'string' ? step.text.trim().slice(0, 500) : '',
        duration_s: parseFloat(step?.duration_s) || null,
    })).filter(step => step.text);
}

// Mirrors the field set/limits from the regular recipe POST/PUT routes.
function sanitizeRecipeFields(recipe) {
    if (!recipe || typeof recipe !== 'object') return recipe;
    return {
        ...recipe,
        name: s(recipe.name, 200) || recipe.name,
        brewMethod: VALID_BREW_METHODS.has(recipe.brewMethod) ? recipe.brewMethod : 'other',
        drinkType: s(recipe.drinkType, 50),
        grindSize: s(recipe.grindSize, 200),
        sourceUrl: safeUrl(recipe.sourceUrl),
        steps: sanitizeRecipeSteps(recipe.steps),
        notes: s(recipe.notes, 1000),
        profileName: s(recipe.profileName, 200),
        beanName: s(recipe.beanName, 200),
    };
}

module.exports = {
    sanitizeOrigin, sanitizeOrigins, sanitizeRoastType, sanitizeFlavors,
    sanitizeAltitude, sanitizePrice, sanitizeBrewTemp, sanitizeBrewTime,
    sanitizeBeanFields, sanitizeGrinderFields, sanitizeRecipeFields,
};
