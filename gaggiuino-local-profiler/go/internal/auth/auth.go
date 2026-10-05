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

// DefaultTokenFile is the on-disk location of the generated X-GLP-Token.
const DefaultTokenFile = "/data/api_token.txt"

// HAIngressPrefix is the fixed prefix of the X-Ingress-Path header HA Core
// sets when proxying a request through Ingress. It is a PREFIX, not the add-on's own path: HA Core
// sets X-Ingress-Path to `/api/hassio_ingress/<per-session random token>`
// (homeassistant/components/hassio/ingress.py), never the add-on slug, and
// the token differs per install and even per dev-add-on install — there is
// no fixed suffix to pin. The Supervisor-IP check alongside every use of
// this prefix (see IsIngressRequest) is what makes the header trustworthy:
// any LAN client that can reach the app's port can otherwise send an
// arbitrary X-Ingress-Path.
const HAIngressPrefix = "/api/hassio_ingress/"

// IsSupervisorIP has exact (non-obvious) string semantics: only literal
// "127.0.0.1" or "::1" — not the whole 127.0.0.0/8 loopback block — count as
// loopback, and "172.30." is a plain string prefix check on the (optionally
// IPv4-mapped) address, not a CIDR-aware containment check. This is
// deliberately a string comparison, not net.IP-based (no ParseIP,
// IsLoopback, or IPNet.Contains): it strips a leading "::ffff:" and compares
// the resulting string, so anything that isn't exactly one of those three
// forms (e.g. "127.0.0.5", an octal/non-canonical form, garbage) is
// untrusted.
//
// #801: this deliberately trusts the *whole* 172.30.0.0/16 network, not only
// the Ingress proxy specifically — any other add-on running on that network
// could in principle send a crafted X-Ingress-Path and be treated as Ingress
// by IsIngressRequest. Not exploitable beyond what the already-public GET
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

// IsFromSupervisor is true only for requests whose connection originates
// from the HA Supervisor's internal network. External LAN clients arrive
// with their own IP and must not receive the same trust level.
func IsFromSupervisor(r *http.Request) bool {
	return IsSupervisorIP(RemoteIP(r))
}

// IsIngressRequest is true only for requests that genuinely arrive through
// HA Ingress — an X-Ingress-Path
// header with the expected prefix AND a Supervisor-network source IP (the
// same trust check IsFromSupervisor uses). The Supervisor-IP check is what
// stops a LAN client on the app's exposed port from simply sending its own
// X-Ingress-Path header to pass this.
func IsIngressRequest(r *http.Request) bool {
	ingressPath := r.Header.Get("X-Ingress-Path")
	return strings.HasPrefix(ingressPath, HAIngressPrefix) && IsFromSupervisor(r)
}

// IsTokenValid is a constant-time comparison of a candidate X-GLP-Token
// against the app's real token using crypto/subtle.ConstantTimeCompare.
// stored/candidate empty, or of different lengths, return false immediately
// without comparing (ConstantTimeCompare itself returns 0 for unequal
// lengths; the explicit length check is kept to decide the outcome
// directly).
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

// LoadOrCreateToken reads the token at path if present (trimmed), or
// generates a new 32-byte random token (hex-encoded) and persists it via an
// atomic write (writeTokenFile below) if none exists yet.
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

// writeTokenFile writes to a .tmp file then renames it, so a reader can
// never observe a partially-written token file.
// The token is a secret, so the file is 0600 (owner read/write only). The
// explicit Chmod is load-bearing: os.WriteFile's mode is masked by the
// process umask, and it leaves an already-existing .tmp at whatever mode it
// had, so neither path alone guarantees 0600 before the rename.
func writeTokenFile(path, content string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// SecurityHeaders wraps next with the security-header middleware, with one
// deliberate choice: X-Frame-Options is SAMEORIGIN, not DENY.
//
// DENY blocks framing unconditionally, including same-origin — which broke
// the HA sidebar panel embed live in production (2026-08-21): HA's Ingress
// proxy serves this app under the *same origin* as the Home Assistant
// frontend itself (https://<ha-host>/api/hassio_ingress/<token>/..., same
// scheme+host+port as https://<ha-host>/), so the panel_icon/panel_title
// sidebar iframe this app's config.yaml opts into is a same-origin embed,
// not cross-origin — exactly what SAMEORIGIN exists to allow while still
// blocking the cross-origin clickjacking DENY/SAMEORIGIN both guard against.
//
// Chart.js, ECharts, topojson-client, QRCode and both fonts (Figtree,
// Fraunces) are bundled into the app, hence no third-party host needed in
// the CSP. frame-ancestors 'self' is added as defense-in-depth alongside the
// header fix above — belt-and-braces, not required, since X-Frame-Options
// already governs when frame-ancestors is absent.
//
// script-src also carries 'wasm-unsafe-eval': the on-device photo cut-out
// compiles onnxruntime-web as WebAssembly, which that source permits on its
// own while still forbidding the general 'unsafe-eval' the bundle does not
// need.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' 'wasm-unsafe-eval'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"font-src 'self' data:; "+
				"img-src 'self' data: blob:; "+
				"connect-src 'self'; "+
				"frame-ancestors 'self';")
		next.ServeHTTP(w, r)
	})
}

// RequireToken returns the API-token-auth middleware: same checks and same
// order on every request, with one deliberate choice — the non-/api/ bypass
// below is scoped to GET/HEAD, whereas it could have no method check at all.
// No write route is registered outside /api/ today (static files/index.html
// are the only non-/api/ surface), but scoping the bypass to GET/HEAD keeps
// it from silently exposing any write route someone registers outside /api/
// later (a CSRF hole, as once happened with the since-removed server-rendered
// pages), without having to special-case each route individually.
// It must run behind SecurityHeaders and ahead of any route — see
// cmd/server's middleware chain, whose ordering is security headers, then
// the rate limiter, then this.
func RequireToken(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Fail closed, not open: if no token is available, deny
			// everything instead of letting every request through
			// unauthenticated. In practice cmd/server never installs this
			// middleware at all if LoadOrCreateToken failed at startup, so
			// token is never empty here; this guard stays anyway as a
			// belt-and-suspenders check.
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
			// requests. It was originally "any non-/api/ path", which would
			// also let through any write route registered outside /api/,
			// removing the token/CSRF protection it needs. No such route
			// exists today (the SPA routes in internal/webapp are all
			// GET/HEAD), so this is a guard for future routes. GET and HEAD
			// carry no writable HTTP semantics (net/http.ServeMux itself
			// routes HEAD to a registered GET handler, so both must bypass
			// identically), so scoping the bypass to those two methods keeps
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

// HostAllowed reports whether host — a request Host header value, which may
// carry a port and IPv6 brackets — names a host the app should answer for.
// It strips the port, lower-cases, trims a trailing dot and any IPv6
// brackets, then accepts an IP literal, "localhost", a single label with no
// dot (the Supervisor-internal app hostname an add-on is reached by), any
// ".local" name, or an exact (case-insensitive) match against extra. An
// empty host is not allowed.
func HostAllowed(host string, extra []string) bool {
	name := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		name = h
	}
	name = strings.ToLower(name)
	name = strings.TrimSuffix(name, ".")
	name = strings.Trim(name, "[]")
	if name == "" {
		return false
	}
	if net.ParseIP(name) != nil || name == "localhost" {
		return true
	}
	if !strings.Contains(name, ".") {
		return true
	}
	if strings.HasSuffix(name, ".local") {
		return true
	}
	for _, e := range extra {
		if strings.EqualFold(name, e) {
			return true
		}
	}
	return false
}

// ParseAllowedHosts splits a comma- or whitespace-separated list of host
// names (the allowed_hosts add-on option or GLP_ALLOWED_HOSTS) into cleaned
// entries: trimmed, lower-cased, port-stripped, with empties dropped.
func ParseAllowedHosts(s string) []string {
	fields := strings.Fields(strings.ReplaceAll(s, ",", " "))
	var out []string
	for _, f := range fields {
		name := f
		if h, _, err := net.SplitHostPort(f); err == nil {
			name = h
		}
		name = strings.ToLower(name)
		name = strings.TrimSuffix(name, ".")
		name = strings.Trim(name, "[]")
		if name != "" {
			out = append(out, name)
		}
	}
	return out
}

// RequireKnownHost returns the DNS-rebinding-protection middleware: when the
// request Host header is not a known host name (HostAllowed) the request is
// refused with 421 before any handler runs, so a name the app does not
// expect cannot reach even the public GET /api/token. Home Assistant Ingress
// requests (IsIngressRequest) always pass — their Host is the HA host, which
// the app has no way to enumerate. There is deliberately no Origin check:
// the bearer token is never attached by the browser on its own, and the
// Order Card's direct-URL mode posts cross-origin legitimately. It runs
// behind SecurityHeaders and ahead of the rate limiter — see cmd/server's
// middleware chain.
func RequireKnownHost(extra []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if IsIngressRequest(r) {
				next.ServeHTTP(w, r)
				return
			}
			if !HostAllowed(r.Host, extra) {
				writeJSONError(w, http.StatusMisdirectedRequest, "host not allowed; add it to the allowed_hosts setting")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// writeJSONError writes the `{ error: ... }` JSON body both auth failure
// paths respond with.
func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":%q}`, message)
}
