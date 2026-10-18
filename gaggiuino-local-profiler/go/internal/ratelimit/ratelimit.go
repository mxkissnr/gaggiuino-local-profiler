package ratelimit

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
)

// DefaultWindow and DefaultMax are the app-wide rate-limit defaults
// (60s / 600 requests).
const (
	DefaultWindow = 60 * time.Second
	DefaultMax    = 600

	// ingressUserIDHeader is the per-user header HA Ingress requests carry when
	// the Supervisor forwards it. Only trusted on auth.IsIngressRequest requests.
	ingressUserIDHeader = "X-Remote-User-Id"
	// maxIngressUserIDLen bounds a header value so a crafted id cannot bloat the
	// unbounded bucket map.
	maxIngressUserIDLen  = 64
	ingressUserKeyPrefix = "ingress-user:"
)

// ingressHeaderLogged makes the "is the per-user header forwarded?" check a
// one-time, startup-adjacent log line instead of one per request.
var ingressHeaderLogged sync.Once

// Limiter holds one token bucket per client key, created lazily on first
// use and never evicted — bounded in practice by the number of distinct
// socket addresses and forwarded Ingress user ids (each capped at 64 printable
// ASCII bytes) that ever reach this process, an unbounded-but-small-in-practice
// memory profile.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*rate.Limiter
	rate    rate.Limit
	burst   int
}

// New creates a Limiter allowing up to max requests per window, per key.
func New(window time.Duration, max int) *Limiter {
	// Tolerate a caller's bad setting rather than panic or silently disable
	// limiting: max < 1 divides by zero below, window <= 0 yields rate.Inf.
	if max < 1 {
		max = 1
	}
	if window <= 0 {
		window = DefaultWindow
	}
	return &Limiter{
		buckets: make(map[string]*rate.Limiter),
		rate:    rate.Every(window / time.Duration(max)),
		burst:   max,
	}
}

func (l *Limiter) bucket(key string) *rate.Limiter {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		b = rate.NewLimiter(l.rate, l.burst)
		l.buckets[key] = b
	}
	return b
}

// Allow reports whether one more request for key is permitted right now,
// consuming one token from its bucket if so.
func (l *Limiter) Allow(key string) bool {
	return l.bucket(key).Allow()
}

// bucketKey normalizes an address for use as a rate-limit key: IPv4
// addresses are used as-is, one bucket per exact address, but IPv6 addresses
// are masked down to their /64 network prefix first, so every address a
// client can draw from a single routed /64 (or larger) allocation shares one
// bucket instead of getting a fresh one on every request — see doc.go.
func bucketKey(ip string) string {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return ip
	}
	if v4 := parsed.To4(); v4 != nil {
		return v4.String()
	}
	return parsed.Mask(net.CIDRMask(64, 128)).String()
}

// Middleware applies the app-wide rate limit: same key (auth.RemoteIP — raw
// socket address only, IPv6-/64-normalized via bucketKey, see doc.go), same
// /assets/* exemption, same 429 JSON error shape. Ingress requests with a
// forwarded per-user header are keyed per Home Assistant user instead, so they
// do not all share the Supervisor's single address bucket.
func (l *Limiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			next.ServeHTTP(w, r)
			return
		}
		if !l.Allow(requestKey(r)) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			json.NewEncoder(w).Encode(map[string]string{"error": "Too many requests"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requestKey returns the rate-limit bucket key for r. Non-Ingress requests
// keep the raw socket-address key exactly as before: a LAN client on the
// exposed port could set X-Remote-User-Id itself, so the header is only read
// when auth.IsIngressRequest proves the request came from the Supervisor. An
// Ingress request without a usable header falls back to the same shared
// Supervisor key, preserving the previous behavior if the header is absent.
func requestKey(r *http.Request) string {
	fallback := bucketKey(auth.RemoteIP(r))
	if !auth.IsIngressRequest(r) {
		return fallback
	}
	id := strings.TrimSpace(r.Header.Get(ingressUserIDHeader))
	ingressHeaderLogged.Do(func() {
		present := "no"
		if id != "" {
			present = "yes"
		}
		// Deliberately no id in the log: the live check only needs presence.
		log.Printf("ratelimit: ingress user header present: %s", present)
	})
	if !validIngressUserID(id) {
		return fallback
	}
	return ingressUserKeyPrefix + id
}

// validIngressUserID reports whether id is safe to append to a bucket key:
// non-empty and at most maxIngressUserIDLen printable ASCII bytes. Rejecting
// anything else keeps a header from creating arbitrary-sized or non-printable
// map keys.
func validIngressUserID(id string) bool {
	if id == "" || len(id) > maxIngressUserIDLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		if id[i] < ' ' || id[i] > '~' {
			return false
		}
	}
	return true
}
