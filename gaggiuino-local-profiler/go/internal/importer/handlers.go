package importer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"reflect"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/config"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// This file implements GET /api/import/url, POST /api/import/paste plus
// GET/POST /api/import/settings.

const (
	codeShopRateLimited = "shop_rate_limited"
	// maxPasteBytes bounds the pasted product text; the largest real product
	// fixture in testdata is 28 KB.
	maxPasteBytes = 1 << 20
	// maxPasteBody bounds the JSON envelope: string escaping grows the text,
	// so the body cap sits above the text cap.
	maxPasteBody = 2*maxPasteBytes + 4096

	pasteUnavailableMessage = "product data import is not available for this address"
)

// shopBlockedError reports that a shop answered HTTP 429. productDataURL is the
// product-JSON URL this package rebuilt itself, never anything taken from the
// upstream body, and is set only when that JSON endpoint itself was refused.
type shopBlockedError struct{ productDataURL string }

func (e *shopBlockedError) Error() string {
	return "the shop does not allow automatic requests right now"
}

// Handlers is the import API router.
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
	mux.HandleFunc("POST /api/import/paste", h.importPaste)
	mux.HandleFunc("GET /api/import/settings", h.getSettings)
	mux.HandleFunc("POST /api/import/settings", h.postSettings)
}

// The User-Agent, timeout and size cap all live on the *fetcher.

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

// disabledProviderSet turns the stored settings into the lookup
// matchProvider takes, shared by the fetch and paste routes so both dispatch a
// host identically.
func disabledProviderSet(s Settings) map[string]bool {
	disabled := map[string]bool{}
	for _, id := range s.DisabledProviders {
		disabled[id] = true
	}
	return disabled
}

// parseImportURL applies the three URL checks GET /api/import/url answers with
// a 400. The returned string is the message, "" when the URL is usable.
func parseImportURL(raw string) (*url.URL, string) {
	if raw == "" {
		return nil, "url required"
	}
	parsed, err := url.Parse(raw)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" {
		return nil, "invalid url"
	}
	if parsed.Scheme != "https" {
		return nil, "unsupported protocol"
	}
	return parsed, ""
}

func (h *Handlers) importURL(w http.ResponseWriter, r *http.Request) {
	// #486: an import must always hit the network fresh — no-store even on a
	// 400.
	w.Header().Set("Cache-Control", "no-store")

	raw := r.URL.Query().Get("url")
	parsed, msg := parseImportURL(raw)
	if msg != "" {
		httputil.WriteError(w, http.StatusBadRequest, msg)
		return
	}

	settings := h.repo.GetSettings()
	host := hostForImport(parsed)
	prov := matchProvider(host, disabledProviderSet(settings), settings.CustomShopifyDomains)

	wantsDebug := r.URL.Query().Get("debug") == "1"
	var debugInfo map[string]any
	if wantsDebug {
		debugInfo = map[string]any{}
	}

	bean, method, productDataURL, err := h.resolve(r.Context(), parsed, raw, host, prov, debugInfo)
	if err != nil {
		if isSSRFBlocked(err) {
			httputil.WriteError(w, http.StatusBadRequest, "blocked address")
			return
		}
		var blocked *shopBlockedError
		if errors.As(err, &blocked) {
			// 502, not 429: the shop refused, GLP did not rate limit.
			body := map[string]any{
				"error": "The shop does not allow automatic requests right now",
				"code":  codeShopRateLimited,
			}
			if blocked.productDataURL != "" {
				body["productDataUrl"] = blocked.productDataURL
			}
			httputil.WriteJSON(w, http.StatusBadGateway, body)
			return
		}
		httputil.WriteError(w, http.StatusInternalServerError, "fetch failed")
		return
	}
	if bean == nil {
		httputil.WriteError(w, http.StatusNotFound, "product not found on page")
		return
	}

	h.writeImportedBean(w, bean, method, raw, productDataURL, debugInfo)
}

// importPaste answers POST /api/import/paste: it runs the same parsers as a
// fetch, selected by the host of the supplied url, over product data the user
// pasted. Nothing is stored and the text is never echoed or logged.
func (h *Handlers) importPaste(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	body, ok := httputil.DecodeJSONBody[map[string]any](w, r, maxPasteBody)
	if !ok {
		return
	}
	raw, _ := body["url"].(string)
	parsed, msg := parseImportURL(raw)
	if msg != "" {
		httputil.WriteError(w, http.StatusBadRequest, msg)
		return
	}
	text, _ := body["text"].(string)
	if len(text) > maxPasteBytes {
		httputil.WriteError(w, http.StatusRequestEntityTooLarge, "request entity too large")
		return
	}

	settings := h.repo.GetSettings()
	host := hostForImport(parsed)
	prov := matchProvider(host, disabledProviderSet(settings), settings.CustomShopifyDomains)
	if (prov != nil && prov.kind != kindShopify) || shopifyJSONURL(parsed.Path, host) == "" {
		httputil.WriteError(w, http.StatusBadRequest, pasteUnavailableMessage)
		return
	}

	product, ok := parsePastedProduct(text)
	if !ok {
		httputil.WriteError(w, http.StatusBadRequest, "invalid product data")
		return
	}

	bean, method, err := h.beanFromProduct(r.Context(), product, prov, host, raw, nil)
	if err != nil {
		if isSSRFBlocked(err) {
			httputil.WriteError(w, http.StatusBadRequest, "blocked address")
			return
		}
		httputil.WriteError(w, http.StatusInternalServerError, "fetch failed")
		return
	}
	if bean == nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid product data")
		return
	}

	h.writeImportedBean(w, bean, method, raw, "", nil)
}

// parsePastedProduct decodes exactly one JSON object and nothing else. The
// text is untrusted: a non-object, trailing content or a missing title is
// rejected without ever being echoed.
func parsePastedProduct(text string) (map[string]any, bool) {
	dec := json.NewDecoder(strings.NewReader(jsTrim(text)))
	var product map[string]any
	if err := dec.Decode(&product); err != nil || product == nil {
		return nil, false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, false // anything after the object
	}
	return product, true
}

// writeImportedBean stamps the import-specific fields onto bean and writes it.
func (h *Handlers) writeImportedBean(w http.ResponseWriter, bean map[string]any, method, raw, productDataURL string, debugInfo map[string]any) {
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

	if productDataURL != "" {
		bean["productDataUrl"] = productDataURL
	}
	if debugInfo != nil {
		bean["_debug"] = debugInfo
	}
	httputil.WriteJSON(w, http.StatusOK, bean)
}

// beanFromProduct runs the parser the host selected (prov == nil: generic), then
// the HTML enrichment the generic and custom paths get. A nil bean means the
// product has no title.
func (h *Handlers) beanFromProduct(ctx context.Context, product map[string]any, prov *provider, host, raw string, debugInfo map[string]any) (map[string]any, string, error) {
	var bean map[string]any
	method := ""
	if prov != nil && prov.parseJSON != nil {
		bean = prov.parseJSON(product)
	} else {
		bean = parseGenericShopifyProduct(product, host)
	}
	if bean == nil {
		return nil, "", nil
	}
	attachVariants(bean, product)
	switch {
	case prov == nil:
		bean["source"] = host
		method = "generic-shopify"
	case prov.builtin:
		bean["source"] = prov.hostSuffix
		method = "builtin:" + prov.id
	default:
		bean["source"] = host
		method = "custom-shopify"
	}
	// #492: a custom Shopify domain (no bespoke parser) gets the same HTML
	// enrichment the automatic generic path does.
	if prov == nil || prov.parseJSON == nil {
		enriched, err := h.tryHTMLEnrich(ctx, bean, host, raw, debugInfo)
		if err != nil {
			return nil, "", err
		}
		bean = enriched
	}
	return bean, method, nil
}

// resolve runs the numbered fallback chain that produces a bean. The last
// result is the product-JSON URL when that endpoint answered 429 while the page
// still gave data ("" otherwise).
func (h *Handlers) resolve(ctx context.Context, parsed *url.URL, raw, host string, prov *provider, debugInfo map[string]any) (map[string]any, string, string, error) {
	var bean map[string]any
	method := ""
	var pageHTML *string
	// blockedURL remembers a 429 from the generic product-JSON endpoint: the
	// chain keeps going, because the page can still carry JSON-LD or OpenGraph.
	blockedURL := ""

	// 1. Registry match.
	if prov != nil {
		if prov.kind == kindShopify {
			jsonURL := shopifyJSONURL(parsed.Path, host)
			if jsonURL != "" {
				res, err := h.fetch.safeGet(ctx, jsonURL)
				if err != nil {
					if isRateLimited(err) {
						return nil, "", "", &shopBlockedError{productDataURL: jsonURL}
					}
					return nil, "", "", err
				}
				bean, method, err = h.beanFromProduct(ctx, res.dataObject(), prov, host, raw, debugInfo)
				if err != nil {
					return nil, "", "", err
				}
			}
		} else {
			res, err := h.fetch.safeGet(ctx, raw)
			if err != nil {
				if isRateLimited(err) {
					return nil, "", "", &shopBlockedError{}
				}
				return nil, "", "", err
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
			config.DebugLogf("Import: generic-Shopify path for %s, jsonUrl=%s", host, jsonURL)
			res, err := h.fetch.safeGet(ctx, jsonURL)
			if err != nil {
				config.DebugLogf("Import: JSON fetch failed for %s: %v", host, err)
				if isSSRFBlocked(err) {
					return nil, "", "", err
				}
				if isRateLimited(err) {
					blockedURL = jsonURL
				}
				if debugInfo != nil {
					debugInfo["jsonFetchError"] = err.Error()
				}
			} else {
				config.DebugLogf("Import: JSON fetch %s -> status %d, %d bytes", jsonURL, res.status, len(res.body))
				bean, method, err = h.beanFromProduct(ctx, res.dataObject(), nil, host, raw, debugInfo)
				if err != nil {
					return nil, "", "", err
				}
				if bean == nil {
					config.DebugLogf("Import: parseGenericShopifyProduct returned nil (no title in JSON)")
				}
			}
		}
	}

	// 3. JSON-LD, 4. OpenGraph — one page fetch shared.
	if bean == nil {
		res, err := h.fetch.safeGet(ctx, raw)
		if err != nil {
			if isSSRFBlocked(err) {
				return nil, "", "", err
			}
			if blockedURL != "" {
				return nil, "", "", &shopBlockedError{productDataURL: blockedURL}
			}
			if isRateLimited(err) {
				return nil, "", "", &shopBlockedError{}
			}
			return nil, "", "", err
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

	if bean == nil {
		if blockedURL != "" {
			return nil, "", "", &shopBlockedError{productDataURL: blockedURL}
		}
		return nil, "", "", nil
	}
	return bean, method, blockedURL, nil
}

func (h *Handlers) tryHTMLEnrich(ctx context.Context, bean map[string]any, host, raw string, debugInfo map[string]any) (map[string]any, error) {
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
	config.DebugLogf("Import: HTML fetch %s -> status %d, %d chars", raw, res.status, len([]rune(htmlStr)))
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
	// #977 follow-up code review (round 4): global debug_logging enabling
	// this field-diff (not just an explicit `?debug=1`'s debugInfo != nil)
	// is deliberate, not an accidental widening -- it matches every other
	// config.DebugLogf call already unconditional-when-globally-enabled
	// in this same function (HTML-fetch/JSON-fetch traces
	// above and in resolve()), which likewise fire regardless of a per-request
	// flag. The reflect.DeepEqual loop itself stays cheap in practice: a
	// bean object is a few dozen scalar/short-slice fields at most, and
	// every call here already did a full HTTP HTML fetch immediately
	// above, which dominates cost by orders of magnitude over that diff.
	var changed []string
	if debugInfo != nil || config.IsDebugLoggingEnabled() {
		for k, v := range enriched {
			if !reflect.DeepEqual(v, before[k]) {
				changed = append(changed, k)
			}
		}
		changedSummary := "(none)"
		if len(changed) > 0 {
			changedSummary = strings.Join(changed, ", ")
		}
		config.DebugLogf("Import: HTML enrichment changed fields: %s", changedSummary)
	}
	if debugInfo != nil {
		debugInfo["enrichedFieldsChanged"] = changed
	}
	return enriched, nil
}

// ── size-variant projection ────────────────────────────────────────────

func attachVariants(bean map[string]any, product map[string]any) {
	if product == nil {
		return
	}
	variants := distinctSizeVariants(marr(product, "variants"))
	if len(variants) > 1 {
		bean["variants"] = variants
	}
}

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
