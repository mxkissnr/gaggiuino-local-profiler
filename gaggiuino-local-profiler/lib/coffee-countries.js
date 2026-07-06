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
// Returns an array of distinct country codes found, in first-appearance
// order, up to maxCount. More than maxCount distinct matches is treated as
// noise (boilerplate mentioning many countries) rather than a real blend,
// and returns []. A trailing genitive "s" is tolerated ("Äthiopiens" matches
// Äthiopien).
function findCountriesInText(text, maxCount = 3) {
    if (typeof text !== 'string' || !text) return [];
    const lower = ' ' + text.toLowerCase() + ' ';
    const firstIdx = new Map(); // code -> earliest match position, for ordering
    const isLetter = c => /[a-zäöüß]/.test(c || '');
    for (const [name, code] of nameToCode) {
        let idx = lower.indexOf(name);
        while (idx !== -1) {
            const before = lower[idx - 1];
            const after  = lower[idx + name.length];
            const after2 = lower[idx + name.length + 1];
            const boundaryOk = !isLetter(before)
                && (!isLetter(after) || (after === 's' && !isLetter(after2)));
            if (boundaryOk) {
                if (!firstIdx.has(code) || idx < firstIdx.get(code)) firstIdx.set(code, idx);
                break;
            }
            idx = lower.indexOf(name, idx + 1);
        }
    }
    const order = [...firstIdx.entries()].sort((a, b) => a[1] - b[1]).map(([code]) => code);
    return order.length >= 1 && order.length <= maxCount ? order : [];
}

module.exports = { COFFEE_COUNTRY_CODES, mapOriginToCode, findCountriesInText };
