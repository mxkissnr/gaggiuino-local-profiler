package importer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// readHTMLFixture reads a raw HTML snapshot from testdata (loadFixture in
// parsers_test.go decodes JSON fixtures, so the HTML ones need their own
// reader).
func readHTMLFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("reading fixture %s: %v", name, err)
	}
	return string(b)
}

// TestEnrichGenericBeanFromHTML_SproutFlowerPower runs the HTML-only
// enrichment pass over the real sproutcoffeeroasters.art snapshot
// (testdata/sprout-flower-power.html, #555) and pins the fields the markup
// actually carries: the title subtitle (tasting notes), the "Details"
// accordion (process/variety/producer/origin/elevation) and the "Brew Guide"
// accordion (espresso recipe). No network: the fixture is the whole input.
func TestEnrichGenericBeanFromHTML_SproutFlowerPower(t *testing.T) {
	html := readHTMLFixture(t, "sprout-flower-power.html")
	bean := map[string]any{"name": "Flower Power"}

	got := enrichGenericBeanFromHTML(bean, html, "sproutcoffeeroasters.art")

	// <p>White Peach, Strawberry, Jasmine</p> under the <h1>.
	if f := beanStrings(got, "flavors"); strings.Join(f, "|") != "White Peach|Strawberry|Jasmine" {
		t.Errorf("flavors = %v, want [White Peach Strawberry Jasmine]", f)
	}

	// "Details" accordion, one "<label> - <value>" per line.
	assertField(t, got, "process", "Anaerobic Natural")
	assertField(t, got, "variety", "74112, 74110")
	assertField(t, got, "producer", "Producers in the Yirgacheffe region")
	assertField(t, got, "region", "Banko Chelchele, Gedeb Zone, Southern Ethiopia")
	assertField(t, got, "altitude_m", 2100) // Elevation 1900-2300 MASL -> midpoint

	// "Southern Ethiopia" resolves to the ET origin.
	assertField(t, got, "origin", "ET")
	if o := beanOrigins(got); len(o) != 1 || o[0]["code"] != "ET" {
		t.Errorf("origins = %v, want a single ET entry", o)
	}

	// "Brew Guide" accordion; the espresso block is chosen over the Milky
	// Espresso one, which stays as an extra recipe.
	assertField(t, got, "brewTempC", 92.5) // Temp 92-93 Celsius -> midpoint
	assertField(t, got, "brewTimeS", 28)   // Time 27-29 seconds -> midpoint
	assertField(t, got, "brewRatio", "1:2.4")
	if notes, _ := got["notes"].(string); !strings.HasPrefix(notes, "Roaster brew guide (espresso):") {
		t.Errorf("notes = %q, want an espresso brew-guide prefix", notes)
	}
	if extra, _ := got["extraBrewRecipes"].([]map[string]any); len(extra) != 1 || extra[0]["name"] != "Milky Espresso" {
		t.Errorf("extraBrewRecipes = %v, want the Milky Espresso recipe", extra)
	}

	// The starting bean is cloned, not mutated.
	if bean["name"] != "Flower Power" || len(bean) != 1 {
		t.Errorf("input bean mutated: %v", bean)
	}
}

// TestEnrichGenericBeanFromHTML_SquareMileRedBrick runs the same pass over the
// real shop.squaremilecoffee.com snapshot
// (testdata/squaremile-red-brick.html, #555): a two-block .origin-content
// blend header, the .additional-info flavor line, and the .recipe-bullet
// "RECIPE DETAILS" block. No network.
func TestEnrichGenericBeanFromHTML_SquareMileRedBrick(t *testing.T) {
	html := readHTMLFixture(t, "squaremile-red-brick.html")
	bean := map[string]any{"name": "Red Brick"}

	got := enrichGenericBeanFromHTML(bean, html, "shop.squaremilecoffee.com")

	// <h5 class="additional-info">PLUM / CHOCOLATE / HAZELNUT / RAISIN</h5>.
	if f := beanStrings(got, "flavors"); strings.Join(f, "|") != "Plum|Chocolate|Hazelnut|Raisin" {
		t.Errorf("flavors = %v, want [Plum Chocolate Hazelnut Raisin]", f)
	}

	// Two .origin-content blocks (Costa Rica / Guatemala); the same field in
	// both is joined with " / ".
	assertField(t, got, "process", "White Honey / Washed")
	assertField(t, got, "variety", "Catuaí, Caturra / Catuaí, Bourbon, Caturra")
	assertField(t, got, "producer", "Puente Tarrazú Micromill / Chacayá Producer Group")
	assertField(t, got, "region", "Costa Rica / Guatemala")

	// Both countries resolve, in document order.
	assertField(t, got, "origin", "CR")
	if o := beanOrigins(got); len(o) != 2 || o[0]["code"] != "CR" || o[1]["code"] != "GT" {
		t.Errorf("origins = %v, want CR then GT", o)
	}

	// .recipe-bullet "RECIPE DETAILS".
	assertField(t, got, "brewTempC", 94.25) // 94ºC-94.5ºC -> midpoint
	assertField(t, got, "brewTimeS", 30)    // 28-32 sec -> midpoint
	assertField(t, got, "brewRatio", "1:2")

	if bean["name"] != "Red Brick" || len(bean) != 1 {
		t.Errorf("input bean mutated: %v", bean)
	}
}
