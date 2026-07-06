// Coffee-growing countries (ISO 3166-1 alpha-2) — backend copy of the list in
// public-src/constants.js (front/back don't share modules in this repo).
const COFFEE_COUNTRY_CODES = [
    'AO', 'BI', 'BO', 'BR', 'CD', 'CI', 'CM', 'CN', 'CO', 'CR', 'CU', 'DO',
    'EC', 'ET', 'GH', 'GT', 'HN', 'HT', 'ID', 'IN', 'JM', 'KE', 'KH', 'LA',
    'LK', 'MM', 'MW', 'MX', 'MZ', 'NI', 'NP', 'PA', 'PE', 'PG', 'PH', 'RW',
    'SV', 'TH', 'TL', 'TZ', 'UG', 'US', 'VE', 'VN', 'YE', 'ZM', 'ZW',
];

// Reverse lookup: localized country name (de + en, lowercased) → alpha-2 code,
// built once at module load from Intl.DisplayNames, plus a few common aliases
// that Intl doesn't cover.
const nameToCode = new Map([
    ['hawaii', 'US'],
    ['kongo', 'CD'],
    ['dr kongo', 'CD'],
    ['osttimor', 'TL'],
]);
for (const lang of ['de', 'en']) {
    const dn = new Intl.DisplayNames([lang], { type: 'region' });
    for (const code of COFFEE_COUNTRY_CODES) {
        const name = dn.of(code);
        if (name && name !== code) nameToCode.set(name.toLowerCase(), code);
    }
}

// Maps a free-text origin (e.g. "Äthiopien" from a roaster's product page) to
// an alpha-2 code. Returns null when nothing matches unambiguously — blends
// like "Brasilien, Indien" stay unmapped and should remain free text.
function mapOriginToCode(text) {
    if (typeof text !== 'string') return null;
    return nameToCode.get(text.trim().toLowerCase()) || null;
}

// Scans free prose (e.g. an elbgold product description) for country names.
// Returns the code only when exactly ONE distinct country appears — blends
// and ambiguous texts return null. A trailing genitive "s" is tolerated
// ("Äthiopiens" matches Äthiopien).
function findCountryInText(text) {
    if (typeof text !== 'string' || !text) return null;
    const lower = ' ' + text.toLowerCase() + ' ';
    const found = new Set();
    const isLetter = c => /[a-zäöüß]/.test(c || '');
    for (const [name, code] of nameToCode) {
        let idx = lower.indexOf(name);
        while (idx !== -1) {
            const before = lower[idx - 1];
            const after  = lower[idx + name.length];
            const after2 = lower[idx + name.length + 1];
            const boundaryOk = !isLetter(before)
                && (!isLetter(after) || (after === 's' && !isLetter(after2)));
            if (boundaryOk) { found.add(code); break; }
            idx = lower.indexOf(name, idx + 1);
        }
    }
    return found.size === 1 ? [...found][0] : null;
}

module.exports = { COFFEE_COUNTRY_CODES, mapOriginToCode, findCountryInText };
