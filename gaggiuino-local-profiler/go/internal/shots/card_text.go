package shots

import (
	"fmt"
	"strings"
	"time"
)

// cardTextCatalog holds the share card's and the comparative grind advice's
// localized strings, keyed by language and then by key (#1620). Same shape
// and fallback rules as internal/ha's notification catalog: an unknown
// language — or a key missing from a known language — falls back to English.
var cardTextCatalog = map[string]map[string]string{
	"de": {
		"shot_id":            "Shot #%d",
		"unknown":            "Unbekannt",
		"tier_top":           "Herausragender Shot",
		"tier_great":         "Richtig gut getroffen",
		"tier_solid":         "Solider Shot",
		"tier_dialin":        "Dial-in lohnt sich noch",
		"dose":               "Dosis",
		"preinfusion":        "Preinfusion",
		"extraction":         "Extraktion",
		"pressure":           "Druck",
		"pump_flow":          "Pumpenfluss",
		"weight_flow":        "Gewichtsfluss",
		"weight":             "Gewicht",
		"temperature":        "Temperatur",
		"target_pressure":    "Ziel Druck",
		"target_flow":        "Ziel Fluss",
		"target_temperature": "Ziel Temperatur",
		"press_target":       "Ziel %s",
		"press_max":          "max %s",
		"dose_yield":         "Dosis → Ausbeute",
		"ratio":              "Ratio",
		"duration":           "Dauer",
		"pressure_avg":       "Druck Ø",
		"pump_flow_avg":      "Pumpenfluss Ø",
		"temperature_avg":    "Temperatur Ø",
		"compare_finer":      "%d Vergleichsshots: Mahlgrad %g → Score %d – feiner mahlen",
		"compare_coarser":    "%d Vergleichsshots: Mahlgrad %g → Score %d – gröber mahlen",
		"compare_ok":         "%d Vergleichsshots bestätigen deinen Mahlgrad (Ø Score %d)",
	},
	"en": {
		"shot_id":            "Shot #%d",
		"unknown":            "Unknown",
		"tier_top":           "Outstanding shot",
		"tier_great":         "Really dialed in",
		"tier_solid":         "Solid shot",
		"tier_dialin":        "Dial-in still worth it",
		"dose":               "Dose",
		"preinfusion":        "Pre-infusion",
		"extraction":         "Extraction",
		"pressure":           "Pressure",
		"pump_flow":          "Pump flow",
		"weight_flow":        "Weight flow",
		"weight":             "Weight",
		"temperature":        "Temperature",
		"target_pressure":    "Target pressure",
		"target_flow":        "Target flow",
		"target_temperature": "Target temperature",
		"press_target":       "Target %s",
		"press_max":          "max %s",
		"dose_yield":         "Dose → Yield",
		"ratio":              "Ratio",
		"duration":           "Duration",
		"pressure_avg":       "Pressure Ø",
		"pump_flow_avg":      "Pump flow Ø",
		"temperature_avg":    "Temperature Ø",
		"compare_finer":      "%d comparable shots: grind %g → score %d — grind finer",
		"compare_coarser":    "%d comparable shots: grind %g → score %d — grind coarser",
		"compare_ok":         "%d comparable shots confirm your grind setting (avg score %d)",
	},
	"es": {
		"shot_id":            "Shot #%d",
		"unknown":            "Desconocido",
		"tier_top":           "Shot excepcional",
		"tier_great":         "Muy bien ajustado",
		"tier_solid":         "Shot sólido",
		"tier_dialin":        "Aún merece la pena ajustar",
		"dose":               "Dosis",
		"preinfusion":        "Preinfusión",
		"extraction":         "Extracción",
		"pressure":           "Presión",
		"pump_flow":          "Flujo de bomba",
		"weight_flow":        "Flujo de peso",
		"weight":             "Peso",
		"temperature":        "Temperatura",
		"target_pressure":    "Presión objetivo",
		"target_flow":        "Flujo objetivo",
		"target_temperature": "Temperatura objetivo",
		"press_target":       "Objetivo %s",
		"press_max":          "máx %s",
		"dose_yield":         "Dosis → Rendimiento",
		"ratio":              "Ratio",
		"duration":           "Duración",
		"pressure_avg":       "Presión Ø",
		"pump_flow_avg":      "Flujo de bomba Ø",
		"temperature_avg":    "Temperatura Ø",
		"compare_finer":      "%d shots comparables: molturación %g → score %d — moler más fino",
		"compare_coarser":    "%d shots comparables: molturación %g → score %d — moler más grueso",
		"compare_ok":         "%d shots comparables confirman tu molturación (score medio %d)",
	},
	"fr": {
		"shot_id":            "Shot #%d",
		"unknown":            "Inconnu",
		"tier_top":           "Shot exceptionnel",
		"tier_great":         "Vraiment bien réglé",
		"tier_solid":         "Shot solide",
		"tier_dialin":        "Le réglage vaut encore le coup",
		"dose":               "Dose",
		"preinfusion":        "Pré-infusion",
		"extraction":         "Extraction",
		"pressure":           "Pression",
		"pump_flow":          "Débit de pompe",
		"weight_flow":        "Débit de poids",
		"weight":             "Poids",
		"temperature":        "Température",
		"target_pressure":    "Pression cible",
		"target_flow":        "Débit cible",
		"target_temperature": "Température cible",
		"press_target":       "Cible %s",
		"press_max":          "max %s",
		"dose_yield":         "Dose → Rendement",
		"ratio":              "Ratio",
		"duration":           "Durée",
		"pressure_avg":       "Pression Ø",
		"pump_flow_avg":      "Débit de pompe Ø",
		"temperature_avg":    "Température Ø",
		"compare_finer":      "%d shots comparables: mouture %g → score %d — moudre plus fin",
		"compare_coarser":    "%d shots comparables: mouture %g → score %d — moudre plus grossier",
		"compare_ok":         "%d shots comparables confirment votre mouture (score moy. %d)",
	},
	"it": {
		"shot_id":            "Shot #%d",
		"unknown":            "Sconosciuto",
		"tier_top":           "Shot eccezionale",
		"tier_great":         "Davvero centrato",
		"tier_solid":         "Shot solido",
		"tier_dialin":        "Vale ancora la pena tarare",
		"dose":               "Dose",
		"preinfusion":        "Preinfusione",
		"extraction":         "Estrazione",
		"pressure":           "Pressione",
		"pump_flow":          "Flusso pompa",
		"weight_flow":        "Flusso peso",
		"weight":             "Peso",
		"temperature":        "Temperatura",
		"target_pressure":    "Pressione target",
		"target_flow":        "Flusso target",
		"target_temperature": "Temperatura target",
		"press_target":       "Target %s",
		"press_max":          "max %s",
		"dose_yield":         "Dose → Resa",
		"ratio":              "Ratio",
		"duration":           "Durata",
		"pressure_avg":       "Pressione Ø",
		"pump_flow_avg":      "Flusso pompa Ø",
		"temperature_avg":    "Temperatura Ø",
		"compare_finer":      "%d shot comparabili: macinatura %g → score %d – macinare più fine",
		"compare_coarser":    "%d shot comparabili: macinatura %g → score %d – macinare più grosso",
		"compare_ok":         "%d shot comparabili confermano la macinatura (score medio %d)",
	},
	"nl": {
		"shot_id":            "Shot #%d",
		"unknown":            "Onbekend",
		"tier_top":           "Uitzonderlijke shot",
		"tier_great":         "Echt goed geraakt",
		"tier_solid":         "Solide shot",
		"tier_dialin":        "Afstellen loont nog",
		"dose":               "Dosis",
		"preinfusion":        "Pre-infusie",
		"extraction":         "Extractie",
		"pressure":           "Druk",
		"pump_flow":          "Pompdebiet",
		"weight_flow":        "Gewichtsdebiet",
		"weight":             "Gewicht",
		"temperature":        "Temperatuur",
		"target_pressure":    "Doeldruk",
		"target_flow":        "Doeldebiet",
		"target_temperature": "Doeltemperatuur",
		"press_target":       "Doel %s",
		"press_max":          "max %s",
		"dose_yield":         "Dosis → Opbrengst",
		"ratio":              "Ratio",
		"duration":           "Duur",
		"pressure_avg":       "Druk Ø",
		"pump_flow_avg":      "Pompdebiet Ø",
		"temperature_avg":    "Temperatuur Ø",
		"compare_finer":      "%d vergelijkbare shots: maalgraad %g → score %d — fijner malen",
		"compare_coarser":    "%d vergelijkbare shots: maalgraad %g → score %d — grover malen",
		"compare_ok":         "%d vergelijkbare shots bevestigen je maalgraad (gem. score %d)",
	},
}

// cardMonths holds the abbreviated month names the card's local date prints.
var cardMonths = map[string][]string{
	"de": {"Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."},
	"en": {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"},
	"es": {"ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"},
	"fr": {"janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."},
	"it": {"gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"},
	"nl": {"jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"},
}

// normalizeCardLang maps a client UI language tag ("de", "de-DE", "DE_de")
// to one of the shipped card languages. Anything unknown becomes English,
// matching the frontend's own TRANSLATIONS fallback.
func normalizeCardLang(lang string) string {
	lang = strings.ToLower(strings.TrimSpace(lang))
	if i := strings.IndexAny(lang, "-_"); i >= 0 {
		lang = lang[:i]
	}
	if _, ok := cardTextCatalog[lang]; ok {
		return lang
	}
	return "en"
}

// cardText returns key's text in lang, falling back to English for an
// unknown language or a missing key.
func cardText(lang, key string) string {
	table, ok := cardTextCatalog[normalizeCardLang(lang)]
	if !ok {
		table = cardTextCatalog["en"]
	}
	text, ok := table[key]
	if !ok {
		text = cardTextCatalog["en"][key]
	}
	return text
}

// cardTextf is cardText with args formatted into it.
func cardTextf(lang, key string, args ...any) string {
	text := cardText(lang, key)
	if text == "" || len(args) == 0 {
		return text
	}
	return fmt.Sprintf(text, args...)
}

// cardDate formats a Unix timestamp in the app's local time zone, with the
// month name in lang. The card uses the same local day as the shot list,
// not the UTC day the old German-only formatter used.
func cardDate(lang string, unixSec int64) string {
	t := time.Unix(unixSec, 0).In(time.Local)
	lang = normalizeCardLang(lang)
	month := cardMonths[lang][int(t.Month())-1]
	switch lang {
	case "de":
		return fmt.Sprintf("%02d. %s %d", t.Day(), month, t.Year())
	case "en":
		return fmt.Sprintf("%s %d, %d", month, t.Day(), t.Year())
	default:
		return fmt.Sprintf("%d %s %d", t.Day(), month, t.Year())
	}
}
