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
func writeTokenFile(path, content string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
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

// RequireToken returns middleware porting server.js's API-token-auth
// app.use block (the req.glpAuthenticated / req.glpIsIngress computation
// and the five-way if-chain that follows it, lines ~143-173): same checks,
// same order, so the same requests pass or fail under both implementations
// — with one deliberate divergence, not a paraphrase of the rest: the
// non-/api/ bypass below is scoped to GET/HEAD, where server.js's
// equivalent line (`if (!req.path.startsWith('/api/') && req.path !==
// '/shots.json') return next();`) has no method check at all. That's safe
// in server.js only because no write route is ever registered outside
// /api/ there (routes/*.js's mutating endpoints all live under /api/,
// static files/index.html are the only non-/api/ surface) — a precondition
// that stopped holding once internal/web (#901, Phase 2a) registered POST
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
			// today's unauthenticated static/page reads working while
			// automatically gating any future write route registered
			// outside /api/, without needing a per-route opt-in.
			if (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
				!strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/shots.json" {
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
