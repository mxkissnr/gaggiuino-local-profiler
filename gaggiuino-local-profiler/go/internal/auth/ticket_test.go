package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// #1626: GET /api/events takes a short-lived, single-use ?ticket= instead of
// the long-lived token.

func newTicketHandler(tickets *TicketStore) http.Handler {
	return RequireToken(testToken, tickets)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

func lanGet(h http.Handler, target string) int {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.RemoteAddr = "192.168.1.50:1234" // not Supervisor -> no Ingress bypass
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestTicket_AuthenticatesOneStreamOnly(t *testing.T) {
	tickets := NewTicketStore()
	h := newTicketHandler(tickets)
	ticket, err := tickets.Issue()
	if err != nil {
		t.Fatal(err)
	}
	if code := lanGet(h, "/api/events?ticket="+ticket); code != http.StatusOK {
		t.Fatalf("first use: status = %d, want 200", code)
	}
	if code := lanGet(h, "/api/events?ticket="+ticket); code != http.StatusUnauthorized {
		t.Fatalf("reuse: status = %d, want 401", code)
	}
}

func TestTicket_UnknownOrExpiredIsRefused(t *testing.T) {
	tickets := NewTicketStore()
	now := time.Unix(1_700_000_000, 0)
	tickets.now = func() time.Time { return now }
	h := newTicketHandler(tickets)

	if code := lanGet(h, "/api/events?ticket=not-a-ticket"); code != http.StatusUnauthorized {
		t.Fatalf("unknown ticket: status = %d, want 401", code)
	}
	ticket, err := tickets.Issue()
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(TicketTTL)
	if code := lanGet(h, "/api/events?ticket="+ticket); code != http.StatusUnauthorized {
		t.Fatalf("expired ticket: status = %d, want 401", code)
	}
}

func TestTicket_OnlyValidOnTheStream(t *testing.T) {
	tickets := NewTicketStore()
	h := newTicketHandler(tickets)
	ticket, err := tickets.Issue()
	if err != nil {
		t.Fatal(err)
	}
	if code := lanGet(h, "/api/shots?ticket="+ticket); code != http.StatusUnauthorized {
		t.Fatalf("ticket outside /api/events: status = %d, want 401", code)
	}
}

// A bad ticket is not rescued by a token= next to it: the long-lived token is
// never accepted in the query.
func TestTicket_BadTicketWithTokenIsRefused(t *testing.T) {
	h := newTicketHandler(NewTicketStore())
	if code := lanGet(h, "/api/events?ticket=bad&token="+testToken); code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", code)
	}
}

func TestTicketStore_BoundedAndEvictsOldest(t *testing.T) {
	tickets := NewTicketStore()
	now := time.Unix(1_700_000_000, 0)
	tickets.now = func() time.Time { return now }
	first, err := tickets.Issue()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxTickets; i++ {
		now = now.Add(time.Millisecond)
		if _, err := tickets.Issue(); err != nil {
			t.Fatal(err)
		}
	}
	if len(tickets.tickets) != maxTickets {
		t.Fatalf("outstanding tickets = %d, want %d", len(tickets.tickets), maxTickets)
	}
	if tickets.Consume(first) {
		t.Fatal("the oldest ticket survived past the store's bound")
	}
}

func TestTicketHandler_IssuesUsableTicket(t *testing.T) {
	tickets := NewTicketStore()
	rec := httptest.NewRecorder()
	TicketHandler(tickets).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/events/ticket", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	var body struct{ Ticket string }
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || len(body.Ticket) != 64 {
		t.Fatalf("body = %q (err %v), want a 64-char ticket", rec.Body.String(), err)
	}
	if !tickets.Consume(body.Ticket) {
		t.Fatal("issued ticket was not accepted")
	}
}

// The ticket endpoint itself needs the token like any other /api/ route.
func TestTicketRoute_RequiresToken(t *testing.T) {
	tickets := NewTicketStore()
	h := RequireToken(testToken, tickets)(TicketHandler(tickets))
	req := httptest.NewRequest(http.MethodPost, "/api/events/ticket", nil)
	req.RemoteAddr = "192.168.1.50:1234"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("without token: status = %d, want 401", rec.Code)
	}
}
