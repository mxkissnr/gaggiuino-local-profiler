// Package importer ports routes/import.js + lib/import-{generic,parsers,
// providers}.js + lib/repositories/ImportSettingsRepository.js (#901 Phase 2c):
// GET /api/import/url (fetch a shop/roaster product URL and extract bean
// metadata) plus GET/POST /api/import/settings (built-in provider toggles +
// custom Shopify domains, stored under kv.key = 'import_settings').
//
// The bean value every parser produces is a map[string]any, deliberately —
// the Node originals build plain JS objects with many optional fields, and
// the embedded Vite frontend's import dialog consumes exactly that loose
// shape (a subset of the Bean schema plus importMethod/sourceUrl/variants/
// duplicateWarning/extraBrewRecipes/_debug). Fields the Node code sets to
// `null` are kept as JSON null; fields it leaves `undefined` are simply
// absent from the map.
//
// SSRF: GET /api/import/url fetches an arbitrary user-supplied URL, so every
// hop (initial URL + every redirect target; redirects are never auto-
// followed) is checked with lib/ssrf-guard.js's assertPublicHost — here via
// netguard.AssertHost + netguard.IsPrivateAddress. That private-address
// predicate was promoted out of internal/library/ssrf.go in this phase (same
// threat model as that package's barcode-scan guard) rather than copied a
// third time; see internal/netguard/private.go. This package keeps its own
// lookupIPAddr test seam, exactly as internal/library does.
//
// HTML scraping (cheerio -> github.com/PuerkitoBio/goquery + golang.org/x/net/html):
// the JSON-LD / OpenGraph fallbacks and the HTML-only bean-detail enrichment
// pass (accordion / origin-wrapper / brew-guide scrapers) are ported
// faithfully, including textWithLineBreaks's block-level "\n" insertion for
// minified themes.
//
// Deliberately not ported: lib/geo.js's geocodeBean (Phase 2g, already done
// in internal/library) and the bean-image download that routes/library/beans.js
// does after an import (that lives in internal/library's create path, not here).
package importer
