package importer

import "strings"

// This file holds the built-in shop registry and matchProvider host
// dispatch.

type providerKind string

const (
	kindHTML    providerKind = "html"
	kindShopify providerKind = "shopify"
)

// provider is the resolved match matchProvider returns. parser == nil for a
// custom Shopify domain (signals "use the generic product-JSON parser").
type provider struct {
	id         string
	label      string
	hostSuffix string
	kind       providerKind
	parseHTML  func(html string) map[string]any
	parseJSON  func(product map[string]any) map[string]any
	builtin    bool
}

// builtinProviders is the built-in registry; the order is significant for
// matching.
var builtinProviders = []provider{
	{id: "kaffeebraun", label: "Kaffee Braun", hostSuffix: "kaffeebraun.com", kind: kindHTML, parseHTML: parseKaffeebraun, builtin: true},
	{id: "hoppenworth-ploch", label: "Hoppenworth & Ploch", hostSuffix: "hoppenworth-ploch.de", kind: kindShopify, parseJSON: parseHoploProduct, builtin: true},
	{id: "elbgold", label: "elbgold", hostSuffix: "elbgold.com", kind: kindShopify, parseJSON: parseElbgoldProduct, builtin: true},
}

func hostMatches(host, suffix string) bool {
	return host == suffix || strings.HasSuffix(host, "."+suffix)
}

// matchProvider resolves host (already lowercased with a leading "www."
// stripped) against the enabled built-ins, then customDomains.
func matchProvider(host string, disabled map[string]bool, customDomains []string) *provider {
	for i := range builtinProviders {
		p := &builtinProviders[i]
		if disabled[p.id] {
			continue
		}
		if hostMatches(host, p.hostSuffix) {
			return p
		}
	}
	for _, d := range customDomains {
		if hostMatches(host, d) {
			return &provider{
				id:         "custom:" + d,
				label:      d,
				hostSuffix: d,
				kind:       kindShopify,
				parseJSON:  nil,
				builtin:    false,
			}
		}
	}
	return nil
}
