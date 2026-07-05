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

module.exports = { COFFEE_COUNTRY_CODES, mapOriginToCode };
