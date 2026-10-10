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
	if got.Rev != 1 {
		t.Errorf("rev = %d, want 1 (the first change after the 0 seed)", got.Rev)
	}
	if got.Epoch != dc.Epoch || got.Epoch == "" {
		t.Errorf("epoch = %q, want %q", got.Epoch, dc.Epoch)
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
	// Each kind's counter starts at 0 independently, so both first changes are 1.
	if first.Rev != 1 || second.Rev != 1 {
		t.Errorf("revs = %d then %d, want both 1", first.Rev, second.Rev)
	}
}

func TestDataChanges_RevsStartAtZeroAndGrow(t *testing.T) {
	hub := NewHub()
	sub, unsub := hub.Subscribe()
	defer unsub()

	dc := NewDataChanges(hub, []string{"library", "shots"})

	dc.Publish("library", "", "")
	if got := changedData(t, waitEvent(t, sub)); got.Rev != 1 {
		t.Errorf("first library rev = %d, want 1 (the counter starts at 0)", got.Rev)
	}
	dc.Publish("library", "", "")
	if got := changedData(t, waitEvent(t, sub)); got.Rev != 2 {
		t.Errorf("second library rev = %d, want 2 (must grow strictly)", got.Rev)
	}

	dc.Publish("brand-new", "", "")
	if got := changedData(t, waitEvent(t, sub)); got.Rev != 1 {
		t.Errorf("unknown kind rev = %d, want 1", got.Rev)
	}
}

func TestDataChanges_AllBumpsEveryKind(t *testing.T) {
	hub := NewHub()
	sub, unsub := hub.Subscribe()
	defer unsub()

	dc := NewDataChanges(hub, []string{"library", "shots", "orders"})

	dc.Publish(KindAll, "", "t9")

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
	if got.Epoch != dc.Epoch || got.Epoch == "" {
		t.Errorf("all event epoch = %q, want %q", got.Epoch, dc.Epoch)
	}

	// Every seeded kind was bumped by the all event, so the next change to one of
	// them carries its second revision.
	dc.Publish("library", "", "")
	if next := changedData(t, waitEvent(t, sub)); next.Rev != 2 {
		t.Errorf("library rev after the all event = %d, want 2", next.Rev)
	}
}

func TestDataChanges_AllCarriesRevs(t *testing.T) {
	hub := NewHub()
	sub, unsub := hub.Subscribe()
	defer unsub()

	dc := NewDataChanges(hub, []string{"library", "shots", "orders"})

	// A change to one kind so the all event's revs are not all one.
	dc.Publish("library", "", "")
	_ = waitEvent(t, sub)

	dc.Publish(KindAll, "", "")
	got := changedData(t, waitEvent(t, sub))
	if got.Kind != KindAll {
		t.Fatalf("kind = %q, want %q", got.Kind, KindAll)
	}
	want := map[string]int64{"library": 2, "shots": 1, "orders": 1}
	if len(got.Revs) != len(want) {
		t.Fatalf("revs = %v, want %v", got.Revs, want)
	}
	for kind, rev := range want {
		if got.Revs[kind] != rev {
			t.Errorf("revs[%q] = %d, want %d", kind, got.Revs[kind], rev)
		}
	}
}

func TestDataChanges_IDPrefixPrepended(t *testing.T) {
	hub := NewHub()
	sub, unsub := hub.Subscribe()
	defer unsub()

	// The production shape of an image route: the single library-image kind,
	// with the client's cache key prefixed onto the event id.
	dc := NewDataChanges(hub, []string{"library-image"})
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/library/bean/{id}/image", func(w http.ResponseWriter, r *http.Request) {})
	h := dc.Middleware(map[string]Route{
		"POST /api/library/bean/{id}/image": {Kinds: []string{"library-image"}, WithID: true, IDPrefix: "bean:"},
	})(mux)

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/library/bean/7/image", nil))

	got := changedData(t, waitEvent(t, sub))
	if got.Kind != "library-image" {
		t.Errorf("kind = %q, want library-image", got.Kind)
	}
	if got.ID != "bean:7" {
		t.Errorf("id = %q, want bean:7", got.ID)
	}
}

func TestDataChanges_EpochIdentifiesInstance(t *testing.T) {
	hub := NewHub()
	sub, unsub := hub.Subscribe()
	defer unsub()

	dc := NewDataChanges(hub, []string{"library"})
	if dc.Epoch == "" {
		t.Fatal("Epoch is empty")
	}
	if len(dc.Epoch) != 16 {
		t.Errorf("Epoch %q length = %d, want 16 hex chars", dc.Epoch, len(dc.Epoch))
	}

	dc.Publish("library", "", "")
	first := changedData(t, waitEvent(t, sub))
	dc.Publish("library", "", "")
	second := changedData(t, waitEvent(t, sub))
	if first.Epoch != dc.Epoch || second.Epoch != dc.Epoch {
		t.Errorf("event epochs = %q then %q, want %q on both", first.Epoch, second.Epoch, dc.Epoch)
	}

	other := NewDataChanges(NewHub(), []string{"library"})
	if other.Epoch == dc.Epoch {
		t.Errorf("two instances share the epoch %q", dc.Epoch)
	}
}

func TestDataChanges_EarlyHintsDoesNotHideSuccess(t *testing.T) {
	hub := NewHub()
	sub, unsub := hub.Subscribe()
	defer unsub()

	dc := NewDataChanges(hub, []string{"library"})
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/things", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(103)
		w.WriteHeader(http.StatusOK)
	})
	h := dc.Middleware(map[string]Route{"POST /api/things": {Kinds: []string{"library"}}})(mux)

	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/things", nil))

	got := changedData(t, waitEvent(t, sub))
	if got.Kind != "library" {
		t.Errorf("kind = %q, want library after a 103 then a 200", got.Kind)
	}
}

func TestStatusWriter_ResponseControllerFlush(t *testing.T) {
	rec := httptest.NewRecorder()
	sw := &statusWriter{w: rec}
	if _, ok := http.ResponseWriter(sw).(http.Flusher); !ok {
		t.Fatal("statusWriter does not satisfy http.Flusher on a write route")
	}
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
