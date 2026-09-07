package importer

import (
	"reflect"
	"testing"
)

func TestMapOriginToCode(t *testing.T) {
	cases := map[string]string{
		"Äthiopien":    "ET",
		"Brasilien":    "BR",
		"Kolumbien":    "CO",
		"Ethiopia":     "ET",
		"Vietnam":      "VN",
		"  äthiopien ": "ET",
		"Hawaii":       "US",
		"Kongo":        "CD",
	}
	for in, want := range cases {
		if got := mapOriginToCode(in); got != want {
			t.Errorf("mapOriginToCode(%q) = %q, want %q", in, got, want)
		}
	}
	for _, in := range []string{"Brasilien, Indien", "Mondbasis Alpha", ""} {
		if got := mapOriginToCode(in); got != "" {
			t.Errorf("mapOriginToCode(%q) = %q, want empty", in, got)
		}
	}
}

func TestFindCountriesInText(t *testing.T) {
	cases := []struct {
		text string
		max  int
		want []string
	}{
		{"Dieser Kaffee kommt aus Äthiopien.", 0, []string{"ET"}},
		{"Ein Espresso ohne jede Herkunftsangabe.", 0, nil},
		{"", 0, nil},
		{"Ein Blend aus Brasilien und Indien.", 0, []string{"BR", "IN"}},
		{"Ein Blend aus Indien und Brasilien.", 0, []string{"IN", "BR"}},
		{"Der Charakter Äthiopiens bleibt erhalten.", 0, []string{"ET"}},
		{"Wir importieren aus Brasilien, Kolumbien, Äthiopien, Kenia und Vietnam.", 0, nil},
		{"Wir importieren aus Brasilien, Kolumbien, Äthiopien, Kenia und Vietnam.", 5, []string{"BR", "CO", "ET", "KE", "VN"}},
	}
	for _, c := range cases {
		got := findCountriesInText(c.text, c.max)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("findCountriesInText(%q, %d) = %v, want %v", c.text, c.max, got, c.want)
		}
	}
}

func TestSplitFlavors(t *testing.T) {
	got := splitFlavors("Aprikose, Limonade (Filter); Aprikose")
	want := []string{"Aprikose", "Limonade"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitFlavors = %v, want %v", got, want)
	}
}

func TestExtractFlavorKeywords(t *testing.T) {
	text := "Sensorik – ruhig und strukturiert In der Tasse zeigt sich der Kaffee zugänglich. " +
		"Die Basis bilden Kakaonibs und dunkles Karamell. Mandarine erscheint als süß-zitrischer Akzent. " +
		"Hier findest Du unsere Brewguides."
	got := extractFlavorKeywords(text)
	for _, want := range []string{"Kakaonibs", "Karamell", "Mandarine"} {
		if !contains(got, want) {
			t.Errorf("extractFlavorKeywords missing %q, got %v", want, got)
		}
	}
	if flavors := extractFlavorKeywords("Ein Espresso ohne jede Geschmacksbeschreibung."); len(flavors) != 0 {
		t.Errorf("expected empty, got %v", flavors)
	}
	stop := "Sensorik – klar. Etwas Kirsche. Hier findest Du unsere Brewguides. Ein völlig anderes Produkt erwähnt an dieser Stelle Vanille."
	if contains(extractFlavorKeywords(stop), "Vanille") {
		t.Error("extractFlavorKeywords should stop at the Brewguide footer")
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}
