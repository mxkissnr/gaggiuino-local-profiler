// Localized text for HA notifications sent by the backend. Language is the Home
// Assistant instance language (see getHaLanguage in lib/ha.js), so a German HA
// user gets German notifications instead of English.

const N = {
  de: { preheat_title: '☕ Maschine bereit',        preheat_body: 'Aufheizen abgeschlossen — bereit zum Brühen',
        low_stock_title: '🫘 Bohne fast leer',      low_stock_body: (name, g) => `${name}: nur noch ca. ${g} g übrig — nachbestellen?` },
  en: { preheat_title: '☕ Machine ready',          preheat_body: 'Warm-up complete — ready to brew',
        low_stock_title: '🫘 Bean running low',     low_stock_body: (name, g) => `${name}: only about ${g} g left — time to reorder?` },
  it: { preheat_title: '☕ Macchina pronta',        preheat_body: 'Riscaldamento completato — pronta per l’estrazione',
        low_stock_title: '🫘 Caffè quasi finito',   low_stock_body: (name, g) => `${name}: restano circa ${g} g — riordinare?` },
  fr: { preheat_title: '☕ Machine prête',          preheat_body: 'Préchauffage terminé — prête à extraire',
        low_stock_title: '🫘 Grain presque épuisé', low_stock_body: (name, g) => `${name} : il ne reste qu’environ ${g} g — recommander ?` },
  es: { preheat_title: '☕ Máquina lista',          preheat_body: 'Calentamiento completado — lista para extraer',
        low_stock_title: '🫘 Grano casi agotado',   low_stock_body: (name, g) => `${name}: quedan unos ${g} g — ¿pedir más?` },
  nl: { preheat_title: '☕ Machine gereed',         preheat_body: 'Opwarmen voltooid — klaar om te zetten',
        low_stock_title: '🫘 Boon bijna op',        low_stock_body: (name, g) => `${name}: nog ongeveer ${g} g over — bijbestellen?` },
};

function notifyT(lang, key, ...args) {
  const table = N[lang] || N.de;
  const v = table[key] ?? N.en[key] ?? key;
  return typeof v === 'function' ? v(...args) : v;
}

module.exports = { notifyT };
