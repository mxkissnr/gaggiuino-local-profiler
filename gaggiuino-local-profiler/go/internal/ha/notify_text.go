package ha

import "fmt"

// notifyTextCatalog holds the localized text of the automatic HA pushes GLP
// sends — the preheat-ready and low-stock notifications (#1671), ported from
// the legacy Node backend's lib/notify-i18n.js. The language is the HA
// instance language (Client.GetHaLanguage), so a German HA user gets German
// text. A body that takes values carries fmt verbs filled by NotifyText.
var notifyTextCatalog = map[string]map[string]string{
	"de": {
		"preheat_title":   "☕ Maschine bereit",
		"preheat_body":    "Aufheizen abgeschlossen — bereit zum Brühen",
		"low_stock_title": "🫘 Bohne fast leer",
		"low_stock_body":  "%s: nur noch ca. %d g übrig — nachbestellen?",
	},
	"en": {
		"preheat_title":   "☕ Machine ready",
		"preheat_body":    "Warm-up complete — ready to brew",
		"low_stock_title": "🫘 Bean running low",
		"low_stock_body":  "%s: only about %d g left — time to reorder?",
	},
	"it": {
		"preheat_title":   "☕ Macchina pronta",
		"preheat_body":    "Riscaldamento completato — pronta per l’estrazione",
		"low_stock_title": "🫘 Caffè quasi finito",
		"low_stock_body":  "%s: restano circa %d g — riordinare?",
	},
	"fr": {
		"preheat_title":   "☕ Machine prête",
		"preheat_body":    "Préchauffage terminé — prête à extraire",
		"low_stock_title": "🫘 Grain presque épuisé",
		"low_stock_body":  "%s : il ne reste qu’environ %d g — recommander ?",
	},
	"es": {
		"preheat_title":   "☕ Máquina lista",
		"preheat_body":    "Calentamiento completado — lista para extraer",
		"low_stock_title": "🫘 Grano casi agotado",
		"low_stock_body":  "%s: quedan unos %d g — ¿pedir más?",
	},
	"nl": {
		"preheat_title":   "☕ Machine gereed",
		"preheat_body":    "Opwarmen voltooid — klaar om te zetten",
		"low_stock_title": "🫘 Boon bijna op",
		"low_stock_body":  "%s: nog ongeveer %d g over — bijbestellen?",
	},
}

// NotifyText returns the localized notification text for key in lang, with
// args formatted into it. An unknown language — or a key missing from that
// language — falls back to English; a key absent everywhere yields "".
func NotifyText(lang, key string, args ...any) string {
	table, ok := notifyTextCatalog[lang]
	if !ok {
		table = notifyTextCatalog["en"]
	}
	text, ok := table[key]
	if !ok {
		text = notifyTextCatalog["en"][key]
	}
	if text == "" || len(args) == 0 {
		return text
	}
	return fmt.Sprintf(text, args...)
}
