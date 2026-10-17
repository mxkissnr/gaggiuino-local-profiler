package auth

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"sync"
	"time"
)

// #1626: EventSource cannot send a header, so GET /api/events used to take the
// long-lived API token as ?token=, where it can end up in proxy logs and
// browser tooling. A client now trades its token (sent as the usual header)
// for a short-lived, single-use ticket and puts only that in the stream URL.
//
// TicketTTL is how long a ticket stays valid after it is issued; a client asks
// for one right before it opens the stream, so a few seconds of latency is all
// it has to cover. maxTickets bounds the store: a client that keeps asking
// without connecting only evicts its own oldest tickets.
const (
	TicketTTL  = 30 * time.Second
	maxTickets = 256
)

// TicketStore holds the outstanding SSE tickets in memory. Tickets do not
// survive a restart, which is fine: a client reconnecting after one asks for a
// fresh ticket anyway.
type TicketStore struct {
	mu      sync.Mutex
	tickets map[string]time.Time // ticket -> expiry

	// now is a test seam; nil means time.Now.
	now func() time.Time
}

// NewTicketStore returns an empty TicketStore.
func NewTicketStore() *TicketStore {
	return &TicketStore{tickets: make(map[string]time.Time)}
}

func (s *TicketStore) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// Issue creates a new random ticket valid for TicketTTL.
func (s *TicketStore) Issue() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	ticket := hex.EncodeToString(b)

	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	for t, exp := range s.tickets {
		if !now.Before(exp) {
			delete(s.tickets, t)
		}
	}
	for len(s.tickets) >= maxTickets {
		var oldest string
		var oldestExp time.Time
		for t, exp := range s.tickets {
			if oldest == "" || exp.Before(oldestExp) {
				oldest, oldestExp = t, exp
			}
		}
		delete(s.tickets, oldest)
	}
	s.tickets[ticket] = now.Add(TicketTTL)
	return ticket, nil
}

// Consume reports whether ticket is outstanding and unexpired, and removes it
// either way, so a ticket authenticates at most one stream.
func (s *TicketStore) Consume(ticket string) bool {
	if s == nil || ticket == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	exp, ok := s.tickets[ticket]
	if !ok {
		return false
	}
	delete(s.tickets, ticket)
	return s.clock().Before(exp)
}

// TicketHandler serves POST /api/events/ticket: `{"ticket": "..."}`. It sits
// behind RequireToken like every other /api/ route, so only a caller with the
// token (or one arriving through HA Ingress) gets a ticket.
func TicketHandler(s *TicketStore) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ticket, err := s.Issue()
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not issue a ticket")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte(`{"ticket":"` + ticket + `"}`))
	})
}
