// Curated German cupping-note vocabulary used only as a fallback when an
// elbgold product description has no literal "Noten von ..." sentence (see
// lib/import-parsers.js extractFlavorKeywords). Deliberately small and
// best-effort — this is NOT the same list as public-src/flavor-data.js's
// translated flavor wheel, and is not meant to be exhaustive; it only needs
// to catch the common terms shop copy actually uses in free prose.
const FLAVOR_TERMS_DE = [
    // Fruity
    'Kirsche', 'Mandarine', 'Orange', 'Zitrone', 'Zitrus', 'Apfel', 'Aprikose',
    'Pfirsich', 'Traube', 'Feige', 'Rosine', 'Beere', 'Himbeere', 'Erdbeere',
    'Johannisbeere', 'Ananas', 'Mango', 'Passionsfrucht', 'Grapefruit',
    // Floral
    'Jasmin', 'Rose', 'Blüte', 'Lavendel', 'Bergamotte',
    // Sweet / dessert
    'Karamell', 'Honig', 'Vanille', 'Schokolade', 'Kakao', 'Kakaonibs',
    'Nougat', 'Toffee', 'Karamellisiert', 'brauner Zucker', 'Sirup', 'Melasse',
    // Nutty
    'Nuss', 'Mandel', 'Haselnuss', 'Walnuss', 'Pekannuss',
    // Spice / roasted
    'Zimt', 'Nelke', 'Pfeffer', 'Malz', 'Karamellnote',
];

module.exports = { FLAVOR_TERMS_DE };
