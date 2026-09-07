package importer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func loadFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("reading fixture %s: %v", name, err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("decoding fixture %s: %v", name, err)
	}
	return m
}

func TestParseHoploProduct(t *testing.T) {
	bean := parseHoploProduct(loadFixture(t, "hoplo-shyira.json"))
	if bean == nil {
		t.Fatal("expected a bean")
	}
	assertField(t, bean, "name", "Shyira Washed - Ruanda")
	assertField(t, bean, "roaster", "Hoppenworth & Ploch")
	assertField(t, bean, "origin", "RW")
	assertField(t, bean, "variety", "Red Bourbon")
	assertField(t, bean, "process", "Washed")
	assertField(t, bean, "source", "hoppenworth-ploch.de")
	assertField(t, bean, "region", "Nyabihu District")
	assertField(t, bean, "importer", "Rehm Coffee")
	assertField(t, bean, "harvest", "04-06.25")
	if bean["altitude_m"] != 1850 {
		t.Errorf("altitude_m = %v, want 1850", bean["altitude_m"])
	}
	flavors := beanStrings(bean, "flavors")
	if !contains(flavors, "Aprikose") || !contains(flavors, "Schwarzer Tee") {
		t.Errorf("flavors = %v, want to contain Aprikose + Schwarzer Tee", flavors)
	}
	if _, ok := bean["decaf"]; ok {
		t.Error("decaf should be absent")
	}
}

func TestParseHoploDecafTitle(t *testing.T) {
	bean := parseHoploProduct(map[string]any{
		"title": "DECAF Sertao - Brasilien", "vendor": "Hoppenworth & Ploch", "description": "",
	})
	if bean["decaf"] != true {
		t.Errorf("decaf = %v, want true", bean["decaf"])
	}
	assertField(t, bean, "origin", "BR")
}

func TestParseHoploNoTitle(t *testing.T) {
	if parseHoploProduct(map[string]any{}) != nil {
		t.Error("expected nil without a title")
	}
}

func TestParseElbgoldBombe(t *testing.T) {
	bean := parseElbgoldProduct(loadFixture(t, "elbgold-bombe.json"))
	if bean == nil {
		t.Fatal("expected a bean")
	}
	assertField(t, bean, "name", "BOMBE")
	assertField(t, bean, "roaster", "elbgold")
	assertField(t, bean, "roastType", "espresso")
	assertField(t, bean, "source", "elbgold.com")
	assertField(t, bean, "origin", "ET")
	if region, _ := bean["region"].(string); !containsSub(region, "Sidama") {
		t.Errorf("region = %v, want to contain Sidama", bean["region"])
	}
	if len(beanStrings(bean, "flavors")) == 0 {
		t.Error("expected non-empty flavors")
	}
}

func TestParseElbgoldLaMaravilla(t *testing.T) {
	bean := parseElbgoldProduct(loadFixture(t, "elbgold-la-maravilla.json"))
	flavors := beanStrings(bean, "flavors")
	if !contains(flavors, "Kirsche") || !contains(flavors, "Nougat") {
		t.Errorf("flavors = %v, want Kirsche + Nougat", flavors)
	}
	if region, _ := bean["region"].(string); !containsSub(region, "La Maravilla") {
		t.Errorf("region = %v", bean["region"])
	}
}

func TestParseElbgoldKeniaDecaf(t *testing.T) {
	bean := parseElbgoldProduct(loadFixture(t, "elbgold-kenia-decaf.json"))
	if bean["decaf"] != true {
		t.Errorf("decaf = %v, want true", bean["decaf"])
	}
	assertField(t, bean, "origin", "KE")
	assertField(t, bean, "region", "Nyeri")
	flavors := beanStrings(bean, "flavors")
	if !contains(flavors, "Mandarine") || !contains(flavors, "Karamell") {
		t.Errorf("flavors = %v, want Mandarine + Karamell", flavors)
	}
}

func TestParseGenericShopify(t *testing.T) {
	bean := parseGenericShopifyProduct(map[string]any{
		"title": "Ethiopia Washed", "vendor": "Random Roastery",
		"description": "<p>Noten von Zitrone.</p>", "featured_image": "//cdn.shopify.com/random.jpg",
	}, "randomroaster.example")
	assertField(t, bean, "name", "Ethiopia Washed")
	assertField(t, bean, "roaster", "Random Roastery")
	assertField(t, bean, "imageUrl", "https://cdn.shopify.com/random.jpg")

	// vendor that's a taxonomy tag -> falls back to host
	bean = parseGenericShopifyProduct(map[string]any{
		"title": "Flower Power", "vendor": "adventurous", "description": "",
	}, "sproutcoffeeroasters.art")
	assertField(t, bean, "roaster", "sproutcoffeeroasters.art")
}

func TestShopifyJSONURL(t *testing.T) {
	cases := map[string]string{
		"/products/shyira-washed-ruanda":              "https://hoppenworth-ploch.de/products/shyira-washed-ruanda.js",
		"/collections/kaffee/products/cajamarca-peru": "https://hoppenworth-ploch.de/products/cajamarca-peru.js",
		"/collections/kaffee":                         "",
	}
	for path, want := range cases {
		if got := shopifyJSONURL(path, "hoppenworth-ploch.de"); got != want {
			t.Errorf("shopifyJSONURL(%q) = %q, want %q", path, got, want)
		}
	}
}

func assertField(t *testing.T, m map[string]any, key string, want any) {
	t.Helper()
	if m[key] != want {
		t.Errorf("%s = %#v, want %#v", key, m[key], want)
	}
}

func containsSub(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
