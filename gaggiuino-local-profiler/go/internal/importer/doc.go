// Package importer implements the import API: GET /api/import/url (fetch a
// shop/roaster product URL and extract bean metadata), POST /api/import/paste
// (run the same parsers over product data the user pasted), plus GET/POST
// /api/import/settings (built-in provider toggles + custom Shopify domains,
// stored under kv.key = 'import_settings').
//
// A shop that answers HTTP 429 is reported, never retried: GLP always presents
// itself as GLP/1.0 (Gaggiuino Local Profiler; private use), adds no
// browser-like headers and reads no Retry-After, so a refusal is final for
// this request. The upstream body is never echoed back. Pasted product data
// goes through exactly the parsers a fetch uses; the host of the original URL
// selects them, so nothing in the pasted text can pick a parser. The paste
// route stores nothing — it only fills the import form.
//
// The bean value every parser produces is a map[string]any, deliberately —
// the embedded frontend's import dialog consumes exactly that loose
// shape (a subset of the Bean schema plus importMethod/sourceUrl/variants/
// duplicateWarning/extraBrewRecipes/_debug). Fields set to `null` are kept as
// JSON null; omitted fields are simply absent from the map.
//
// SSRF: GET /api/import/url fetches an arbitrary user-supplied URL, so every
// hop (initial URL + every redirect target; redirects are never auto-
// followed) is checked via netguard.AssertHost + netguard.IsPrivateAddress.
// That private-address predicate lives in internal/netguard/private.go (same
// threat model as internal/library's barcode-scan guard) rather than being
// copied a third time. This package keeps its own lookupIPAddr test seam,
// exactly as internal/library does.
//
// HTML scraping (github.com/PuerkitoBio/goquery + golang.org/x/net/html):
// the JSON-LD / OpenGraph fallbacks and the HTML-only bean-detail enrichment
// pass (accordion / origin-wrapper / brew-guide scrapers) include
// textWithLineBreaks's block-level "\n" insertion for minified themes.
//
// Not handled here: geocoding (internal/library) and the bean-image download
// after an import (internal/library's create path, not here).
package importer
