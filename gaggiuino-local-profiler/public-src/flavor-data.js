// Coffee flavor hierarchy derived from the structure of the SCA/WCR Coffee
// Taster's Flavor Wheel (2016) — 9 top categories, 3 levels. This is our own
// data (category/descriptor names, which are common cupping vocabulary, not
// copyrightable expression) with German translations and a German alias
// table; no artwork from the original wheel is used or reproduced.
// Credit: category structure and English descriptor names after the
// SCA (Specialty Coffee Association) / WCR (World Coffee Research)
// Coffee Taster's Flavor Wheel, 2016.

export const FLAVOR_WHEEL = [
  {
    id: 'fruity', en: 'Fruity', de: 'Fruchtig', hue: 0,
    children: [
      { id: 'berry', en: 'Berry', de: 'Beere', children: [
        { id: 'blackberry', en: 'Blackberry', de: 'Brombeere' },
        { id: 'raspberry', en: 'Raspberry', de: 'Himbeere' },
        { id: 'blueberry', en: 'Blueberry', de: 'Blaubeere' },
        { id: 'strawberry', en: 'Strawberry', de: 'Erdbeere' },
      ] },
      { id: 'dried_fruit', en: 'Dried Fruit', de: 'Trockenfrucht', children: [
        { id: 'raisin', en: 'Raisin', de: 'Rosine' },
        { id: 'prune', en: 'Prune', de: 'Backpflaume' },
      ] },
      { id: 'other_fruit', en: 'Other Fruit', de: 'Sonstige Frucht', children: [
        { id: 'coconut', en: 'Coconut', de: 'Kokosnuss' },
        { id: 'cherry', en: 'Cherry', de: 'Kirsche' },
        { id: 'pomegranate', en: 'Pomegranate', de: 'Granatapfel' },
        { id: 'pineapple', en: 'Pineapple', de: 'Ananas' },
        { id: 'grape', en: 'Grape', de: 'Traube' },
        { id: 'apple', en: 'Apple', de: 'Apfel' },
        { id: 'peach', en: 'Peach', de: 'Pfirsich' },
        { id: 'pear', en: 'Pear', de: 'Birne' },
        { id: 'apricot', en: 'Apricot', de: 'Aprikose' },
        { id: 'stone_fruit', en: 'Stone Fruit', de: 'Steinfrucht' },
      ] },
      { id: 'citrus_fruit', en: 'Citrus Fruit', de: 'Zitrusfrucht', children: [
        { id: 'grapefruit', en: 'Grapefruit', de: 'Grapefruit' },
        { id: 'orange', en: 'Orange', de: 'Orange' },
        { id: 'lemon', en: 'Lemon', de: 'Zitrone' },
        { id: 'lime', en: 'Lime', de: 'Limette' },
        { id: 'mandarin', en: 'Mandarin', de: 'Mandarine' },
        { id: 'lemonade', en: 'Lemonade', de: 'Limonade' },
      ] },
    ],
  },
  {
    id: 'sour_fermented', en: 'Sour / Fermented', de: 'Säuerlich / Fermentiert', hue: 30,
    children: [
      { id: 'sour', en: 'Sour', de: 'Säuerlich', children: [
        { id: 'sour_aromatics', en: 'Sour Aromatics', de: 'Säuerliche Aromatik' },
        { id: 'acetic_acid', en: 'Acetic Acid', de: 'Essigsäure' },
        { id: 'citric_acid', en: 'Citric Acid', de: 'Zitronensäure' },
        { id: 'malic_acid', en: 'Malic Acid', de: 'Apfelsäure' },
      ] },
      { id: 'alcohol_fermented', en: 'Alcohol / Fermented', de: 'Alkoholisch / Fermentiert', children: [
        { id: 'winey', en: 'Winey', de: 'Weinig' },
        { id: 'whiskey', en: 'Whiskey', de: 'Whiskey' },
        { id: 'fermented', en: 'Fermented', de: 'Fermentiert' },
        { id: 'overripe', en: 'Overripe', de: 'Überreif' },
      ] },
    ],
  },
  {
    id: 'green_vegetative', en: 'Green / Vegetative', de: 'Grün / Vegetabil', hue: 90,
    children: [
      { id: 'olive_oil', en: 'Olive Oil', de: 'Olivenöl' },
      { id: 'raw', en: 'Raw', de: 'Roh' },
      { id: 'green_vegetative_sub', en: 'Green / Vegetative', de: 'Grün / Vegetabil', children: [
        { id: 'under_ripe', en: 'Under-ripe', de: 'Unreif' },
        { id: 'peapod', en: 'Peapod', de: 'Erbsenschote' },
        { id: 'fresh', en: 'Fresh', de: 'Frisch' },
        { id: 'dark_green', en: 'Dark Green', de: 'Dunkelgrün' },
        { id: 'vegetative', en: 'Vegetative', de: 'Vegetabil' },
        { id: 'hay_straw', en: 'Hay-like / Straw', de: 'Heu / Stroh' },
        { id: 'herb_like', en: 'Herb-like', de: 'Kräuterartig' },
      ] },
      { id: 'beany', en: 'Beany', de: 'Bohnig' },
    ],
  },
  {
    id: 'other', en: 'Other', de: 'Sonstiges', hue: 150,
    children: [
      { id: 'papery_musty', en: 'Papery / Musty', de: 'Papierig / Muffig', children: [
        { id: 'stale', en: 'Stale', de: 'Abgestanden' },
        { id: 'cardboard', en: 'Cardboard', de: 'Karton' },
        { id: 'papery', en: 'Papery', de: 'Papierig' },
        { id: 'woody', en: 'Woody', de: 'Holzig' },
        { id: 'moldy_damp', en: 'Moldy / Damp', de: 'Muffig / Feucht' },
        { id: 'musty_earthy', en: 'Musty / Earthy', de: 'Muffig / Erdig' },
        { id: 'animalic', en: 'Animalic', de: 'Animalisch' },
        { id: 'meaty_brothy', en: 'Meaty / Brothy', de: 'Fleischig / Brühig' },
        { id: 'phenolic', en: 'Phenolic', de: 'Phenolisch' },
      ] },
      { id: 'chemical', en: 'Chemical', de: 'Chemisch', children: [
        { id: 'bitter', en: 'Bitter', de: 'Bitter' },
        { id: 'salty', en: 'Salty', de: 'Salzig' },
        { id: 'medicinal', en: 'Medicinal', de: 'Medizinisch' },
        { id: 'petroleum', en: 'Petroleum', de: 'Erdöl' },
        { id: 'skunky', en: 'Skunky', de: 'Streng' },
        { id: 'rubber', en: 'Rubber', de: 'Gummi' },
      ] },
    ],
  },
  {
    id: 'roasted', en: 'Roasted', de: 'Röstig', hue: 200,
    children: [
      { id: 'pipe_tobacco', en: 'Pipe Tobacco', de: 'Pfeifentabak' },
      { id: 'tobacco', en: 'Tobacco', de: 'Tabak' },
      { id: 'burnt', en: 'Burnt', de: 'Verbrannt', children: [
        { id: 'acrid', en: 'Acrid', de: 'Beißend' },
        { id: 'ashy', en: 'Ashy', de: 'Aschig' },
        { id: 'smoky', en: 'Smoky', de: 'Rauchig' },
        { id: 'brown_roast', en: 'Brown, Roast', de: 'Röstig-Braun' },
      ] },
      { id: 'cereal', en: 'Cereal', de: 'Getreide', children: [
        { id: 'grain', en: 'Grain', de: 'Getreidekorn' },
        { id: 'malt', en: 'Malt', de: 'Malz' },
      ] },
    ],
  },
  {
    id: 'spices', en: 'Spices', de: 'Gewürze', hue: 260,
    children: [
      { id: 'pungent', en: 'Pungent', de: 'Scharf' },
      { id: 'pepper', en: 'Pepper', de: 'Pfeffer' },
      { id: 'brown_spice', en: 'Brown Spice', de: 'Braune Gewürze', children: [
        { id: 'anise', en: 'Anise', de: 'Anis' },
        { id: 'nutmeg', en: 'Nutmeg', de: 'Muskat' },
        { id: 'cinnamon', en: 'Cinnamon', de: 'Zimt' },
        { id: 'clove', en: 'Clove', de: 'Nelke' },
      ] },
    ],
  },
  {
    id: 'nutty_cocoa', en: 'Nutty / Cocoa', de: 'Nussig / Kakao', hue: 300,
    children: [
      { id: 'nutty', en: 'Nutty', de: 'Nussig', children: [
        { id: 'peanuts', en: 'Peanuts', de: 'Erdnuss' },
        { id: 'hazelnut', en: 'Hazelnut', de: 'Haselnuss' },
        { id: 'almond', en: 'Almond', de: 'Mandel' },
      ] },
      { id: 'cocoa', en: 'Cocoa', de: 'Kakao', children: [
        { id: 'chocolate', en: 'Chocolate', de: 'Schokolade' },
        { id: 'dark_chocolate', en: 'Dark Chocolate', de: 'Zartbitterschokolade' },
      ] },
    ],
  },
  {
    id: 'sweet', en: 'Sweet', de: 'Süß', hue: 340,
    children: [
      { id: 'brown_sugar', en: 'Brown Sugar', de: 'Brauner Zucker', children: [
        { id: 'molasses', en: 'Molasses', de: 'Melasse' },
        { id: 'maple_syrup', en: 'Maple Syrup', de: 'Ahornsirup' },
        { id: 'caramelized', en: 'Caramelized', de: 'Karamellisiert' },
        { id: 'honey', en: 'Honey', de: 'Honig' },
      ] },
      { id: 'vanilla', en: 'Vanilla', de: 'Vanille' },
      { id: 'vanillin', en: 'Vanillin', de: 'Vanillin' },
      { id: 'overall_sweet', en: 'Overall Sweet', de: 'Allgemein Süß' },
      { id: 'sweet_aromatics', en: 'Sweet Aromatics', de: 'Süße Aromatik' },
    ],
  },
  {
    id: 'floral', en: 'Floral', de: 'Blumig', hue: 20,
    children: [
      { id: 'black_tea', en: 'Black Tea', de: 'Schwarztee' },
      { id: 'floral_sub', en: 'Floral', de: 'Blumig', children: [
        { id: 'chamomile', en: 'Chamomile', de: 'Kamille' },
        { id: 'rose', en: 'Rose', de: 'Rose' },
        { id: 'jasmine', en: 'Jasmine', de: 'Jasmin' },
      ] },
    ],
  },
];

// German (and a few English colloquial) synonyms → leaf node id. Keys are
// lowercase, diacritics-stripped (matching normalizeFlavor). Only entries
// that would NOT already match a de/en label via containment need to be
// here — this covers different roots, compounds and common cupping slang.
export const FLAVOR_ALIASES = {
  'schwarze johannisbeere': 'blackberry',
  'johannisbeere': 'blackberry',
  'rote johannisbeere': 'raspberry',
  'getrocknete aprikose': 'apricot',
  'limonade': 'lemonade',
  'zitrusfrische': 'citrus_fruit',
  'limette': 'lime',
  'vollmilchschokolade': 'chocolate',
  'milchschokolade': 'chocolate',
  'zartbitter': 'dark_chocolate',
  'karamell': 'caramelized',
  'karamel': 'caramelized',
  'nougat': 'hazelnut',
  'geroestete mandel': 'almond',
  'geröstete mandel': 'almond',
  'mandel': 'almond',
  'haselnuss': 'hazelnut',
  'nuss': 'nutty',
  'schokolade': 'chocolate',
  'kakao': 'cocoa',
  'honig': 'honey',
  'ahornsirup': 'maple_syrup',
  'melasse': 'molasses',
  'brauner zucker': 'brown_sugar',
  'tabak': 'tobacco',
  'holzig': 'woody',
  'erdig': 'musty_earthy',
  'blumig': 'floral_sub',
  'rosen': 'rose',
  'kamille': 'chamomile',
  'jasmin': 'jasmine',
  'schwarzer tee': 'black_tea',
  'tee': 'black_tea',
  'weinig': 'winey',
  'wein': 'winey',
  'kirsche': 'cherry',
  'traube': 'grape',
  'apfel': 'apple',
  'birne': 'pear',
  'pfirsich': 'peach',
  'aprikose': 'apricot',
  'steinfrucht': 'stone_fruit',
  'ananas': 'pineapple',
  'kokos': 'coconut',
  'kokosnuss': 'coconut',
  'granatapfel': 'pomegranate',
  'zimt': 'cinnamon',
  'nelke': 'clove',
  'muskat': 'nutmeg',
  'anis': 'anise',
  'pfeffer': 'pepper',
  'malz': 'malt',
  'getreide': 'grain',
  'rauchig': 'smoky',
  'verbrannt': 'burnt',
  'zucker': 'overall_sweet',
  'susse': 'overall_sweet',
  'süße': 'overall_sweet',
  'blaubeere': 'blueberry',
  'brombeere': 'blackberry',
  'himbeere': 'raspberry',
  'erdbeere': 'strawberry',
  'rosine': 'raisin',
  'backpflaume': 'prune',
  'orange': 'orange',
  'zitrone': 'lemon',
  'mandarine': 'mandarin',
  'grapefruit': 'grapefruit',
};
