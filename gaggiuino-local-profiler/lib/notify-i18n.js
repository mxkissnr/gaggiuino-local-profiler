// Localized text for HA notifications sent by the backend. Language is the Home
// Assistant instance language (see getHaLanguage in lib/ha.js), so a German HA
// user gets German notifications instead of English.

const N = {
  de: { preheat_title: '☕ Maschine bereit',        preheat_body: 'Aufheizen abgeschlossen — bereit zum Brühen' },
  en: { preheat_title: '☕ Machine ready',          preheat_body: 'Warm-up complete — ready to brew' },
  it: { preheat_title: '☕ Macchina pronta',        preheat_body: 'Riscaldamento completato — pronta per l’estrazione' },
  fr: { preheat_title: '☕ Machine prête',          preheat_body: 'Préchauffage terminé — prête à extraire' },
  es: { preheat_title: '☕ Máquina lista',          preheat_body: 'Calentamiento completado — lista para extraer' },
  nl: { preheat_title: '☕ Machine gereed',         preheat_body: 'Opwarmen voltooid — klaar om te zetten' },
};

function notifyT(lang, key) {
  const table = N[lang] || N.de;
  return table[key] ?? N.en[key] ?? key;
}

module.exports = { notifyT };
