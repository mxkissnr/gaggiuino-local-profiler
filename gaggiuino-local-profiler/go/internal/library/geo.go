package library

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// This file ports lib/geo.js + lib/services/LibraryService.js's geocodeBean
// (Phase 2g, #901): resolve a bean's growing region ("region, country") to
// lat/lon for the origin map, cached in the kv table so each distinct query
// hits Nominatim at most once. Fire-and-forget after a bean create/update —
// GeocodeHook below is what cmd/server wires createBean/UpdateBean's
// un-awaited call to, mirroring routes/library/beans.js's
// `libraryService.geocodeBean(id).catch(() => {})`.
//
// The outbound request goes through assertPublicHost (ssrf.go) exactly like
// scan.go's Open Food Facts call: nominatimHost is a fixed literal, not user
// input, but a rebound DNS answer for it could still point at an internal
// address, so every resolved address is checked before the request runs.

const (
	nominatimHost = "nominatim.openstreetmap.org"
	nominatimURL  = "https://" + nominatimHost + "/search"
	// Nominatim usage policy: identify the app, max 1 request/second.
	geoMinIntervalMS = 1100
	geoCacheKey      = "geocode_cache"
	geoCacheMax      = 500
	// Keep in sync with lib/constants.js's GLP_VERSION by hand (same
	// convention as internal/system/version.go's glpVersion) — Nominatim
	// only needs a stable identifying User-Agent, not an exact value.
	geoUserAgent = "GLP/2.35.0 (https://github.com/mxkissnr/gaggiuino-local-profiler)"
)

// Location mirrors lib/geo.js's { lat, lon, label } result shape — the
// object stored on bean.location and read by the origin-map view.
type Location struct {
	Lat   float64 `json:"lat"`
	Lon   float64 `json:"lon"`
	Label string  `json:"label"`
}

// geoCacheEntry mirrors lib/geo.js's `{ result, ts }` cache value: result
// is null for a cached miss (Node caches misses too, so a region Nominatim
// can't resolve is never re-queried).
type geoCacheEntry struct {
	Result *Location `json:"result"`
	TS     int64     `json:"ts"`
}

// Geocoder ports lib/geo.js's module-level state (the request-serialization
// queue + last-request timestamp) as a struct so cmd/server owns one
// instance, the same pattern internal/system's Poller / ha.Client use
// instead of Node's module singletons.
type Geocoder struct {
	repo   *Repository
	http   *http.Client
	apiURL string // overridable in tests

	mu          sync.Mutex // serializes requests + guards lastRequestAt
	lastRequest time.Time

	// assertHost is the SSRF check, a field so tests can bypass a real DNS
	// round trip against a fake Nominatim on 127.0.0.1.
	assertHost func(ctx context.Context, host string) error
}

// NewGeocoder wires the library Repository (kv-table cache access) into a
// Geocoder pointed at the real Nominatim endpoint.
func NewGeocoder(repo *Repository) *Geocoder {
	return &Geocoder{
		repo:       repo,
		http:       &http.Client{Timeout: 8 * time.Second},
		apiURL:     nominatimURL,
		assertHost: assertPublicHost,
	}
}

// GeocodeHook, when set by cmd/server at startup, is invoked
// fire-and-forget (in a goroutine) after a bean create or a region-changing
// bean update whose region is non-empty — the Go port of
// routes/library/beans.js's `libraryService.geocodeBean(id).catch(() =>
// {})`. nil (the default, and in every test that doesn't set it) makes the
// call a no-op, matching the pre-2g Go behavior doc.go documented as
// deferred.
var GeocodeHook func(beanID int64, region, origin string)

// maybeGeocode is the single call site create.go/update.go use so the
// nil-guard + goroutine + region-non-empty rule live in one place.
func maybeGeocode(beanID int64, region, origin string) {
	if GeocodeHook != nil && strings.TrimSpace(region) != "" {
		httputil.SafeGo("library: geocode bean", func() { GeocodeHook(beanID, region, origin) })
	}
}

// GeocodeBean ports LibraryService.js's geocodeBean(beanId): look the bean
// up, resolve its region (with the origin country name appended for
// precision), then write the result back onto a FRESH library read — the
// bean may have been edited or deleted while the request was in flight, so
// a region that no longer matches is discarded, exactly like the Node
// original's re-read guard.
func (g *Geocoder) GeocodeBean(ctx context.Context, beanID int64) {
	lib, err := g.repo.GetLibrary()
	if err != nil {
		log.Printf("library: geocodeBean: reading library for bean %d: %v", beanID, err)
		return
	}
	idx := findBeanIndex(lib, beanID)
	if idx == -1 {
		return
	}
	bean := lib.Beans[idx]
	region, _ := bean["region"].(string)
	if strings.TrimSpace(region) == "" {
		return
	}
	origin, _ := bean["origin"].(string)
	countryName := countryNameForCode(origin)

	loc, err := g.GeocodeRegion(ctx, region, countryName)
	if err != nil {
		log.Printf("library: geocodeBean: geocoding %q for bean %d: %v", region, beanID, err)
		return
	}

	fresh, err := g.repo.GetLibrary()
	if err != nil {
		log.Printf("library: geocodeBean: reloading library for bean %d: %v", beanID, err)
		return
	}
	fi := findBeanIndex(fresh, beanID)
	if fi == -1 {
		return
	}
	if cur, _ := fresh.Beans[fi]["region"].(string); cur != region {
		return // region changed under us — a newer geocode call owns it now
	}
	if loc != nil {
		fresh.Beans[fi]["location"] = loc
	} else {
		fresh.Beans[fi]["location"] = nil
	}
	if err := g.repo.SaveLibrary(fresh); err != nil {
		log.Printf("library: geocodeBean: saving library for bean %d: %v", beanID, err)
		return
	}
	if loc != nil {
		name, _ := fresh.Beans[fi]["name"].(string)
		log.Printf("library: geocoded bean %q region %q -> %g,%g", name, region, loc.Lat, loc.Lon)
	}
}

// GeocodeRegion ports lib/geo.js's geocodeRegion(region, countryName):
// returns the cached result (including a cached nil for a known miss) when
// the lower-cased "region, country" query is already in the kv cache,
// otherwise makes one rate-limited, SSRF-guarded Nominatim call and caches
// whatever it produced.
func (g *Geocoder) GeocodeRegion(ctx context.Context, region, countryName string) (*Location, error) {
	region = strings.TrimSpace(region)
	if region == "" {
		return nil, nil
	}
	parts := []string{region}
	if strings.TrimSpace(countryName) != "" {
		parts = append(parts, strings.TrimSpace(countryName))
	}
	query := strings.Join(parts, ", ")
	key := strings.ToLower(query)

	cache := g.loadCache()
	if entry, ok := cache[key]; ok {
		return entry.Result, nil
	}

	result, reqErr := g.request(ctx, query, region)

	// Re-load: another request may have written meanwhile (matches Node's
	// "re-load: another request may have written meanwhile" comment).
	fresh := g.loadCache()
	fresh[key] = geoCacheEntry{Result: result, TS: time.Now().UnixMilli()}
	g.saveCache(fresh)
	return result, reqErr
}

// request performs one Nominatim call, serialized with >= geoMinIntervalMS
// between calls (lib/geo.js's enqueue()), and SSRF-guarded. A network/parse
// failure is logged and returns (nil, nil) — a miss, cached like any other,
// exactly as the Node original swallows its own axios error into `return
// null`.
func (g *Geocoder) request(ctx context.Context, query, region string) (*Location, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if wait := time.Until(g.lastRequest.Add(geoMinIntervalMS * time.Millisecond)); wait > 0 {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	g.lastRequest = time.Now()

	if err := g.assertHost(ctx, nominatimHost); err != nil {
		if isSSRFBlocked(err) {
			log.Printf("library: geocode blocked by SSRF guard: %v", err)
			return nil, nil
		}
		log.Printf("library: geocode host check failed for %q: %v", query, err)
		return nil, nil
	}

	u, _ := url.Parse(g.apiURL)
	q := u.Query()
	q.Set("format", "jsonv2")
	q.Set("limit", "1")
	q.Set("q", query)
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, nil
	}
	req.Header.Set("User-Agent", geoUserAgent)

	resp, err := g.http.Do(req)
	if err != nil {
		log.Printf("library: geocode failed for %q: %v", query, err)
		return nil, nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("library: geocode failed for %q: HTTP %d", query, resp.StatusCode)
		return nil, nil
	}

	var hits []struct {
		Lat string `json:"lat"`
		Lon string `json:"lon"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&hits); err != nil {
		log.Printf("library: geocode failed for %q: %v", query, err)
		return nil, nil
	}
	if len(hits) == 0 || hits[0].Lat == "" || hits[0].Lon == "" {
		return nil, nil
	}
	lat, err1 := strconv.ParseFloat(hits[0].Lat, 64)
	lon, err2 := strconv.ParseFloat(hits[0].Lon, 64)
	if err1 != nil || err2 != nil {
		return nil, nil
	}
	return &Location{Lat: lat, Lon: lon, Label: strings.TrimSpace(region)}, nil
}

func (g *Geocoder) loadCache() map[string]geoCacheEntry {
	out := map[string]geoCacheEntry{}
	var value string
	err := g.repo.db.QueryRow(`SELECT value FROM kv WHERE key = ?`, geoCacheKey).Scan(&value)
	if err != nil {
		return out
	}
	_ = json.Unmarshal([]byte(value), &out)
	if out == nil {
		return map[string]geoCacheEntry{}
	}
	return out
}

func (g *Geocoder) saveCache(cache map[string]geoCacheEntry) {
	if len(cache) > geoCacheMax {
		keys := make([]string, 0, len(cache))
		for k := range cache {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return cache[keys[i]].TS < cache[keys[j]].TS })
		for _, k := range keys[:len(keys)-geoCacheMax] {
			delete(cache, k)
		}
	}
	data, err := json.Marshal(cache)
	if err != nil {
		return
	}
	if _, err := g.repo.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, geoCacheKey, string(data)); err != nil {
		log.Printf("library: geocode cache save failed: %v", err)
	}
}

// countryNameForCode ports geocodeBean's `new Intl.DisplayNames(['en'],
// { type: 'region' }).of(bean.origin)` lookup for the English country name
// appended to the Nominatim query. Go has no built-in ISO-region name
// table; this covers the coffee-growing set bean origins realistically hold
// (lib/coffee-countries.js's COFFEE_COUNTRY_CODES) and returns "" for
// anything else — the same result Node's own `catch` branch produces, where
// the query then falls back to the bare region string.
func countryNameForCode(code string) string {
	return coffeeCountryNames[strings.ToUpper(strings.TrimSpace(code))]
}

var coffeeCountryNames = map[string]string{
	"AO": "Angola", "BI": "Burundi", "BO": "Bolivia", "BR": "Brazil",
	"CD": "Congo - Kinshasa", "CI": "Côte d’Ivoire", "CM": "Cameroon",
	"CN": "China", "CO": "Colombia", "CR": "Costa Rica", "CU": "Cuba",
	"DO": "Dominican Republic", "EC": "Ecuador", "ET": "Ethiopia",
	"GH": "Ghana", "GT": "Guatemala", "HN": "Honduras", "HT": "Haiti",
	"ID": "Indonesia", "IN": "India", "JM": "Jamaica", "KE": "Kenya",
	"KH": "Cambodia", "LA": "Laos", "LK": "Sri Lanka", "MM": "Myanmar (Burma)",
	"MW": "Malawi", "MX": "Mexico", "MZ": "Mozambique", "NI": "Nicaragua",
	"NP": "Nepal", "PA": "Panama", "PE": "Peru", "PG": "Papua New Guinea",
	"PH": "Philippines", "RW": "Rwanda", "SV": "El Salvador", "TH": "Thailand",
	"TL": "Timor-Leste", "TZ": "Tanzania", "UG": "Uganda", "US": "United States",
	"VE": "Venezuela", "VN": "Vietnam", "YE": "Yemen", "ZM": "Zambia",
	"ZW": "Zimbabwe",
}

// IsCoffeeCountryCode ports lib/coffee-countries.js's
// `COFFEE_COUNTRY_CODES.includes(code)` membership test — the coffee
// -growing ISO 3166-1 alpha-2 set. coffeeCountryNames' keys ARE that list
// (verified equal, 47 entries), so this reuses it rather than re-embedding
// the codes a third time (importer/countries.go holds the localized-name
// map, this file the English-name map).
func IsCoffeeCountryCode(code string) bool {
	_, ok := coffeeCountryNames[strings.ToUpper(strings.TrimSpace(code))]
	return ok
}

// ResolveBeanOriginCode ports lib/card.js's resolveBeanOriginCode(coffeeName,
// library): the first resolvable coffee-growing-country code for the bean
// whose name matches coffeeName exactly (case-insensitively), or "" when
// nothing matches. The share-card renderer (internal/shots) calls this
// through a callback so it doesn't import this package directly — same
// wiring style as the geocode hook above.
func ResolveBeanOriginCode(coffeeName string, repo *Repository) string {
	name := strings.ToLower(strings.TrimSpace(coffeeName))
	if name == "" || repo == nil {
		return ""
	}
	lib, err := repo.GetLibrary()
	if err != nil {
		return ""
	}
	for _, bean := range lib.Beans {
		if strings.ToLower(strings.TrimSpace(strOf(bean["name"]))) != name {
			continue
		}
		// origins array first (blend-capable), then the legacy scalar
		// origin — mirrors card.js's
		// `Array.isArray(bean.origins) && bean.origins.length ? ... : (bean.origin ? [{code: bean.origin}] : [])`.
		var code string
		if origins, ok := bean["origins"].([]any); ok && len(origins) > 0 {
			if first, ok := origins[0].(map[string]any); ok {
				code = strOf(first["code"])
			}
		} else {
			code = strOf(bean["origin"])
		}
		if code != "" && IsCoffeeCountryCode(code) {
			return strings.ToUpper(strings.TrimSpace(code))
		}
		return ""
	}
	return ""
}
