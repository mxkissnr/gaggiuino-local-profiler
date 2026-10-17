package importer

import (
	"regexp"
	"strings"

	"github.com/PuerkitoBio/goquery"
	"golang.org/x/net/html"
)

// ── HTML-only bean-detail enrichment ────────────────────────────────────

var lineBreakTags = map[string]bool{
	"br": true, "p": true, "div": true, "li": true,
	"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true, "tr": true,
}

// textWithLineBreaks reads .text() but inserts a literal "\n" after every
// block-level element, so minified themes with no incidental whitespace
// between tags don't run adjacent lines together.
func textWithLineBreaks(sel *goquery.Selection) string {
	var b strings.Builder
	for _, n := range sel.Nodes {
		nodeTextLB(n, &b)
	}
	return b.String()
}

func nodeTextLB(n *html.Node, b *strings.Builder) {
	switch n.Type {
	case html.TextNode:
		b.WriteString(n.Data)
	case html.ElementNode:
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			nodeTextLB(c, b)
		}
		if lineBreakTags[n.Data] {
			b.WriteString("\n")
		}
	default:
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			nodeTextLB(c, b)
		}
	}
}

var tabRunRe = regexp.MustCompile(`[ \t]+`)

// accordionLines returns the deduped non-empty lines of a content block
// (insertion order preserved).
func accordionLines(content *goquery.Selection) []string {
	seen := map[string]bool{}
	var out []string
	for _, raw := range strings.Split(textWithLineBreaks(content), "\n") {
		t := strings.TrimSpace(tabRunRe.ReplaceAllString(raw, " "))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

// accordionLabelFields maps lowercase accordion labels to bean field names.
var accordionLabelFields = map[string]string{
	"process": "process", "prozess": "process",
	"variety": "variety", "varietal": "variety", "cultivar": "variety", "sorte": "variety",
	"producer": "producer", "erzeuger": "producer", "produzent": "producer",
	"origin": "region", "region": "region", "terroir": "region", "herkunft": "region", "ursprung": "region",
	"country": "region", "land": "region",
	"elevation": "altitude_m", "altitude": "altitude_m", "höhe": "altitude_m", "hoehe": "altitude_m", "lage": "altitude_m",
}

var accordionLabelRe = func() *regexp.Regexp {
	keys := make([]string, 0, len(accordionLabelFields))
	for k := range accordionLabelFields {
		keys = append(keys, regexp.QuoteMeta(k))
	}
	return regexp.MustCompile(`(?i)^(` + strings.Join(keys, "|") + `)\s*[-–—:]\s*(.+)$`)
}()

func scanAccordionLabelValues(doc *goquery.Document) map[string]any {
	fields := map[string]any{}
	doc.Find("details").Each(func(_ int, el *goquery.Selection) {
		content := el.Find(".details-content").First()
		if content.Length() == 0 {
			return
		}
		for _, line := range accordionLines(content) {
			m := accordionLabelRe.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			field := accordionLabelFields[strings.ToLower(m[1])]
			value := strings.TrimSpace(m[2])
			if field == "" || value == "" {
				continue
			}
			if _, exists := fields[field]; exists {
				continue
			}
			if field == "altitude_m" {
				fields[field] = intPtrToAny(extractAltitudeM(value))
			} else {
				fields[field] = value
			}
		}
	})
	return fields
}

func scanOriginWrapperFields(doc *goquery.Document) map[string]any {
	var blockScopes []*goquery.Selection
	blocks := doc.Find(".origin-content")
	if blocks.Length() > 0 {
		blocks.Each(func(_ int, s *goquery.Selection) { blockScopes = append(blockScopes, s) })
	} else {
		blockScopes = append(blockScopes, doc.Selection)
	}

	var perBlockFields []map[string]any
	for _, scope := range blockScopes {
		fields := map[string]any{}
		scope.Find(".origin-title").Each(func(_ int, el *goquery.Selection) {
			label := strings.ToLower(collapseWS(el.Text()))
			field := accordionLabelFields[label]
			if field == "" {
				return
			}
			if _, exists := fields[field]; exists {
				return
			}
			value := collapseWS(el.NextFiltered("p").Text())
			if value == "" {
				return
			}
			if field == "altitude_m" {
				fields[field] = intPtrToAny(extractAltitudeM(value))
			} else {
				fields[field] = value
			}
		})
		if len(fields) > 0 {
			perBlockFields = append(perBlockFields, fields)
		}
	}

	merged := map[string]any{}
	distinctFields := map[string]bool{}
	for _, f := range accordionLabelFields {
		distinctFields[f] = true
	}
	for field := range distinctFields {
		var values []string
		haveAlt := false
		var altVal any
		for _, f := range perBlockFields {
			v, ok := f[field]
			if !ok || v == nil {
				continue
			}
			if field == "altitude_m" {
				if !haveAlt {
					haveAlt = true
					altVal = v
				}
				continue
			}
			values = append(values, toStringVal(v))
		}
		if field == "altitude_m" {
			if haveAlt {
				merged[field] = altVal
			}
			continue
		}
		if len(values) == 0 {
			continue
		}
		merged[field] = strings.Join(dedupeStrings(values), " / ")
	}
	return merged
}

// scanBeanDetailFields merges the detail fields: the <details> accordion
// scan wins; origin-wrapper only fills gaps.
func scanBeanDetailFields(doc *goquery.Document) map[string]any {
	fields := scanAccordionLabelValues(doc)
	for field, value := range scanOriginWrapperFields(doc) {
		if _, ok := fields[field]; !ok {
			fields[field] = value
		}
	}
	return fields
}
