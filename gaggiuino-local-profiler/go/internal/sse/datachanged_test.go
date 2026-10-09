package sse

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// waitEvent returns the next event published to ch, failing the test if none
// arrives. The Hub delivers synchronously, so an expected event is already in
// the channel buffer when the publishing call returns.
func waitEvent(t *testing.T, ch <-chan Event) Event {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for a published event")
		return Event{}
	}
}

// expectNoEvent fails the test if any event is published to ch shortly after.
func expectNoEvent(t *testing.T, ch <-chan Event) {
	t.Helper()
	select {
	case ev := <-ch:
		t.Fatalf("unexpected event %+v (%T)", ev, ev.Data)
	case <-time.After(50 * time.Millisecond):
	}
}

func changedData(t *testing.T, ev Event) DataChanged {
	t.Helper()
	if ev.Type != EventDataChanged {
		t.Fatalf("event type = %q, want %q", ev.Type, EventDataChanged)
	}
	dc, ok := ev.Data.(DataChanged)
	if !ok {
		t.Fatalf("event data is %T, want DataChanged", ev.Data)
	}
	return dc
}

func TestDataChanges_MiddlewarePublishesOnSuccess(t *testing.T) {
	hub := NewHub()
	sub, unsub := hub.Subscribe()
	defer unsub()

	start := time.Now().UnixMilli()
	dc := NewDataChanges(hub, []string{"library"})

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/library/bean/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})
	h := dc.Middleware(map[string]Route{
		"POST /api/library/bean/{id}": {Kinds: []string{"library"}, WithID: true},
	})(mux)

	req := httptest.NewRequest(http.MethodPost, "/api/library/bean/42", nil)
	req.Header.Set(ClientIDHeader, "abc_DEF-123")
	h.ServeHTTP(httptest.NewRecorder(), req)

	got := changedData(t, waitEvent(t, sub))
	if got.Kind != "library" {
		t.Errorf("kind = %q, want library", got.Kind)
	}
	if got.ID != "42" {
		t.Errorf("id = %q, want 42", got.ID)
	}
	if got.Src != "abc_DEF-123" {
		t.Errorf("src = %q, want abc_DEF-123", got.Src)
	}
	if got.Rev < start {
		t.Errorf("rev = %d, want >= seed %d", got.Rev, start)
	}
}

func TestDataChanges_MiddlewarePublishesNothing(t *testing.T) {
	run := func(t *testing.T, method, muxPattern, requestPath string, routes map[string]Route, status int) {
		t.Helper()
		hub := NewHub()
		sub, unsub := hub.Subscribe()
		defer unsub()

		dc := NewDataChanges(hub, []string{"library"})
		mux := http.NewServeMux()
		mux.HandleFunc(muxPattern, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
		})
		h := dc.Middleware(routes)(mux)
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(method, requestPath, nil))
		expectNoEvent(t, sub)
	}

	libraryRoute := map[string]Route{"POST /api/things": {Kinds: []string{"library"}}}

	t.Run("4xx", func(t *testing.T) {
		run(t, http.MethodPost, "POST /api/things", "/api/things", libraryRoute, http.StatusBadRequest)
	})
	t.Run("5xx", func(t *testing.T) {
		run(t, http.MethodPost, "POST /api/things", "/api/things", libraryRoute, http.StatusInternalServerError)
	})
	t.Run("get", func(t *testing.T) {
		run(t, http.MethodGet, "GET /api/things", "/api/things", libraryRoute, http.StatusOK)
	})
	t.Run("unmapped pattern", func(t *testing.T) {
		run(t, http.MethodPost, "POST /api/other", "/api/other", map[string]Route{}, http.StatusOK)
	})
}

func TestDataChanges_InvalidClientIDDropped(t *testing.T) {
	for _, id := range []string{"has space", "emoji😀", strings.Repeat("a", 65), "semi;colon"} {
		hub := NewHub()
		sub, unsub := hub.Subscribe()

		dc := NewDataChanges(hub, nil)
		mux := http.NewServeMux()
		mux.HandleFunc("POST /api/x", func(w http.ResponseWriter, r *http.Request) {})
		h := dc.Middleware(map[string]Route{"POST /api/x": {Kinds: []string{"library"}}})(mux)

		req := httptest.NewRequest(http.MethodPost, "/api/x", nil)
		req.Header.Set(ClientIDHeader, id)
		h.ServeHTTP(httptest.NewRecorder(), req)

		got := changedData(t, waitEvent(t, sub))
		if got.Src != "" {
			t.Errorf("client id %q: src = %q, want empty", id, got.Src)
		}
		unsub()
	}
}

func TestDataChanges_WithIDFalseLeavesIDEmpty(t *testing.T) {
	hub := NewHub()
	sub, unsub := hub.Subscribe()
	defer unsub()

	dc := NewDataChanges(hub, []string{"shots"})
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/shots/{id}/trash", func(w http.ResponseWriter, r *http.Request) {})
	h := dc.Middleware(map[string]Route{
		"POST /api/shots/{id}/trash": {Kinds: []string{"shots"}},
	})(mux)

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/shots/7/trash", nil))

	got := changedData(t, waitEvent(t, sub))
	if got.Kind != "shots" {
		t.Errorf("kind = %q, want shots", got.Kind)
	}
	if got.ID != "" {
		t.Errorf("id = %q, want empty for a WithID=false route", got.ID)
	}
}

func TestDataChanges_MultiKindPublishesInTableOrder(t *testing.T) {
	hub := NewHub()
	sub, unsub := hub.Subscribe()
	defer unsub()

	dc := NewDataChanges(hub, []string{"library", "maintenance"})
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/library/grinder/{id}/delete", func(w http.ResponseWriter, r *http.Request) {})
	h := dc.Middleware(map[string]Route{
		"POST /api/library/grinder/{id}/delete": {Kinds: []string{"library", "maintenance"}},
	})(mux)

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/library/grinder/3/delete", nil))

	first := changedData(t, waitEvent(t, sub))
	second := changedData(t, waitEvent(t, sub))
	if first.Kind != "library" || second.Kind != "maintenance" {
		t.Errorf("kinds = %q then %q, want library then maintenance", first.Kind, second.Kind)
	}
	// Each kind has its own counter seeded at the same instant, so the two revs
	// may be equal; their relative order across kinds is not meaningful, only
	// that each kind's own counter advanced.
	if first.Rev <= 0 || second.Rev <= 0 {
		t.Errorf("revs = %d then %d, want both positive", first.Rev, second.Rev)
	}
}

func TestDataChanges_RevsSeedAndGrow(t *testing.T) {
	hub := NewHub()
	start := time.Now().UnixMilli()
	dc := NewDataChanges(hub, []string{"library", "shots"})

	for _, kind := range []string{"library", "shots"} {
		if got := dc.Revs()[kind]; got < start {
			t.Errorf("seed rev for %s = %d, want >= start %d", kind, got, start)
		}
	}

	before := dc.Revs()["library"]
	dc.Publish("library", "", "")
	after := dc.Revs()["library"]
	if after != before+1 {
		t.Errorf("rev after one publish = %d, want %d", after, before+1)
	}

	dc.Publish("brand-new", "", "")
	if got := dc.Revs()["brand-new"]; got != 1 {
		t.Errorf("unknown kind rev = %d, want 1", got)
	}

	snapshot := dc.Revs()
	snapshot["library"] = -1
	if got := dc.Revs()["library"]; got != after {
		t.Errorf("Revs() leaked its backing map: library = %d, want %d", got, after)
	}
}

func TestDataChanges_AllBumpsEveryKind(t *testing.T) {
	hub := NewHub()
	sub, unsub := hub.Subscribe()
	defer unsub()

	kinds := []string{"library", "shots", "orders"}
	dc := NewDataChanges(hub, kinds)
	before := dc.Revs()

	dc.Publish(KindAll, "", "t9")

	after := dc.Revs()
	for _, kind := range kinds {
		if after[kind] != before[kind]+1 {
			t.Errorf("rev for %s = %d, want %d", kind, after[kind], before[kind]+1)
		}
	}

	got := changedData(t, waitEvent(t, sub))
	if got.Kind != KindAll {
		t.Errorf("kind = %q, want %q", got.Kind, KindAll)
	}
	if got.Src != "t9" {
		t.Errorf("src = %q, want t9", got.Src)
	}
	if got.Rev != 0 || got.ID != "" {
		t.Errorf("all event = %+v, want no rev and no id", got)
	}
}

func TestStatusWriter_ResponseControllerFlush(t *testing.T) {
	rec := httptest.NewRecorder()
	sw := &statusWriter{w: rec}
	if err := http.NewResponseController(sw).Flush(); err != nil {
		t.Fatalf("Flush through the wrapper: %v", err)
	}
	if !rec.Flushed {
		t.Error("underlying recorder was not flushed")
	}
}

func TestStatusWriter_StatusCaptured(t *testing.T) {
	rec := httptest.NewRecorder()
	sw := &statusWriter{w: rec}
	if _, err := sw.Write([]byte("x")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if sw.status != http.StatusOK {
		t.Errorf("status after Write = %d, want 200", sw.status)
	}
	sw.WriteHeader(http.StatusTeapot)
	if sw.status != http.StatusOK {
		t.Errorf("status after a later WriteHeader = %d, want the first write's 200", sw.status)
	}
}
