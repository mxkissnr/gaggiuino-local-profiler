package importer

import (
	"regexp"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// This file ports lib/import-parsers.js's three built-in shop parsers
// (parseKaffeebraun, parseHoploProduct, parseElbgoldProduct). Each returns
// a bean map (JS object) or nil when the page/JSON carries no product.
// cheerio.load(html) -> goquery.

func loadHTML(html string) *goquery.Document {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		// goquery only errors on a nil reader; an empty/garbage string
		// still yields a usable (empty) document, same as cheerio.load('').
		doc, _ = goquery.NewDocumentFromReader(strings.NewReader(""))
	}
	return doc
}

var decafRe = regexp.MustCompile(`(?i)\bdecaf\b`)

// ── kaffeebraun.com (Shopware) ────────────────────────────────────────────

func parseKaffeebraun(html string) map[string]any {
	doc := loadHTML(html)
	name := strings.TrimSpace(doc.Find(".product-detail-name").First().Text())
	if name == "" {
		return nil
	}
	props := map[string]string{}
	doc.Find("tr.properties-row").Each(func(_ int, row *goquery.Selection) {
		key := strings.TrimSpace(strings.ReplaceAll(row.Find("th.properties-label").Text(), ":", ""))
		var vals []string
		row.Find("td.properties-value span").Each(func(_ int, el *goquery.Selection) {
			if t := strings.TrimSpace(el.Text()); t != "" {
				vals = append(vals, t)
			}
		})
		val := strings.Join(vals, ", ")
		if key != "" && val != "" {
			props[key] = val
		}
	})
	roastLabel := strings.TrimSpace(doc.Find(".degree.roest .description").First().Text())
	roastScore := strings.TrimSpace(doc.Find(".degree.roest .value-score").First().Text())
	imageURL := ""
	if c, ok := doc.Find(`meta[property="og:image"]`).Attr("content"); ok {
		imageURL = normalizeImageURL(c)
	}
	origin := mapOriginToCode(props["Herkunft"])
	var noteParts []string
	if props["Herkunft"] != "" && origin == "" {
		noteParts = append(noteParts, "Herkunft: "+props["Herkunft"])
	}
	if roastLabel != "" {
		noteParts = append(noteParts, "Röstgrad: "+roastLabel+" ("+roastScore+"/5)")
	}
	return map[string]any{
		"name":       name,
		"roaster":    "Kaffee Braun",
		"notes":      strings.Join(noteParts, " · "),
		"flavors":    splitFlavors(props["Aroma"]),
		"origin":     strOrNil(origin),
		"variety":    strOrNil(props["Varietät"]),
		"process":    strOrNil(props["Aufbereitungsart"]),
		"imageUrl":   imageURL,
		"source":     "kaffeebraun.com",
		"importedAt": today(),
	}
}

// ── hoppenworth-ploch.de (Shopify) ───────────────────────────────────────

var ernteRe = regexp.MustCompile(`^Ernte:\s*(.+)$`)

func parseHoploProduct(product map[string]any) map[string]any {
	title := strings.TrimSpace(mstr(product, "title"))
	if title == "" {
		return nil
	}
	doc := loadHTML(mstr(product, "description"))
	fields := map[string]string{}
	doc.Find("li").Each(func(_ int, el *goquery.Selection) {
		if el.Find("li").Length() > 0 {
			return // skip tab containers, keep leaf items
		}
		text := collapseWS(el.Text())
		idx := strings.Index(text, ":")
		if idx <= 0 || idx > 30 {
			return
		}
		key := strings.TrimSpace(text[:idx])
		val := strings.TrimSpace(text[idx+1:])
		if key != "" && val != "" {
			if _, exists := fields[key]; !exists {
				fields[key] = val
			}
		}
	})
	countryPart := ""
	if strings.Contains(title, " - ") {
		parts := strings.Split(title, " - ")
		countryPart = strings.TrimSpace(parts[len(parts)-1])
	}
	origin := mapOriginToCode(countryPart)
	if origin == "" {
		origin = mapOriginToCode(fields["Herkunft"])
	}
	var region any
	if fields["Herkunft"] != "" && mapOriginToCode(fields["Herkunft"]) == "" {
		region = fields["Herkunft"]
	}
	var harvest any
	doc.Find("p").EachWithBreak(func(_ int, el *goquery.Selection) bool {
		m := ernteRe.FindStringSubmatch(collapseWS(el.Text()))
		if m != nil {
			harvest = strings.TrimSpace(m[1])
			return false
		}
		return true
	})
	// Node uses `product.vendor || 'Hoppenworth & Ploch'` — the raw field,
	// not trimmed (unlike parseGenericShopifyProduct).
	roaster := mstr(product, "vendor")
	if roaster == "" {
		roaster = "Hoppenworth & Ploch"
	}
	bean := map[string]any{
		"name":       title,
		"roaster":    roaster,
		"notes":      "",
		"flavors":    splitFlavors(fields["Geschmack"]),
		"region":     region,
		"origin":     strOrNil(origin),
		"variety":    strOrNil(fields["Varietät"]),
		"process":    strOrNil(fields["Prozess"]),
		"roastType":  strOrNil(roastTypeFromTags(anyToStrings(product["tags"]))),
		"imageUrl":   normalizeImageURL(product["featured_image"]),
		"importer":   strOrNil(fields["Importeur"]),
		"harvest":    harvest,
		"altitude_m": intPtrToAny(extractAltitudeM(doc.Text())),
		"price_eur":  floatPtrToAny(priceFromProduct(product)),
		"source":     "hoppenworth-ploch.de",
		"importedAt": today(),
	}
	if decafRe.MatchString(title) {
		bean["decaf"] = true
	}
	return bean
}

// ── elbgold.com (Shopify) ────────────────────────────────────────────────

var (
	elbgoldHerkunftRe = regexp.MustCompile(`^Herkunft\s*[–—:-]\s*(.{2,80})$`)
	notenVonRe        = regexp.MustCompile(`(?i)Noten von ([^.!?]{3,140})`)
	undRe             = regexp.MustCompile(`(?i)\s+und\s+`)
	mitPrefixRe       = regexp.MustCompile(`(?i)^mit\s+(?:einem|einer)?\s*`)
	decafEntkRe       = regexp.MustCompile(`(?i)\bdecaf|entkoffeiniert\b`)
)

func parseElbgoldProduct(product map[string]any) map[string]any {
	title := strings.TrimSpace(mstr(product, "title"))
	if title == "" {
		return nil
	}
	doc := loadHTML(mstr(product, "description"))
	text := collapseWS(doc.Text())

	region := ""
	doc.Find("strong, b, h2, h3, h4").EachWithBreak(func(_ int, el *goquery.Selection) bool {
		m := elbgoldHerkunftRe.FindStringSubmatch(collapseWS(el.Text()))
		if m != nil {
			region = strings.TrimSpace(m[1])
			return false
		}
		return true
	})

	var flavors []string
	if m := notenVonRe.FindStringSubmatch(text); m != nil {
		for _, f := range splitFlavors(undRe.ReplaceAllString(m[1], ",")) {
			f = strings.TrimSpace(mitPrefixRe.ReplaceAllString(f, ""))
			if f != "" && len([]rune(f)) <= 40 {
				flavors = append(flavors, f)
			}
		}
		if len(flavors) > 8 {
			flavors = flavors[:8]
		}
	} else {
		flavors = extractFlavorKeywords(text)
	}
	if flavors == nil {
		flavors = []string{}
	}

	tagText := strings.Join(anyToStrings(product["tags"]), " ")
	originCodes := findCountriesInText(title+" "+region, 0)
	if len(originCodes) == 0 {
		originCodes = findCountriesInText(text, 0)
	}

	roaster := mstr(product, "vendor")
	if roaster == "" {
		roaster = "elbgold"
	}
	bean := map[string]any{
		"name":       title,
		"roaster":    roaster,
		"notes":      "",
		"flavors":    flavors,
		"region":     strOrNil(region),
		"origin":     firstCodeOrNil(originCodes),
		"origins":    codesToOrigins(originCodes),
		"variety":    nil,
		"process":    nil,
		"roastType":  strOrNil(roastTypeFromTags(anyToStrings(product["tags"]))),
		"imageUrl":   normalizeImageURL(product["featured_image"]),
		"altitude_m": intPtrToAny(extractAltitudeM(text)),
		"price_eur":  floatPtrToAny(priceFromProduct(product)),
		"source":     "elbgold.com",
		"importedAt": today(),
	}
	if decafEntkRe.MatchString(title + " " + tagText) {
		bean["decaf"] = true
	}
	return bean
}

// ── shared small conversions ─────────────────────────────────────────────

func intPtrToAny(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func floatPtrToAny(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func firstCodeOrNil(codes []string) any {
	if len(codes) == 0 {
		return nil
	}
	return codes[0]
}

func codesToOrigins(codes []string) []map[string]any {
	out := make([]map[string]any, 0, len(codes))
	for _, c := range codes {
		out = append(out, map[string]any{"code": c})
	}
	return out
}
