package importer

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"reflect"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// This file ports routes/import.js: GET /api/import/url plus GET/POST
// /api/import/settings.

// Handlers ports routes/import.js's router.
type Handlers struct {
	repo  *Repository
	fetch *fetcher
	// beans returns the current library beans (loadLibrary().beans) for the
	// duplicate-warning check — a func dependency, not a library import, the
	// same callback style cmd/server uses for library.GeocodeHook.
	beans func() []map[string]any
}

// NewHandlers wires the import-settings repo and the library-beans lookup.
func NewHandlers(repo *Repository, beans func() []map[string]any) *Handlers {
	if beans == nil {
		beans = func() []map[string]any { return nil }
	}
	return &Handlers{repo: repo, fetch: newFetcher(), beans: beans}
}

func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/import/url", h.importURL)
	mux.HandleFunc("GET /api/import/settings", h.getSettings)
	mux.HandleFunc("POST /api/import/settings", h.postSettings)
}

// FETCH_OPTS's User-Agent/timeout/size cap all live on the *fetcher.

// getSettings ports GET /api/import/settings.
func (h *Handlers) getSettings(w http.ResponseWriter, _ *http.Request) {
	s := h.repo.GetSettings()
	disabled := map[string]bool{}
	for _, id := range s.DisabledProviders {
		disabled[id] = true
	}
	providers := make([]map[string]any, 0, len(builtinProviders))
	for _, p := range builtinProviders {
		providers = append(providers, map[string]any{
			"id":         p.id,
			"label":      p.label,
			"hostSuffix": p.hostSuffix,
			"enabled":    !disabled[p.id],
		})
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]any{
		"providers":            providers,
		"customShopifyDomains": s.CustomShopifyDomains,
	})
}

// postSettings ports POST /api/import/settings.
func (h *Handlers) postSettings(w http.ResponseWriter, r *http.Request) {
	body, ok := httputil.DecodeJSONBody[map[string]any](w, r, 1<<20)
	if !ok {
		return
	}
	s := h.repo.GetSettings()

	if arr, ok := body["disabledProviders"].([]any); ok {
		valid := map[string]bool{}
		for _, p := range builtinProviders {
			valid[p.id] = true
		}
		out := []string{}
		for _, v := range arr {
			if id, ok := v.(string); ok && valid[id] {
				out = append(out, id)
			}
		}
		s.DisabledProviders = out
	}

	if arr, ok := body["customShopifyDomains"].([]any); ok {
		seen := map[string]bool{}
		out := []string{}
		for _, v := range arr {
			d, ok := v.(string)
			if !ok {
				continue
			}
			host := normalizeCustomDomain(d)
			if host == "" || seen[host] {
				continue
			}
			seen[host] = true
			out = append(out, host)
		}
		if len(out) > 20 {
			out = out[:20]
		}
		s.CustomShopifyDomains = out
	}

	if err := h.repo.SaveSettings(s); err != nil {
		httputil.InternalError(w, "importer", err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, s)
}

func (h *Handlers) importURL(w http.ResponseWriter, r *http.Request) {
	// #486: an import must always hit the network fresh — no-store even on a
	// 400.
	w.Header().Set("Cache-Control", "no-store")

	raw := r.URL.Query().Get("url")
	if raw == "" {
		httputil.WriteError(w, http.StatusBadRequest, "url required")
		return
	}
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" {
		httputil.WriteError(w, http.StatusBadRequest, "invalid url")
		return
	}
	if parsed.Scheme != "https" {
		httputil.WriteError(w, http.StatusBadRequest, "unsupported protocol")
		return
	}

	settings := h.repo.GetSettings()
	disabled := map[string]bool{}
	for _, id := range settings.DisabledProviders {
		disabled[id] = true
	}
	host := hostForImport(parsed)
	prov := matchProvider(host, disabled, settings.CustomShopifyDomains)

	wantsDebug := r.URL.Query().Get("debug") == "1"
	var debugInfo map[string]any
	if wantsDebug {
		debugInfo = map[string]any{}
	}

	bean, method, err := h.resolve(r.Context(), parsed, raw, host, prov, debugInfo)
	if err != nil {
		if isSSRFBlocked(err) {
			httputil.WriteError(w, http.StatusBadRequest, "blocked address")
			return
		}
		httputil.WriteError(w, http.StatusInternalServerError, "fetch failed")
		return
	}
	if bean == nil {
		httputil.WriteError(w, http.StatusNotFound, "product not found on page")
		return
	}

	bean["importMethod"] = method
	bean["sourceUrl"] = raw
	// #451: stamp sourceUrl onto extraBrewRecipes candidates.
	if recipes, ok := bean["extraBrewRecipes"].([]map[string]any); ok {
		for _, rec := range recipes {
			rec["sourceUrl"] = raw
		}
	}

	if dup := findDuplicateBean(strOr(bean["name"]), strOr(bean["roaster"]), raw, h.beans()); dup != nil {
		bean["duplicateWarning"] = map[string]any{
			"id":      dup["id"],
			"name":    dup["name"],
			"roaster": strOrDefault(dup["roaster"], ""),
		}
	}

	if debugInfo != nil {
		bean["_debug"] = debugInfo
	}
	httputil.WriteJSON(w, http.StatusOK, bean)
}

// resolve ports the numbered fallback chain inside routes/import.js's try block.
func (h *Handlers) resolve(ctx context.Context, parsed *url.URL, raw, host string, prov *provider, debugInfo map[string]any) (map[string]any, string, error) {
	var bean map[string]any
	method := ""
	var pageHTML *string

	// 1. Registry match.
	if prov != nil {
		if prov.kind == kindShopify {
			jsonURL := shopifyJSONURL(parsed.Path, host)
			if jsonURL != "" {
				res, err := h.fetch.safeGet(ctx, jsonURL)
				if err != nil {
					return nil, "", err
				}
				product := res.dataObject()
				if prov.parseJSON != nil {
					bean = prov.parseJSON(product)
				} else {
					bean = parseGenericShopifyProduct(product, host)
				}
				if bean != nil {
					attachVariants(bean, product)
					if prov.builtin {
						bean["source"] = prov.hostSuffix
						method = "builtin:" + prov.id
					} else {
						bean["source"] = host
						method = "custom-shopify"
					}
					// #492: a custom Shopify domain (no bespoke parser) gets
					// the same HTML enrichment the automatic generic path does.
					if prov.parseJSON == nil {
						bean, err = h.tryHTMLEnrich(ctx, bean, host, raw, debugInfo)
						if err != nil {
							return nil, "", err
						}
					}
				}
			}
		} else {
			res, err := h.fetch.safeGet(ctx, raw)
			if err != nil {
				return nil, "", err
			}
			bean = prov.parseHTML(res.dataString())
			if bean != nil {
				bean["source"] = prov.hostSuffix
				method = "builtin:" + prov.id
			}
		}
	}

	// 2. Generic Shopify attempt.
	if bean == nil {
		jsonURL := shopifyJSONURL(parsed.Path, host)
		if jsonURL != "" {
			res, err := h.fetch.safeGet(ctx, jsonURL)
			if err != nil {
				if isSSRFBlocked(err) {
					return nil, "", err
				}
				if debugInfo != nil {
					debugInfo["jsonFetchError"] = err.Error()
				}
			} else {
				product := res.dataObject()
				bean = parseGenericShopifyProduct(product, host)
				if bean != nil {
					attachVariants(bean, product)
					bean["source"] = host
					method = "generic-shopify"
					bean, err = h.tryHTMLEnrich(ctx, bean, host, raw, debugInfo)
					if err != nil {
						return nil, "", err
					}
				}
			}
		}
	}

	// 3. JSON-LD, 4. OpenGraph — one page fetch shared.
	if bean == nil {
		res, err := h.fetch.safeGet(ctx, raw)
		if err != nil {
			return nil, "", err
		}
		s := res.dataString()
		pageHTML = &s
		bean = parseJSONLd(s)
		if bean != nil {
			bean["source"] = host
			method = "jsonld"
		}
	}
	if bean == nil && pageHTML != nil {
		bean = parseOpenGraph(*pageHTML)
		if bean != nil {
			bean["source"] = host
			method = "opengraph"
		}
	}

	return bean, method, nil
}

// tryHTMLEnrich ports routes/import.js's tryHtmlEnrich.
func (h *Handlers) tryHTMLEnrich(ctx context.Context, bean map[string]any, host, raw string, debugInfo map[string]any) (map[string]any, error) {
	enrich := needsHTMLEnrich(bean, host)
	if debugInfo != nil {
		debugInfo["needsHtmlEnrich"] = enrich
	}
	if !enrich {
		return bean, nil
	}
	res, err := h.fetch.safeGet(ctx, raw)
	if err != nil {
		if isSSRFBlocked(err) {
			return nil, err
		}
		// #480: keep the bean as-is, log why.
		log.Printf("Import: HTML enrichment fetch failed for %s: %v", host, err)
		if debugInfo != nil {
			debugInfo["htmlFetchError"] = err.Error()
		}
		return bean, nil
	}
	htmlStr := res.dataString()
	if debugInfo != nil {
		debugInfo["htmlFetchStatus"] = res.status
		debugInfo["htmlLength"] = len([]rune(htmlStr))
		debugInfo["hasOriginWrapper"] = strings.Contains(htmlStr, "origin-wrapper")
		debugInfo["hasOriginTitle"] = strings.Contains(htmlStr, "origin-title")
		debugInfo["hasDetailsAccordion"] = strings.Contains(htmlStr, "details-content")
		debugInfo["htmlSnippet"] = sliceRunes(htmlStr, 500)
	}
	before := cloneBean(bean)
	enriched := enrichGenericBeanFromHTML(bean, htmlStr, host)
	if debugInfo != nil {
		var changed []string
		for k, v := range enriched {
			if !reflect.DeepEqual(v, before[k]) {
				changed = append(changed, k)
			}
		}
		debugInfo["enrichedFieldsChanged"] = changed
	}
	return enriched, nil
}

// htmlEnrichFields ports HTML_ENRICH_FIELDS.
var htmlEnrichFields = []string{"process", "variety", "producer", "region", "altitude_m", "roastType"}

// needsHTMLEnrich ports routes/import.js's needsHtmlEnrich(bean, host).
func needsHTMLEnrich(bean map[string]any, host string) bool {
	for _, f := range htmlEnrichFields {
		if beanEmpty(bean, f) {
			return true
		}
	}
	roaster, _ := bean["roaster"].(string)
	return bean["roaster"] == nil || roaster == "" || (host != "" && strings.EqualFold(roaster, host))
}

// ── size-variant projection ────────────────────────────────────────────

// attachVariants ports routes/import.js's attachVariants.
func attachVariants(bean map[string]any, product map[string]any) {
	if product == nil {
		return
	}
	variants := distinctSizeVariants(marr(product, "variants"))
	if len(variants) > 1 {
		bean["variants"] = variants
	}
}

// distinctSizeVariants ports routes/import.js's distinctSizeVariants.
func distinctSizeVariants(rawVariants []any) []map[string]any {
	seen := map[string]bool{}
	var out []map[string]any
	for _, rv := range rawVariants {
		v, ok := rv.(map[string]any)
		if !ok {
			continue
		}
		price, ok := mnum(v, "price")
		if !ok {
			continue
		}
		var label string
		for _, key := range []string{"option1", "option2", "option3", "title"} {
			if s := mstr(v, key); parseGramsFromLabel(s) != nil {
				label = s
				break
			}
		}
		var weight *int
		if label != "" {
			weight = parseGramsFromLabel(label)
		} else if w, ok := mnum(v, "weight"); ok {
			iw := int(w)
			weight = &iw
		}
		if weight == nil {
			continue
		}
		key := formatFloat(price) + "|" + itoa(*weight)
		if seen[key] {
			continue
		}
		seen[key] = true
		title := firstNonEmpty(mstr(v, "option1"), mstr(v, "title"))
		var unit any
		if upm := mobj(v, "unit_price_measurement"); upm != nil {
			if qu, ok := upm["quantity_unit"].(string); ok && qu != "" {
				unit = qu
			}
		}
		out = append(out, map[string]any{
			"id":     v["id"],
			"title":  strOrNilAny(title),
			"price":  price,
			"weight": *weight,
			"unit":   unit,
		})
	}
	return out
}

var gramsLabelRe = mustCompileGrams()

func parseGramsFromLabel(s string) *int {
	if s == "" {
		return nil
	}
	m := gramsLabelRe.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	n := parseFloatComma(m[1])
	if n == nil {
		return nil
	}
	v := *n
	if strings.HasPrefix(strings.ToLower(m[2]), "k") {
		v *= 1000
	}
	iv := int(roundHalfUp(v))
	return &iv
}
