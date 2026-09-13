package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
)

// DefaultTokenFile is the on-disk location the Node app reads/writes the
// generated X-GLP-Token from (lib/constants.js's TOKEN_FILE).
const DefaultTokenFile = "/data/api_token.txt"

// HAIngressPrefix is the fixed prefix of the X-Ingress-Path header HA Core
// sets when proxying a request through Ingress (lib/constants.js's
// HA_INGRESS_PREFIX). It is a PREFIX, not the add-on's own path: HA Core
// sets X-Ingress-Path to `/api/hassio_ingress/<per-session random token>`
// (homeassistant/components/hassio/ingress.py), never the add-on slug, and
// the token differs per install and even per dev-add-on install — there is
// no fixed suffix to pin. The Supervisor-IP check alongside every use of
// this prefix (see IsIngressRequest) is what makes the header trustworthy:
// any LAN client that can reach the app's port can otherwise send an
// arbitrary X-Ingress-Path.
const HAIngressPrefix = "/api/hassio_ingress/"

// IsSupervisorIP ports lib/helpers.js's isSupervisorIp(ip) verbatim,
// including its exact (non-obvious) string semantics: only literal
// "127.0.0.1" or "::1" — not the whole 127.0.0.0/8 loopback block — count as
// loopback, and "172.30." is a plain string prefix check on the (optionally
// IPv4-mapped) address, not a CIDR-aware containment check. This is
// deliberately a string comparison, not net.IP-based (no ParseIP,
// IsLoopback, or IPNet.Contains): the Node original never parses the IP
// either, it just strips a leading "::ffff:" and does ===/startsWith on the
// resulting string, so anything that isn't exactly one of those three forms
// (e.g. "127.0.0.5", an octal/non-canonical form, garbage) is untrusted —
// same as here.
//
// #801 (also called out in server.js's isFromSupervisor comment this
// mirrors): this deliberately trusts the *whole* 172.30.0.0/16 network, not
// only the Ingress proxy specifically — any other add-on running on that
// network could in principle send a crafted X-Ingress-Path and be treated
// as Ingress by IsIngressRequest. Not a regression versus the Node
// original and not exploitable beyond what the already-public GET
// /api/token grants, but load-bearing for anything later built on the
// assumption that Ingress implies trusted.
func IsSupervisorIP(ip string) bool {
	plain := strings.TrimPrefix(strings.TrimSpace(ip), "::ffff:")
	return plain == "127.0.0.1" || plain == "::1" || strings.HasPrefix(plain, "172.30.")
}

// RemoteIP extracts the connecting IP from an *http.Request's RemoteAddr
// (normally "host:port"; tests/fabricated requests may set a bare IP, which
// is passed through unchanged if it has no port to split off).
func RemoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// IsFromSupervisor ports server.js's isFromSupervisor(req): true only for
// requests whose connection originates from the HA Supervisor's internal
// network. External LAN clients arrive with their own IP and must not
// receive the same trust level.
func IsFromSupervisor(r *http.Request) bool {
	return IsSupervisorIP(RemoteIP(r))
}

// IsIngressRequest ports server.js's isIngressRequest(req): true only for
// requests that genuinely arrive through HA Ingress — an X-Ingress-Path
// header with the expected prefix AND a Supervisor-network source IP (the
// same trust check IsFromSupervisor uses). The Supervisor-IP check is what
// stops a LAN client on the app's exposed port from simply sending its own
// X-Ingress-Path header to pass this.
func IsIngressRequest(r *http.Request) bool {
	ingressPath := r.Header.Get("X-Ingress-Path")
	return strings.HasPrefix(ingressPath, HAIngressPrefix) && IsFromSupervisor(r)
}

// IsTokenValid ports server.js's isTokenValid(token): a constant-time
// comparison of a candidate X-GLP-Token against the app's real token, using
// crypto/subtle.ConstantTimeCompare exactly where Node uses
// crypto.timingSafeEqual. stored/candidate empty, or of different lengths,
// return false immediately without comparing — matching the Node original's
// own early-exit behavior 1:1 (Node itself declines to run
// timingSafeEqual on mismatched lengths, since that function panics on
// unequal-length buffers; ConstantTimeCompare instead returns 0 for
// unequal lengths, but the explicit length check is kept here to mirror the
// Node control flow exactly, not just its outcome).
func IsTokenValid(stored, candidate string) bool {
	if stored == "" || candidate == "" {
		return false
	}
	a := []byte(candidate)
	b := []byte(stored)
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

// LoadOrCreateToken ports server.js's loadOrCreateApiToken(): reads the
// token at path if present (trimmed, matching Node's .trim() on read), or
// generates a new 32-byte random token (hex-encoded, matching Node's
// crypto.randomBytes(32).toString('hex')) and persists it via an atomic
// write (writeTokenFile below, the same tmp-file-then-rename pattern as
// lib/helpers.js's writeFileSafe) if none exists yet.
func LoadOrCreateToken(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err == nil {
		return strings.TrimSpace(string(data)), nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", err
	}
	token := hex.EncodeToString(tokenBytes)
	if err := writeTokenFile(path, token); err != nil {
		return "", err
	}
	return token, nil
}

// writeTokenFile ports lib/helpers.js's writeFileSafe (write-to-.tmp then
// rename, so a reader can never observe a partially-written token file).
//
// #1057: 0o600, not 0o644 — this file holds the live X-GLP-Token, so any
// other local account on the host (or another container sharing the /data
// bind mount) had read access to the credential that guards every other
// endpoint. docker-entrypoint.sh's `chown -R glp:glp /data` runs as root
// before dropping to the unprivileged glp user, so the file stays readable
// by the one account that actually needs it (the exec'd server process)
// regardless of this tightened mode.
func writeTokenFile(path, content string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// SecurityHeaders wraps next with server.js's security-header middleware
// (the app.use((req, res, next) => {...}) block near the top of that file,
// lines ~83-98) — same header names and values, with one deliberate
// deviation: X-Frame-Options is SAMEORIGIN here, not server.js's DENY.
//
// DENY blocks framing unconditionally, including same-origin — which broke
// the HA sidebar panel embed live in production (2026-08-21): HA's Ingress
// proxy serves this app under the *same origin* as the Home Assistant
// frontend itself (https://<ha-host>/api/hassio_ingress/<token>/..., same
// scheme+host+port as https://<ha-host>/), so the panel_icon/panel_title
// sidebar iframe this app's config.yaml opts into is a same-origin embed,
// not cross-origin — exactly what SAMEORIGIN exists to allow while still
// blocking the cross-origin clickjacking DENY/SAMEORIGIN both guard
// against. This is very likely a latent, identical bug in the Node app
// (server.js sends the same unconditional DENY) that has simply never been
// hit there — not something introduced by this port. Left unfixed on the
// Node side deliberately: out of scope for this migration, flag for a
// separate issue instead of touching server.js here.
//
// Chart.js, ECharts, topojson-client, QRCode and both fonts (Figtree,
// Fraunces) are bundled into the app, hence no third-party host needed in
// the CSP. frame-ancestors 'self' is added (absent from server.js's CSP)
// as defense-in-depth alongside the header fix above — belt-and-braces,
// not required, since X-Frame-Options already governs when frame-ancestors
// is absent.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"font-src 'self' data:; "+
				"img-src 'self' data: blob:; "+
				"connect-src 'self'; "+
				"frame-ancestors 'self';")
		next.ServeHTTP(w, r)
	})
}

// publicStaticPaths are exact GET/HEAD request paths that stay reachable
// with no token — the production SPA's own bootstrap surface, embedded and
// served by internal/webapp from the Vite build output (see
// gaggiuino-local-profiler/public/ and vite.config.js). Every entry here
// serves compiled, request-independent bytes with no live database
// content, matching what public-src/index.html and its scripts reference
// directly (not through apiFetch(), so none of these requests ever carries
// an X-GLP-Token):
//
//   - "/" and "/index.html": the SPA shell (also the Docker HEALTHCHECK
//     target, which curls "/" expecting 200 with no token).
//   - "/manifest.json", "/sw.js": the PWA manifest and service worker,
//     fetched by the browser itself, not by any app JS.
//   - "/icon.png": index.html's <link rel="apple-touch-icon">.
//   - "/countries-110m.json": world-map topojson data, fetched directly by
//     public-src/views/analytics.js's plain fetch() (see that file).
//
// #1048: this is an explicit allowlist, not the inverse of an /api/ prefix
// check the old bypass used — see this function's caller for why. Adding a
// new top-level static file to public-src's root (bypassing the hashed
// public/assets/ pipeline entirely) needs a new literal entry here, same
// as adding a new public /api/ route needs its own carve-out below.
var publicStaticPaths = map[string]bool{
	"/":                    true,
	"/index.html":          true,
	"/manifest.json":       true,
	"/sw.js":               true,
	"/icon.png":            true,
	"/countries-110m.json": true,
}

// publicStaticPrefixes are path prefixes that stay reachable the same way
// as publicStaticPaths, for content whose exact filename varies (Vite's
// content-hashed build output) or that lives under its own dedicated
// static subtree with no live data anywhere in it.
var publicStaticPrefixes = []string{
	// public/assets/*: Vite's content-hashed JS/CSS/font bundle for the SPA
	// — the filenames change on every build, so no exact-match entry above
	// would stay accurate.
	"/assets/",
	// internal/web's vendored htmx/Alpine, first-party glp-token.js, and
	// style.css (see internal/web/assets.go) — plain library/script/style
	// bytes, no live data, needed even though the /ui/ pages that load them
	// now require a token themselves (see isPublicStaticPath's doc comment
	// and internal/web/doc.go's "Auth model" section).
	"/ui/web/static/",
}

// isPublicStaticPath reports whether path is on the fixed allowlist of
// static, request-independent bytes that may bypass RequireToken for
// GET/HEAD (see RequireToken's own doc comment for the CSRF-relevant
// GET/HEAD scoping this sits inside).
//
// #1048: this replaces a blanket "not under /api/" bypass. That rule was
// sound while the only non-/api/ surface was the SPA's own static bundle;
// it stopped being sound once internal/web's templ pages (#901, mounted
// under /ui/) started rendering live database content — shots, the coffee
// library, machines with their configured hosts, the order queue with
// customer names, maintenance — from server-side data, not compiled
// assets. Under the old rule any LAN host reaching the app's exposed port
// could read all of that with zero credentials, no token or Ingress
// required, simply by requesting a /ui/* path. Enumerating the actual
// static surface instead means a *future* route registered outside /api/
// (in mux or uiMux, whether or not it happens to live under /ui/) is
// gated by default — the developer has to deliberately add it here to
// open it back up, rather than the previous default of open-unless-under-
// /api/.
//
// One consequence, stated here because it is easy to miss: this makes
// every /ui/* page (internal/web's templ pages) require a token or genuine
// Ingress for a plain GET too, not just their htmx write actions. Those
// pages' own nav links (templates/layout.templ) are ordinary <a href>
// anchors, not htmx-boosted — a full browser navigation, which cannot
// attach a custom X-GLP-Token header. glp-token.js only ever wires the
// token into htmx requests (its documented mechanism), not page loads. So
// under HA Ingress this fix changes nothing (IsIngressRequest already
// bypasses earlier, unconditionally, for every method) but a direct-port/
// standalone LAN client with no Ingress session can no longer reach a
// /ui/* page as a normal browser navigation at all, valid token or not —
// there is no mechanism today for a plain GET to present one. That is the
// intended, narrower trade-off of closing this hole: a reduced-scope fix
// that is correct beats a complete one that is wrong. Restoring direct-
// port navigability for those pages (e.g. a short-lived signed query
// param, or a session cookie minted from GET /api/token) is a separate,
// deliberate feature, not folded into this fix.
func isPublicStaticPath(path string) bool {
	if publicStaticPaths[path] {
		return true
	}
	for _, prefix := range publicStaticPrefixes {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

// RequireToken returns middleware porting server.js's API-token-auth
// app.use block (the req.glpAuthenticated / req.glpIsIngress computation
// and the five-way if-chain that follows it, lines ~143-173): same checks,
// same order, so the same requests pass or fail under both implementations
// — with one deliberate divergence, not a paraphrase of the rest: the
// static-bypass below is scoped to GET/HEAD, where server.js's equivalent
// line (`if (!req.path.startsWith('/api/') && req.path !== '/shots.json')
// return next();`) has no method check at all. That's safe in server.js
// only because no write route is ever registered outside /api/ there
// (routes/*.js's mutating endpoints all live under /api/, static files/
// index.html are the only non-/api/ surface) — a precondition that stopped
// holding once internal/web (#901, Phase 2a) registered POST
// /shots/{id}/trash and .../restore outside /api/. Scoping the bypass to
// GET/HEAD here closes that CSRF hole for those two routes and any future
// one like them, without having to special-case each route individually.
// It must run behind SecurityHeaders and ahead of any route — see
// cmd/server's middleware chain, whose ordering follows server.js's actual
// app.use() registration order (security headers, then the rate limiter,
// then this), not a paraphrase of it.
func RequireToken(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Fail closed, not open: if no token is available, deny
			// everything instead of letting every request through
			// unauthenticated — mirrors server.js's own `if
			// (!state.apiToken) return res.status(503)...` defensive check.
			// In practice cmd/server never installs this middleware at all
			// if LoadOrCreateToken failed at startup, so token is never
			// empty here; this guard stays anyway to match the Node
			// original's own belt-and-suspenders check.
			if token == "" {
				writeJSONError(w, http.StatusServiceUnavailable, "API token unavailable")
				return
			}

			authenticated := IsTokenValid(token, r.Header.Get("X-GLP-Token"))
			// #735: EventSource can't send custom headers, so /api/events —
			// and only that route — also accepts the token as a query
			// param. See internal/sse/doc.go for why this lives here and
			// not in that package.
			if !authenticated && r.URL.Path == "/api/events" {
				authenticated = IsTokenValid(token, r.URL.Query().Get("token"))
			}

			// Ingress bypass: only trust X-Ingress-Path when the request
			// genuinely originates from the HA Supervisor (see
			// IsIngressRequest) — prevents header spoofing from external
			// LAN clients who can also reach the exposed port.
			if IsIngressRequest(r) {
				next.ServeHTTP(w, r)
				return
			}
			if r.URL.Path == "/api/status" {
				next.ServeHTTP(w, r)
				return
			}
			if r.URL.Path == "/api/token" { // endpoint enforces expose_api_port itself
				next.ServeHTTP(w, r)
				return
			}
			// #901 code review: this bypass must stay scoped to read-only
			// requests. It was originally "any non-/api/ path", which also
			// let through htmx's POST /shots/{id}/trash and .../restore —
			// removing the token/CSRF protection those write actions need
			// (see internal/web/doc.go's "Auth model" section, updated
			// alongside this fix). GET and HEAD carry no writable HTTP
			// semantics (net/http.ServeMux itself routes HEAD to a
			// registered GET handler, so both must bypass identically —
			// see internal/web.Handlers.RegisterRoutes' "GET /shots"
			// pattern), so scoping the bypass to those two methods keeps
			// today's unauthenticated static reads working while
			// automatically gating any future write route registered
			// outside /api/, without needing a per-route opt-in.
			//
			// #1048: the path itself must additionally be on the explicit
			// static allowlist (isPublicStaticPath) — see that function's
			// doc comment for why the old "not under /api/" rule let any
			// LAN host read the live data internal/web's /ui/ pages render.
			if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
				isPublicStaticPath(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			if authenticated {
				next.ServeHTTP(w, r)
				return
			}
			writeJSONError(w, http.StatusUnauthorized, "Unauthorized")
		})
	}
}

// writeJSONError ports the `res.status(...).json({ error: ... })` shape
// server.js's auth middleware responds with on both its failure paths.
func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":%q}`, message)
}
