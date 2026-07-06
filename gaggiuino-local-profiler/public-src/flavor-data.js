// Coffee flavor hierarchy derived from the structure of the SCA/WCR Coffee
// Taster's Flavor Wheel (2016) — 9 top categories, 3 levels. This is our own
// data (category/descriptor names, which are common cupping vocabulary, not
// copyrightable expression) with translations into all 6 UI languages (DE,
// EN, IT, FR, ES, NL) and a German alias table; no artwork from the original
// wheel is used or reproduced.
// Credit: category structure and English descriptor names after the
// SCA (Specialty Coffee Association) / WCR (World Coffee Research)
// Coffee Taster's Flavor Wheel, 2016.

export const FLAVOR_WHEEL = [
  {
    id: 'fruity', en: 'Fruity', de: 'Fruchtig', it: 'Fruttato', fr: 'Fruité', es: 'Afrutado', nl: 'Fruitig', hue: 0,
    children: [
      { id: 'berry', en: 'Berry', de: 'Beere', it: 'Bacca', fr: 'Baie', es: 'Baya', nl: 'Bes', children: [
        { id: 'blackberry', en: 'Blackberry', de: 'Brombeere', it: 'Mora', fr: 'Mûre', es: 'Zarzamora', nl: 'Braam' },
        { id: 'raspberry', en: 'Raspberry', de: 'Himbeere', it: 'Lampone', fr: 'Framboise', es: 'Frambuesa', nl: 'Framboos' },
        { id: 'blueberry', en: 'Blueberry', de: 'Blaubeere', it: 'Mirtillo', fr: 'Myrtille', es: 'Arándano', nl: 'Bosbes' },
        { id: 'strawberry', en: 'Strawberry', de: 'Erdbeere', it: 'Fragola', fr: 'Fraise', es: 'Fresa', nl: 'Aardbei' },
      ] },
      { id: 'dried_fruit', en: 'Dried Fruit', de: 'Trockenfrucht', it: 'Frutta essiccata', fr: 'Fruit sec', es: 'Fruta seca', nl: 'Gedroogd fruit', children: [
        { id: 'raisin', en: 'Raisin', de: 'Rosine', it: 'Uvetta', fr: 'Raisin sec', es: 'Pasa', nl: 'Rozijn' },
        { id: 'prune', en: 'Prune', de: 'Backpflaume', it: 'Prugna secca', fr: 'Pruneau', es: 'Ciruela pasa', nl: 'Gedroogde pruim' },
      ] },
      { id: 'other_fruit', en: 'Other Fruit', de: 'Sonstige Frucht', it: 'Altra frutta', fr: 'Autres fruits', es: 'Otras frutas', nl: 'Overig fruit', children: [
        { id: 'coconut', en: 'Coconut', de: 'Kokosnuss', it: 'Cocco', fr: 'Noix de coco', es: 'Coco', nl: 'Kokosnoot' },
        { id: 'cherry', en: 'Cherry', de: 'Kirsche', it: 'Ciliegia', fr: 'Cerise', es: 'Cereza', nl: 'Kers' },
        { id: 'pomegranate', en: 'Pomegranate', de: 'Granatapfel', it: 'Melagrana', fr: 'Grenade', es: 'Granada', nl: 'Granaatappel' },
        { id: 'pineapple', en: 'Pineapple', de: 'Ananas', it: 'Ananas', fr: 'Ananas', es: 'Piña', nl: 'Ananas' },
        { id: 'grape', en: 'Grape', de: 'Traube', it: 'Uva', fr: 'Raisin', es: 'Uva', nl: 'Druif' },
        { id: 'apple', en: 'Apple', de: 'Apfel', it: 'Mela', fr: 'Pomme', es: 'Manzana', nl: 'Appel' },
        { id: 'peach', en: 'Peach', de: 'Pfirsich', it: 'Pesca', fr: 'Pêche', es: 'Melocotón', nl: 'Perzik' },
        { id: 'pear', en: 'Pear', de: 'Birne', it: 'Pera', fr: 'Poire', es: 'Pera', nl: 'Peer' },
        { id: 'apricot', en: 'Apricot', de: 'Aprikose', it: 'Albicocca', fr: 'Abricot', es: 'Albaricoque', nl: 'Abrikoos' },
        { id: 'stone_fruit', en: 'Stone Fruit', de: 'Steinfrucht', it: 'Frutta a nocciolo', fr: 'Fruit à noyau', es: 'Fruta de hueso', nl: 'Steenfruit' },
      ] },
      { id: 'citrus_fruit', en: 'Citrus Fruit', de: 'Zitrusfrucht', it: 'Agrumi', fr: 'Agrumes', es: 'Cítricos', nl: 'Citrusvruchten', children: [
        { id: 'grapefruit', en: 'Grapefruit', de: 'Grapefruit', it: 'Pompelmo', fr: 'Pamplemousse', es: 'Pomelo', nl: 'Grapefruit' },
        { id: 'orange', en: 'Orange', de: 'Orange', it: 'Arancia', fr: 'Orange', es: 'Naranja', nl: 'Sinaasappel' },
        { id: 'lemon', en: 'Lemon', de: 'Zitrone', it: 'Limone', fr: 'Citron', es: 'Limón', nl: 'Citroen' },
        { id: 'lime', en: 'Lime', de: 'Limette', it: 'Lime', fr: 'Citron vert', es: 'Lima', nl: 'Limoen' },
        { id: 'mandarin', en: 'Mandarin', de: 'Mandarine', it: 'Mandarino', fr: 'Mandarine', es: 'Mandarina', nl: 'Mandarijn' },
        { id: 'lemonade', en: 'Lemonade', de: 'Limonade', it: 'Limonata', fr: 'Limonade', es: 'Limonada', nl: 'Limonade' },
      ] },
    ],
  },
  {
    id: 'sour_fermented', en: 'Sour / Fermented', de: 'Säuerlich / Fermentiert', it: 'Acido / Fermentato', fr: 'Acide / Fermenté', es: 'Ácido / Fermentado', nl: 'Zuur / Gegist', hue: 30,
    children: [
      { id: 'sour', en: 'Sour', de: 'Säuerlich', it: 'Acido', fr: 'Acide', es: 'Ácido', nl: 'Zuur', children: [
        { id: 'sour_aromatics', en: 'Sour Aromatics', de: 'Säuerliche Aromatik', it: 'Aromi acidi', fr: 'Arômes acides', es: 'Aromas ácidos', nl: 'Zure aroma\'s' },
        { id: 'acetic_acid', en: 'Acetic Acid', de: 'Essigsäure', it: 'Acido acetico', fr: 'Acide acétique', es: 'Ácido acético', nl: 'Azijnzuur' },
        { id: 'citric_acid', en: 'Citric Acid', de: 'Zitronensäure', it: 'Acido citrico', fr: 'Acide citrique', es: 'Ácido cítrico', nl: 'Citroenzuur' },
        { id: 'malic_acid', en: 'Malic Acid', de: 'Apfelsäure', it: 'Acido malico', fr: 'Acide malique', es: 'Ácido málico', nl: 'Appelzuur' },
      ] },
      { id: 'alcohol_fermented', en: 'Alcohol / Fermented', de: 'Alkoholisch / Fermentiert', it: 'Alcolico / Fermentato', fr: 'Alcoolisé / Fermenté', es: 'Alcohólico / Fermentado', nl: 'Alcoholisch / Gegist', children: [
        { id: 'winey', en: 'Winey', de: 'Weinig', it: 'Vinoso', fr: 'Vineux', es: 'Vinoso', nl: 'Wijnachtig' },
        { id: 'whiskey', en: 'Whiskey', de: 'Whiskey', it: 'Whisky', fr: 'Whisky', es: 'Whisky', nl: 'Whisky' },
        { id: 'fermented', en: 'Fermented', de: 'Fermentiert', it: 'Fermentato', fr: 'Fermenté', es: 'Fermentado', nl: 'Gegist' },
        { id: 'overripe', en: 'Overripe', de: 'Überreif', it: 'Troppo maturo', fr: 'Trop mûr', es: 'Demasiado maduro', nl: 'Overrijp' },
      ] },
    ],
  },
  {
    id: 'green_vegetative', en: 'Green / Vegetative', de: 'Grün / Vegetabil', it: 'Verde / Vegetale', fr: 'Vert / Végétal', es: 'Verde / Vegetal', nl: 'Groen / Vegetatief', hue: 90,
    children: [
      { id: 'olive_oil', en: 'Olive Oil', de: 'Olivenöl', it: 'Olio d\'oliva', fr: 'Huile d\'olive', es: 'Aceite de oliva', nl: 'Olijfolie' },
      { id: 'raw', en: 'Raw', de: 'Roh', it: 'Crudo', fr: 'Cru', es: 'Crudo', nl: 'Rauw' },
      { id: 'green_vegetative_sub', en: 'Green / Vegetative', de: 'Grün / Vegetabil', it: 'Verde / Vegetale', fr: 'Vert / Végétal', es: 'Verde / Vegetal', nl: 'Groen / Vegetatief', children: [
        { id: 'under_ripe', en: 'Under-ripe', de: 'Unreif', it: 'Acerbo', fr: 'Pas mûr', es: 'Sin madurar', nl: 'Onrijp' },
        { id: 'peapod', en: 'Peapod', de: 'Erbsenschote', it: 'Baccello di pisello', fr: 'Cosse de petit pois', es: 'Vaina de guisante', nl: 'Erwtendop' },
        { id: 'fresh', en: 'Fresh', de: 'Frisch', it: 'Fresco', fr: 'Frais', es: 'Fresco', nl: 'Fris' },
        { id: 'dark_green', en: 'Dark Green', de: 'Dunkelgrün', it: 'Verde scuro', fr: 'Vert foncé', es: 'Verde oscuro', nl: 'Donkergroen' },
        { id: 'vegetative', en: 'Vegetative', de: 'Vegetabil', it: 'Vegetale', fr: 'Végétal', es: 'Vegetal', nl: 'Vegetatief' },
        { id: 'hay_straw', en: 'Hay-like / Straw', de: 'Heu / Stroh', it: 'Fieno / Paglia', fr: 'Foin / Paille', es: 'Heno / Paja', nl: 'Hooi / Stro' },
        { id: 'herb_like', en: 'Herb-like', de: 'Kräuterartig', it: 'Erbaceo', fr: 'Herbacé', es: 'Herbáceo', nl: 'Kruidig' },
      ] },
      { id: 'beany', en: 'Beany', de: 'Bohnig', it: 'Di fagiolo', fr: 'De fève', es: 'A legumbre', nl: 'Bonig' },
    ],
  },
  {
    id: 'other', en: 'Other', de: 'Sonstiges', it: 'Altro', fr: 'Autre', es: 'Otro', nl: 'Overig', hue: 150,
    children: [
      { id: 'papery_musty', en: 'Papery / Musty', de: 'Papierig / Muffig', it: 'Cartaceo / Ammuffito', fr: 'Papier / Moisi', es: 'A papel / Mohoso', nl: 'Papierachtig / Muf', children: [
        { id: 'stale', en: 'Stale', de: 'Abgestanden', it: 'Stantio', fr: 'Rassis', es: 'Rancio', nl: 'Muf' },
        { id: 'cardboard', en: 'Cardboard', de: 'Karton', it: 'Cartone', fr: 'Carton', es: 'Cartón', nl: 'Karton' },
        { id: 'papery', en: 'Papery', de: 'Papierig', it: 'Cartaceo', fr: 'Papier', es: 'A papel', nl: 'Papierachtig' },
        { id: 'woody', en: 'Woody', de: 'Holzig', it: 'Legnoso', fr: 'Boisé', es: 'A madera', nl: 'Houtachtig' },
        { id: 'moldy_damp', en: 'Moldy / Damp', de: 'Muffig / Feucht', it: 'Ammuffito / Umido', fr: 'Moisi / Humide', es: 'Mohoso / Húmedo', nl: 'Beschimmeld / Vochtig' },
        { id: 'musty_earthy', en: 'Musty / Earthy', de: 'Muffig / Erdig', it: 'Di muffa / Terroso', fr: 'Terreux', es: 'A tierra', nl: 'Muf / Aards' },
        { id: 'animalic', en: 'Animalic', de: 'Animalisch', it: 'Animalesco', fr: 'Animal', es: 'Animal', nl: 'Dierlijk' },
        { id: 'meaty_brothy', en: 'Meaty / Brothy', de: 'Fleischig / Brühig', it: 'Carnoso / Brodoso', fr: 'Viandé / Bouillon', es: 'A carne / Caldo', nl: 'Vlezig / Bouillonachtig' },
        { id: 'phenolic', en: 'Phenolic', de: 'Phenolisch', it: 'Fenolico', fr: 'Phénolique', es: 'Fenólico', nl: 'Fenolisch' },
      ] },
      { id: 'chemical', en: 'Chemical', de: 'Chemisch', it: 'Chimico', fr: 'Chimique', es: 'Químico', nl: 'Chemisch', children: [
        { id: 'bitter', en: 'Bitter', de: 'Bitter', it: 'Amaro', fr: 'Amer', es: 'Amargo', nl: 'Bitter' },
        { id: 'salty', en: 'Salty', de: 'Salzig', it: 'Salato', fr: 'Salé', es: 'Salado', nl: 'Zout' },
        { id: 'medicinal', en: 'Medicinal', de: 'Medizinisch', it: 'Medicinale', fr: 'Médicinal', es: 'Medicinal', nl: 'Medicinaal' },
        { id: 'petroleum', en: 'Petroleum', de: 'Erdöl', it: 'Petrolio', fr: 'Pétrole', es: 'Petróleo', nl: 'Petroleum' },
        { id: 'skunky', en: 'Skunky', de: 'Streng', it: 'Puzzolente', fr: 'Fétide', es: 'Apestoso', nl: 'Scherp' },
        { id: 'rubber', en: 'Rubber', de: 'Gummi', it: 'Gomma', fr: 'Caoutchouc', es: 'Goma', nl: 'Rubber' },
      ] },
    ],
  },
  {
    id: 'roasted', en: 'Roasted', de: 'Röstig', it: 'Tostato', fr: 'Torréfié', es: 'Tostado', nl: 'Geroosterd', hue: 200,
    children: [
      { id: 'pipe_tobacco', en: 'Pipe Tobacco', de: 'Pfeifentabak', it: 'Tabacco da pipa', fr: 'Tabac à pipe', es: 'Tabaco de pipa', nl: 'Pijptabak' },
      { id: 'tobacco', en: 'Tobacco', de: 'Tabak', it: 'Tabacco', fr: 'Tabac', es: 'Tabaco', nl: 'Tabak' },
      { id: 'burnt', en: 'Burnt', de: 'Verbrannt', it: 'Bruciato', fr: 'Brûlé', es: 'Quemado', nl: 'Verbrand', children: [
        { id: 'acrid', en: 'Acrid', de: 'Beißend', it: 'Acre', fr: 'Âcre', es: 'Acre', nl: 'Scherp' },
        { id: 'ashy', en: 'Ashy', de: 'Aschig', it: 'Di cenere', fr: 'Cendré', es: 'A ceniza', nl: 'Asachtig' },
        { id: 'smoky', en: 'Smoky', de: 'Rauchig', it: 'Affumicato', fr: 'Fumé', es: 'Ahumado', nl: 'Rokerig' },
        { id: 'brown_roast', en: 'Brown, Roast', de: 'Röstig-Braun', it: 'Tostatura bruna', fr: 'Torréfaction brune', es: 'Tueste marrón', nl: 'Bruine roosting' },
      ] },
      { id: 'cereal', en: 'Cereal', de: 'Getreide', it: 'Cereale', fr: 'Céréale', es: 'Cereal', nl: 'Graan', children: [
        { id: 'grain', en: 'Grain', de: 'Getreidekorn', it: 'Grano', fr: 'Grain', es: 'Grano', nl: 'Graankorrel' },
        { id: 'malt', en: 'Malt', de: 'Malz', it: 'Malto', fr: 'Malt', es: 'Malta', nl: 'Mout' },
      ] },
    ],
  },
  {
    id: 'spices', en: 'Spices', de: 'Gewürze', it: 'Spezie', fr: 'Épices', es: 'Especias', nl: 'Kruiden', hue: 260,
    children: [
      { id: 'pungent', en: 'Pungent', de: 'Scharf', it: 'Pungente', fr: 'Piquant', es: 'Picante', nl: 'Scherp' },
      { id: 'pepper', en: 'Pepper', de: 'Pfeffer', it: 'Pepe', fr: 'Poivre', es: 'Pimienta', nl: 'Peper' },
      { id: 'brown_spice', en: 'Brown Spice', de: 'Braune Gewürze', it: 'Spezie scure', fr: 'Épices brunes', es: 'Especias oscuras', nl: 'Bruine kruiden', children: [
        { id: 'anise', en: 'Anise', de: 'Anis', it: 'Anice', fr: 'Anis', es: 'Anís', nl: 'Anijs' },
        { id: 'nutmeg', en: 'Nutmeg', de: 'Muskat', it: 'Noce moscata', fr: 'Muscade', es: 'Nuez moscada', nl: 'Nootmuskaat' },
        { id: 'cinnamon', en: 'Cinnamon', de: 'Zimt', it: 'Cannella', fr: 'Cannelle', es: 'Canela', nl: 'Kaneel' },
        { id: 'clove', en: 'Clove', de: 'Nelke', it: 'Chiodi di garofano', fr: 'Clou de girofle', es: 'Clavo', nl: 'Kruidnagel' },
      ] },
    ],
  },
  {
    id: 'nutty_cocoa', en: 'Nutty / Cocoa', de: 'Nussig / Kakao', it: 'Di nocciola / Cacao', fr: 'Noisette / Cacao', es: 'A frutos secos / Cacao', nl: 'Nootachtig / Cacao', hue: 300,
    children: [
      { id: 'nutty', en: 'Nutty', de: 'Nussig', it: 'Di nocciola', fr: 'Noisette', es: 'A frutos secos', nl: 'Nootachtig', children: [
        { id: 'peanuts', en: 'Peanuts', de: 'Erdnuss', it: 'Arachidi', fr: 'Cacahuètes', es: 'Cacahuetes', nl: 'Pinda\'s' },
        { id: 'hazelnut', en: 'Hazelnut', de: 'Haselnuss', it: 'Nocciola', fr: 'Noisette', es: 'Avellana', nl: 'Hazelnoot' },
        { id: 'almond', en: 'Almond', de: 'Mandel', it: 'Mandorla', fr: 'Amande', es: 'Almendra', nl: 'Amandel' },
      ] },
      { id: 'cocoa', en: 'Cocoa', de: 'Kakao', it: 'Cacao', fr: 'Cacao', es: 'Cacao', nl: 'Cacao', children: [
        { id: 'chocolate', en: 'Chocolate', de: 'Schokolade', it: 'Cioccolato', fr: 'Chocolat', es: 'Chocolate', nl: 'Chocolade' },
        { id: 'dark_chocolate', en: 'Dark Chocolate', de: 'Zartbitterschokolade', it: 'Cioccolato fondente', fr: 'Chocolat noir', es: 'Chocolate negro', nl: 'Pure chocolade' },
      ] },
    ],
  },
  {
    id: 'sweet', en: 'Sweet', de: 'Süß', it: 'Dolce', fr: 'Sucré', es: 'Dulce', nl: 'Zoet', hue: 340,
    children: [
      { id: 'brown_sugar', en: 'Brown Sugar', de: 'Brauner Zucker', it: 'Zucchero di canna', fr: 'Sucre roux', es: 'Azúcar moreno', nl: 'Bruine suiker', children: [
        { id: 'molasses', en: 'Molasses', de: 'Melasse', it: 'Melassa', fr: 'Mélasse', es: 'Melaza', nl: 'Melasse' },
        { id: 'maple_syrup', en: 'Maple Syrup', de: 'Ahornsirup', it: 'Sciroppo d\'acero', fr: 'Sirop d\'érable', es: 'Jarabe de arce', nl: 'Ahornsiroop' },
        { id: 'caramelized', en: 'Caramelized', de: 'Karamellisiert', it: 'Caramellato', fr: 'Caramélisé', es: 'Caramelizado', nl: 'Gekarameliseerd' },
        { id: 'honey', en: 'Honey', de: 'Honig', it: 'Miele', fr: 'Miel', es: 'Miel', nl: 'Honing' },
      ] },
      { id: 'vanilla', en: 'Vanilla', de: 'Vanille', it: 'Vaniglia', fr: 'Vanille', es: 'Vainilla', nl: 'Vanille' },
      { id: 'vanillin', en: 'Vanillin', de: 'Vanillin', it: 'Vanillina', fr: 'Vanilline', es: 'Vainillina', nl: 'Vanilline' },
      { id: 'overall_sweet', en: 'Overall Sweet', de: 'Allgemein Süß', it: 'Dolcezza generale', fr: 'Douceur générale', es: 'Dulzor general', nl: 'Algemeen zoet' },
      { id: 'sweet_aromatics', en: 'Sweet Aromatics', de: 'Süße Aromatik', it: 'Aromi dolci', fr: 'Arômes sucrés', es: 'Aromas dulces', nl: 'Zoete aroma\'s' },
    ],
  },
  {
    id: 'floral', en: 'Floral', de: 'Blumig', it: 'Floreale', fr: 'Floral', es: 'Floral', nl: 'Bloemig', hue: 20,
    children: [
      { id: 'black_tea', en: 'Black Tea', de: 'Schwarztee', it: 'Tè nero', fr: 'Thé noir', es: 'Té negro', nl: 'Zwarte thee' },
      { id: 'floral_sub', en: 'Floral', de: 'Blumig', it: 'Floreale', fr: 'Floral', es: 'Floral', nl: 'Bloemig', children: [
        { id: 'chamomile', en: 'Chamomile', de: 'Kamille', it: 'Camomilla', fr: 'Camomille', es: 'Manzanilla', nl: 'Kamille' },
        { id: 'rose', en: 'Rose', de: 'Rose', it: 'Rosa', fr: 'Rose', es: 'Rosa', nl: 'Roos' },
        { id: 'jasmine', en: 'Jasmine', de: 'Jasmin', it: 'Gelsomino', fr: 'Jasmin', es: 'Jazmín', nl: 'Jasmijn' },
      ] },
    ],
  },
];

// German (and a few English colloquial) synonyms → leaf node id. Keys are
// lowercase, diacritics-stripped (matching normalizeFlavor). Only entries
// that would NOT already match a label via containment need to be here —
// this covers different roots, compounds and common cupping slang.
// Deliberately German-only for now — equivalent alias tables for
// it/fr/es/nl are backlog (the wheel's own labels in all 6 languages are
// already indexed for exact/containment matching; only colloquial slang
// needs an alias).
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
