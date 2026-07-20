// Curated cupping-note vocabulary (mostly German, plus a handful of English
// specialty terms — see #400) used as a fallback when a product description
// has no literal "Noten von ..." sentence (elbgold, lib/import-parsers.js
// extractFlavorKeywords) or none at all (any other shop, lib/import-generic.js
// matchFlavorTerms). Deliberately small and best-effort — this is NOT the
// same list as public-src/flavor-data.js's translated flavor wheel, and is
// not meant to be exhaustive; it only needs to catch the common terms shop
// copy actually uses in free prose.
const FLAVOR_TERMS_DE = [
    // Fruity
    'Kirsche', 'Mandarine', 'Orange', 'Zitrone', 'Zitrus', 'Apfel', 'Aprikose',
    'Pfirsich', 'Traube', 'Feige', 'Rosine', 'Beere', 'Himbeere', 'Erdbeere',
    'Johannisbeere', 'Ananas', 'Mango', 'Passionsfrucht', 'Grapefruit',
    'Litschi', 'Lychee', 'Guave', 'Guava', 'Maracuja', 'Passion Fruit', 'Papaya',
    // Floral
    'Jasmin', 'Rose', 'Blüte', 'Lavendel', 'Bergamotte',
    // Sweet / dessert
    'Karamell', 'Honig', 'Vanille', 'Schokolade', 'Kakao', 'Kakaonibs',
    'Nougat', 'Toffee', 'Karamellisiert', 'brauner Zucker', 'Sirup', 'Melasse',
    // Nutty
    'Nuss', 'Mandel', 'Haselnuss', 'Walnuss', 'Pekannuss',
    // Spice / roasted
    'Zimt', 'Nelke', 'Pfeffer', 'Malz', 'Karamellnote',
    // Specialty/process (#400: curated for English shop copy too — small
    // roasters often publish only in English, unlike the mostly-German terms
    // above) — tropisch/tropical, and the fermentation/dairy-adjacent
    // "lactic" note common in washed/anaerobic process descriptions.
    'Tropisch', 'Tropical', 'Lactic',
];

module.exports = { FLAVOR_TERMS_DE };
