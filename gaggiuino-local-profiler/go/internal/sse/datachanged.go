package sse

import (
	"net/http"
	"regexp"
	"sync"
	"time"
)

// The data-changed push (#1539): one SSE event per successful write telling
// open pages which kind of data changed. Unlike live-snapshot/preheat-update
// it carries no user data — only the kind, a monotonically increasing
// revision and (for a single entity) its id — so a client can refetch just
// that part of its state.
const EventDataChanged = "data-changed"

// KindAll is the DataChanged.Kind a whole-database change reports: the client
// refetches everything instead of one kind.
const KindAll = "all"

// ClientIDHeader is the request header a client sends to identify itself (a
// random per-page id) so it can skip the data-changed event its own write
// produced.
const ClientIDHeader = "X-GLP-Client"

// DataChanged is the payload of one EventDataChanged push. Kind is always set;
// Rev is present for a single-kind bump; ID only for a route that addresses one
// entity; Src only when the writing client sent a valid ClientIDHeader.
type DataChanged struct {
	Kind string `json:"kind"`
	Rev  int64  `json:"rev,omitempty"`
	ID   string `json:"id,omitempty"`
	Src  string `json:"src,omitempty"`
}

// Route classifies one write route: the kinds it changes, in table order, and
// whether its {id} path value addresses a single entity of those kinds.
type Route struct {
	Kinds  []string
	WithID bool
}

// DataChanges publishes data-changed events and tracks a revision per kind. One
// instance lives for the process lifetime; its revisions are seeded from the
// wall clock at start, so they are monotonic across restarts and exactly
// representable in JavaScript (Unix milliseconds are well inside 2^53).
type DataChanges struct {
	hub *Hub

	// mu serialises a revision bump with its Hub publish, so the order events
	// reach subscribers matches the order of their revisions.
	mu   sync.Mutex
	revs map[string]int64
}

// NewDataChanges returns a DataChanges publishing through hub, with a revision
// seeded for every kind in kinds. A kind not in kinds is added on first Publish.
func NewDataChanges(hub *Hub, kinds []string) *DataChanges {
	seed := time.Now().UnixMilli()
	revs := make(map[string]int64, len(kinds))
	for _, kind := range kinds {
		revs[kind] = seed
	}
	return &DataChanges{hub: hub, revs: revs}
}

// Publish bumps kind's revision and pushes one EventDataChanged. KindAll bumps
// every known kind and pushes a single {kind:"all"} event instead. The bump and
// the Hub publish happen under one lock, so delivery order matches revision
// order.
func (c *DataChanges) Publish(kind, id, src string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if kind == KindAll {
		for k := range c.revs {
			c.revs[k]++
		}
		c.hub.Publish(Event{Type: EventDataChanged, Data: DataChanged{Kind: KindAll, Src: src}})
		return
	}

	c.revs[kind]++
	c.hub.Publish(Event{
		Type: EventDataChanged,
		Data: DataChanged{Kind: kind, Rev: c.revs[kind], ID: id, Src: src},
	})
}

// Revs returns a copy of the current per-kind revisions.
func (c *DataChanges) Revs() map[string]int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]int64, len(c.revs))
	for k, v := range c.revs {
		out[k] = v
	}
	return out
}

// clientIDRe is the accepted shape of the X-GLP-Client header: a short opaque
// token a page generates for itself. Anything else is dropped rather than
// echoed back, so a hostile client cannot inject content into the event.
var clientIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// statusWriter records the status code a handler set. A Write without a prior
// WriteHeader counts as 200; the middleware reads status after ServeHTTP and
// treats a still-zero status as 200 too (net/http's own default).
type statusWriter struct {
	w      http.ResponseWriter
	status int
}

func (s *statusWriter) Header() http.Header { return s.w.Header() }

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.w.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.w.Write(b)
}

// Unwrap exposes the wrapped writer to http.ResponseController (and anything
// else that unwraps), so Flush/Hijack keep working through it.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.w }

// Middleware publishes a data-changed event for every write request that a
// route in routes matched and that finished with a 2xx status. GET/HEAD pass
// the original ResponseWriter through untouched; only the write methods are
// wrapped. The route lookup uses r.Pattern, which net/http's ServeMux sets on
// the request it hands to the handler, so the key is the registered pattern
// (e.g. "POST /api/library/bean/{id}"), never the raw path.
func (c *DataChanges) Middleware(routes map[string]Route) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
			default:
				next.ServeHTTP(w, r)
				return
			}

			sw := &statusWriter{w: w}
			next.ServeHTTP(sw, r)

			status := sw.status
			if status == 0 {
				status = http.StatusOK
			}
			if status < 200 || status >= 300 {
				return
			}
			route, ok := routes[r.Pattern]
			if !ok {
				return
			}

			id := ""
			if route.WithID {
				id = r.PathValue("id")
			}
			src := ""
			if v := r.Header.Get(ClientIDHeader); clientIDRe.MatchString(v) {
				src = v
			}
			for _, kind := range route.Kinds {
				c.Publish(kind, id, src)
			}
		})
	}
}
