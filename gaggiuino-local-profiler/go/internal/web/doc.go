// Package web is the Go frontend foundation (Phase 2a, #901): templ+htmx+
// Alpine tooling, the shared page layout, and the first fully working
// page — a shots list — built on top of internal/shots' existing Phase 1c
// service layer, the same way internal/shots itself was the first REST
// domain package establishing the pattern every later one followed (see
// go/README.md's Status section). No REST-API handler in internal/shots is
// reused directly for HTML rendering here — this package calls
// shots.Service, the same dependency internal/shots' own handlers.go
// calls, and renders HTML instead of JSON from it.
//
// File layout:
//
//	doc.go              this file
//	assets.go           embed.FS for static/ (vendored htmx/Alpine, style.css,
//	                    glp-token.js)
//	view.go             shots.Shot -> templates.ShotRow projection
//	handlers.go         GET /shots + the two htmx trash/restore actions
//	view_library.go     (Phase 2b) library.Entity -> templates' *Row projections
//	handlers_library.go (Phase 2b) GET /beans,/grinders,/baskets,/puckscreens,
//	                    /milks,/recipes + the toggle-active htmx action
//	view_machines.go     (Phase 2c) machines.Machine -> templates.MachineRow
//	handlers_machines.go (Phase 2c) GET /machines + set-default/delete htmx
//	                    actions, plus GET /live (static chrome only — the
//	                    live chart itself is static/live.js, not server-
//	                    rendered; see that file's own doc comment)
//	view_orders.go       (Phase 2d) orders.Order -> templates.OrderRow
//	handlers_orders.go   (Phase 2d) GET /orders (barista queue) + its
//	                    accept/complete/decline htmx actions, plus GET /menu
//	                    (customer ordering form) + POST /menu/order
//	view_maintenance.go   (Phase 2e) maintenance.Stat -> templates.MaintTile
//	handlers_maintenance.go (Phase 2e) GET /maintenance (per-machine task
//	                    list) + the "mark done" htmx action, built on
//	                    maintenance.MarkTaskDone (a service-layer function
//	                    added this phase — see that function's own doc
//	                    comment for why, the same Phase-2d lesson repeated)
//	handlers_settings.go (Phase 2e) GET /settings (default machine's
//	                    Gaggiuino settings categories) + the one editable
//	                    category's save action, built on machines.Adapter's
//	                    GetSettings/UpdateSettings via an AdapterProvider seam
//	handlers_backup.go   (Phase 2e) GET /backup — a download link for the
//	                    existing GET /api/backup export; no write action
//	                    (restore stays JSON-API-only this phase, see that
//	                    file's own doc comment)
//	templates/          .templ sources (own package; see templates/layout.templ)
//	static/             vendored + first-party JS/CSS served at /web/static/*
//	                    (Phase 2c adds live.js and vendored Chart.js)
//
// # Auth model
//
// GET /shots and /web/static/* are deliberately NOT gated by
// internal/auth.RequireToken's X-GLP-Token check — same as every static
// asset the Node app serves today. server.js's public-src frontend fetches
// its own token via GET /api/token and attaches it to its own XHR calls
// (see public-src/api.js's initToken()); the static shell that bootstraps
// that fetch was never itself gated, and neither is this package's read-only
// page. Protected the same way the rest of the static frontend already is
// — HA Ingress's own auth in front of the add-on, or physical/LAN access to
// the exposed port in standalone mode.
//
// The htmx write actions — POST /shots/{id}/trash, POST /shots/{id}/restore,
// (Phase 2b) POST /beans/{id}/toggle-active in handlers_library.go,
// (Phase 2c) POST /machines/{id}/default and POST /machines/{id}/delete in
// handlers_machines.go, (Phase 2d) POST /orders/{id}/{accept,complete,
// decline} and POST /menu/order in handlers_orders.go, and (Phase 2e)
// POST /maintenance/{task}/done in handlers_maintenance.go and
// POST /settings/display in handlers_settings.go — are NOT part of
// that carve-out: RequireToken's bypass in
// internal/auth/auth.go is scoped to GET/HEAD requests specifically (a #901
// code-review fix — it originally matched any non-/api/ path regardless of
// method, which let any third-party page in the user's browser trigger
// these writes with a plain unauthenticated POST, no token or custom header
// required — a CSRF hole). A POST here now has to either arrive through
// genuine HA Ingress (RequireToken's IsIngressRequest bypass, which applies
// before the GET/HEAD check and covers the add-on's primary access path
// unconditionally) or carry a valid X-GLP-Token header, exactly like the
// JSON API.
//
// That header is wired in structurally, for every current and future
// Phase-2 page, not per-button: templates/layout.templ loads
// static/glp-token.js once, globally, in <head>. That script fetches the
// token from the already-public GET /api/token (mirroring
// public-src/api.js's initToken() for the existing SPA) and attaches it as
// X-GLP-Token to every htmx request via htmx's htmx:configRequest event —
// see glp-token.js's own doc comment for the full mechanism and why
// fetch-and-attach was chosen over baking the token into GET /shots' own
// HTML (that page is itself unauthenticated per the paragraph above, so an
// SSR-embedded token would hand it to a caller who couldn't otherwise get
// it — GET /api/token carries no such risk, since it's already exactly as
// reachable to that same caller). Standalone mode with expose_api_port
// explicitly set to false denies GET /api/token to a non-Ingress caller
// (see internal/system/handlers.go's getToken), so glp-token.js's fetch
// comes back empty and the Trash/Restore buttons 401 in that
// configuration — not a new failure mode, the same one
// isApiPortBlocked()/api.js's initToken() already describe for the SPA
// today, and out of scope for this package to change. This is the ONLY
// caller glp-token.js's fetch is expected to fail for — genuine HA Ingress
// access (the primary path) reaches GET /api/token fine, because the
// fetch is relative ("api/token"), resolving against the Ingress-prefixed
// page URL the same way public-src/api.js's initToken() does, not against
// the origin root (a #901 code-review fix: a root-absolute fetch would
// have skipped the Ingress prefix entirely and missed the add-on).
// TestBrowserFlow_FetchedTokenAuthorizesTrash in handlers_test.go drives
// this end to end through the real auth.RequireToken stack: fetch GET
// /api/token, then use the token it returns to authorize
// POST /shots/{id}/trash.
//
// # Ingress-safe relative paths
//
// Every href/src/hx-get/hx-post/hx-put/hx-delete/hx-patch value this
// package's templates (or any Go code rendering HTML for them) ever emits
// MUST be path-relative with NO leading slash — "shots", not "/shots";
// fmt.Sprintf("beans/%d/toggle-active", id), not
// fmt.Sprintf("/beans/%d/toggle-active", id). This was originally
// established ad hoc (glp-token.js's "api/token" fetch, Auth model above;
// handlers.go's rootRedirect writing Location: "shots") and then found to
// be violated by literally every other template in this package (#901 live
// bug: under real HA Ingress the add-on is reachable only at a per-session
// prefix, e.g. https://ha/api/hassio_ingress/<token>/shots — Ingress
// strips that prefix before forwarding to the container, so r.URL.Path
// inside this app is always prefix-free ("/shots"), and nothing server-
// side ever sees or can reconstruct the prefix the browser used. A
// root-absolute href/src/hx-* in the rendered HTML therefore resolves in
// the browser against the origin root (https://ha/shots), not the Ingress
// prefix (https://ha/api/hassio_ingress/<token>/shots) — silently breaking
// every nav link, the CSS/JS <link>/<script> tags, and every htmx action on
// every page the instant a real user opens it through Ingress instead of a
// bare port).
//
// A relative path resolves in the browser against the current document's
// URL, dropping its last path segment first (the standard "relative URL"
// / RFC 3986 algorithm every <a href> already uses) — so from a document
// at .../<ingress-prefix>/shots, both a relative nav link ("beans") and a
// relative htmx action ("shots/42/trash") resolve back under
// .../<ingress-prefix>/..., prefix and all, with zero server-side
// awareness of what that prefix even is. This only works cleanly because
// every page route this package registers is exactly one path segment
// deep from root (GET /shots, /beans, /orders, /maintenance, ... — see
// the handler registrations in handlers*.go) and every relative reference
// point at another single-segment route or a same-page action/query
// string; a <base href> tag was deliberately NOT used instead, because HA
// Ingress gives the container no header or other signal to compute a
// correct dynamic base value from (only the already-stripped, prefix-free
// r.URL.Path), so a <base href> would either have to be wrong or would add
// a fake dependency the app can't actually satisfy — plain relative paths
// need no such signal at all.
//
// Phase 1 (#901): cmd/server now mounts every route below via
// http.StripPrefix under a /ui/ prefix (internal/webapp owns the app root
// with the production SPA). This does not change the scheme: the whole
// single-segment route subtree moved one level deeper together, so a
// relative path from /ui/shots to "beans" still resolves to /ui/beans and
// to "web/static/style.css" still resolves to /ui/web/static/style.css.
// "single segment deep from root" below now reads "single segment deep
// below /ui/"; the relative-URL math is identical.
//
// The load-bearing consequence for every FUTURE page: do not introduce a
// route nested more than one segment below the prefix (e.g. GET
// /ui/library/beans/{id}) without re-deriving this whole scheme — a relative
// path written on that page would resolve one directory shallower than
// intended. Keep new pages single-segment, and keep every href/src/hx-*
// literal (or fmt.Sprintf/string-concat building one) leading-slash-free.
// A `grep -rnE '(href|src|hx-(get|post|put|delete|patch))=\\{?"/[^/]' templates/`
// (informal; TestNoRootAbsolutePaths in handlers_test.go is the enforced,
// CI-checked form) catches a regression before it ships.
//
// # CSP
//
// internal/auth.SecurityHeaders's Content-Security-Policy (`script-src
// 'self'`, no `'unsafe-inline'`/`'unsafe-eval'`) is not relaxed for this
// package — every template avoids inline <script>/<style> and event-handler
// attributes, and static/vendor/ ships the CSP-safe Alpine build
// (@alpinejs/csp, not plain alpinejs) specifically because core Alpine's
// expression evaluator needs 'unsafe-eval'. See static/vendor/NOTICE.md.
package web
