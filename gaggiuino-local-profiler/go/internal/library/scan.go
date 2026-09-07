package library

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"regexp"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
)

// This file ports routes/library/scan.js: a server-side proxy to Open Food
// Facts (the browser can't call it directly — server.js's CSP pins
// connect-src to 'self'), guarded by the same SSRF check
// (assertPublicHost, ssrf.go) the Node original applies before ever
// dialing out, even though the target host is a fixed literal (DNS
// rebinding defense, not user-input validation — see ssrf.go's doc
// comment).

const offHost = "world.openfoodfacts.org"

// offBaseURL is a package var (not a literal at the call site) purely so
// tests can point it at an httptest.Server instead of the real Open Food
// Facts API — offHost above (what assertPublicHost actually resolves and
// checks) stays the real hostname either way, so a test can still exercise
// the genuine SSRF-guard code path end-to-end via lookupIPAddr (ssrf.go).
var offBaseURL = "https://" + offHost

var barcodeRe = regexp.MustCompile(`^(\d{8}|\d{12}|\d{13}|\d{14})$`)

// scanFetchMaxBytes mirrors lib/constants.js's SCAN_FETCH_MAX_BYTES.
const scanFetchMaxBytes = 1 * 1024 * 1024

var scanHTTPClient = &http.Client{
	Timeout: 8 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse // maxRedirects: 0
	},
}

func (h *Handlers) registerScanRoute(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/library/scan/{barcode}", h.scanBarcode)
}

// scanBarcode ports GET /api/library/scan/:barcode.
func (h *Handlers) scanBarcode(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !h.limiter.allow("scan:"+auth.RemoteIP(r), 20) {
		writeError(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	barcode := r.PathValue("barcode")
	// scanBarcodeSchema (lib/validation/schemas.js) runs as request-level
	// middleware in Node, ahead of the handler; ported inline here since
	// this package has no equivalent middleware chain — same 400 shape
	// (Validation failed / issues[]) as validate() would have produced.
	if !barcodeRe.MatchString(barcode) {
		writeJSON(w, http.StatusBadRequest, Entity{
			"error": "Validation failed",
			"issues": []Entity{{
				"path": "barcode", "message": "expected an 8, 12, 13 or 14-digit barcode",
			}},
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	if err := assertPublicHost(ctx, offHost); err != nil {
		if isSSRFBlocked(err) {
			log.Printf("Barcode scan lookup blocked for %s: %v", barcode, err)
		} else {
			log.Printf("Barcode scan lookup failed for %s: %v", barcode, err)
		}
		writeError(w, http.StatusBadGateway, "lookup_failed")
		return
	}

	url := offBaseURL + "/api/v3/product/" + barcode + ".json"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, "lookup_failed")
		return
	}
	req.Header.Set("User-Agent", "GLP/1.0 (Gaggiuino Local Profiler; private use)")
	resp, err := scanHTTPClient.Do(req)
	if err != nil {
		log.Printf("Barcode scan lookup failed for %s: %v", barcode, err)
		writeError(w, http.StatusBadGateway, "lookup_failed")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 500 {
		log.Printf("Barcode scan lookup failed for %s: upstream status %d", barcode, resp.StatusCode)
		writeError(w, http.StatusBadGateway, "lookup_failed")
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, scanFetchMaxBytes+1))
	if err != nil || len(body) > scanFetchMaxBytes {
		log.Printf("Barcode scan lookup failed for %s: reading response", barcode)
		writeError(w, http.StatusBadGateway, "lookup_failed")
		return
	}

	var payload struct {
		Product *struct {
			ProductName   string `json:"product_name"`
			ProductNameDE string `json:"product_name_de"`
			ProductNameEN string `json:"product_name_en"`
			Brands        string `json:"brands"`
			Labels        string `json:"labels"`
			CategoryTags  []any  `json:"categories_tags"`
		} `json:"product"`
	}
	if len(body) > 0 {
		_ = json.Unmarshal(body, &payload) // malformed/empty body -> nil product, same "not_found" branch as Node's r.data?.product being undefined
	}

	if resp.StatusCode == http.StatusNotFound || payload.Product == nil {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	p := payload.Product
	name := p.ProductName
	if name == "" {
		name = p.ProductNameDE
	}
	if name == "" {
		name = p.ProductNameEN
	}
	roaster := p.Brands
	category := ""
	for _, ct := range p.CategoryTags {
		s, ok := ct.(string)
		if ok && len(s) > 3 && s[:3] == "en:" {
			category = s[3:]
			break
		}
	}
	notesParts := []string{}
	if category != "" {
		notesParts = append(notesParts, category)
	}
	if p.Labels != "" {
		notesParts = append(notesParts, p.Labels)
	}
	notes := joinComma(notesParts)

	if name == "" && roaster == "" {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	writeJSON(w, http.StatusOK, Entity{"name": name, "roaster": roaster, "notes": notes})
}

func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ", "
		}
		out += p
	}
	return out
}
