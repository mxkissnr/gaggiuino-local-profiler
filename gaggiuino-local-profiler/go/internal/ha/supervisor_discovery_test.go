package ha

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeUUID is the deterministic id the fake Supervisor hands out; a real one
// returns 32 lowercase hex characters.
const fakeUUID = "0123456789abcdef0123456789abcdef"

const announcedLog = "announced the app to Home Assistant"
const announceFailedLog = "announcing the app to Home Assistant failed"
const withdrawFailedLog = "withdrawing the announcement failed"

// recordedRequest is one request the fake Supervisor received.
type recordedRequest struct {
	Method string
	Path   string
	Auth   string
	Body   map[string]any
}

// fakeSupervisor mimics the Supervisor's /discovery endpoints: POST adds a
// uuid (or returns the existing one, as the Supervisor de-duplicates per
// app and service) and DELETE removes it. A non-zero status or a non-empty
// body replaces the response; blockAnnounce/blockDelete hold the matching
// handler open until the channel is closed.
type fakeSupervisor struct {
	srv *httptest.Server

	mu       sync.Mutex
	requests []recordedRequest
	active   map[string]bool

	status int
	body   string

	blockAnnounce chan struct{}
	blockDelete   chan struct{}

	posted     chan struct{}
	postedOnce sync.Once
}

func newFakeSupervisor(t *testing.T) *fakeSupervisor {
	t.Helper()
	f := &fakeSupervisor{active: map[string]bool{}, posted: make(chan struct{})}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

// configure mutates the fake under its lock, so the handler goroutine never
// races with the test.
func (f *fakeSupervisor) configure(fn func(*fakeSupervisor)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *fakeSupervisor) handle(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<16)); len(b) > 0 {
		json.Unmarshal(b, &body)
	}

	f.mu.Lock()
	f.requests = append(f.requests, recordedRequest{
		Method: r.Method,
		Path:   r.URL.Path,
		Auth:   r.Header.Get("Authorization"),
		Body:   body,
	})
	status, respBody := f.status, f.body
	blockAnnounce, blockDelete := f.blockAnnounce, f.blockDelete
	f.mu.Unlock()
	f.postedOnce.Do(func() { close(f.posted) })

	if status != 0 || respBody != "" {
		if status != 0 {
			w.WriteHeader(status)
		}
		io.WriteString(w, respBody)
		return
	}

	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/discovery":
		if blockAnnounce != nil {
			<-blockAnnounce
		}
		f.mu.Lock()
		uuid := ""
		for id := range f.active {
			uuid = id
			break
		}
		if uuid == "" {
			uuid = fakeUUID
			f.active[uuid] = true
		}
		f.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"result": "ok", "data": map[string]any{"uuid": uuid}})
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/discovery/"):
		if blockDelete != nil {
			<-blockDelete
		}
		f.mu.Lock()
		delete(f.active, strings.TrimPrefix(r.URL.Path, "/discovery/"))
		f.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"result": "ok", "data": map[string]any{}})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// newSupervisorTestClient derives a Client through the env-var path a
// Supervisor install takes, then points it at the fake Supervisor.
func newSupervisorTestClient(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	t.Setenv("SUPERVISOR_TOKEN", "sup-token")
	t.Setenv("GLP_HA_URL", "")
	c := NewClientFromEnv()
	if c.supervisorBase != supervisorURL {
		t.Fatalf("supervisorBase = %q, want %q on a Supervisor install", c.supervisorBase, supervisorURL)
	}
	c.supervisorBase = srv.URL
	return c
}

// logCapture collects log output; safe to read while the discovery goroutine
// writes to it.
type logCapture struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *logCapture) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *logCapture) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func captureLogs(t *testing.T) *logCapture {
	t.Helper()
	c := &logCapture{}
	prev := log.Writer()
	log.SetOutput(c)
	t.Cleanup(func() { log.SetOutput(prev) })
	return c
}

func (f *fakeSupervisor) count(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, r := range f.requests {
		if method == "" || r.Method == method {
			n++
		}
	}
	return n
}

func (f *fakeSupervisor) byMethod(method string) []recordedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []recordedRequest
	for _, r := range f.requests {
		if r.Method == method {
			out = append(out, r)
		}
	}
	return out
}

func (f *fakeSupervisor) activeUUIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.active))
	for id := range f.active {
		out = append(out, id)
	}
	return out
}

func (f *fakeSupervisor) waitPosted(t *testing.T) {
	t.Helper()
	select {
	case <-f.posted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the discovery POST")
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// waitAnnounced blocks until the goroutine has recorded a successful announce,
// which is the only point where the withdraw becomes deterministic.
func waitAnnounced(t *testing.T, logs *logCapture, n int) {
	t.Helper()
	waitFor(t, "the announce log line", func() bool {
		return strings.Count(logs.String(), announcedLog) >= n
	})
}

func isClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func waitClosed(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("discovery done channel did not close")
	}
}

func assertKeys(t *testing.T, m map[string]any, want ...string) {
	t.Helper()
	if len(m) != len(want) {
		t.Fatalf("keys = %v, want exactly %v", m, want)
	}
	for _, k := range want {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing key %q in %v", k, m)
		}
	}
}

func TestStartSupervisorDiscovery_Announces(t *testing.T) {
	f := newFakeSupervisor(t)
	c := newSupervisorTestClient(t, f.srv)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := c.StartSupervisorDiscovery(ctx, "abc-gaggiuino-local-profiler", 8099)
	f.waitPosted(t)
	cancel()
	waitClosed(t, done)

	posts := f.byMethod(http.MethodPost)
	if len(posts) != 1 {
		t.Fatalf("POSTs = %d, want 1", len(posts))
	}
	p := posts[0]
	if p.Path != "/discovery" {
		t.Errorf("path = %q, want /discovery", p.Path)
	}
	if p.Auth != "Bearer sup-token" {
		t.Errorf("Authorization = %q", p.Auth)
	}
	assertKeys(t, p.Body, "service", "config")
	if p.Body["service"] != DiscoveryService {
		t.Errorf("service = %v, want %q", p.Body["service"], DiscoveryService)
	}
	cfg, ok := p.Body["config"].(map[string]any)
	if !ok {
		t.Fatalf("config = %#v, want an object", p.Body["config"])
	}
	assertKeys(t, cfg, "host", "port")
	if cfg["host"] != "abc-gaggiuino-local-profiler" {
		t.Errorf("host = %v", cfg["host"])
	}
	if port, ok := cfg["port"].(float64); !ok || port != 8099 {
		t.Errorf("port = %#v, want the JSON number 8099", cfg["port"])
	}
}

func TestStartSupervisorDiscovery_RejectsBadUUID(t *testing.T) {
	for name, bad := range map[string]string{"path": "../addons/self", "empty": ""} {
		t.Run(name, func(t *testing.T) {
			f := newFakeSupervisor(t)
			f.configure(func(f *fakeSupervisor) {
				f.body = `{"result":"ok","data":{"uuid":"` + bad + `"}}`
			})
			c := newSupervisorTestClient(t, f.srv)

			if _, err := c.announceDiscovery(context.Background(), "glp", 8099); err == nil {
				t.Fatal("announceDiscovery with a malformed id: want an error, got nil")
			}

			done := c.StartSupervisorDiscovery(context.Background(), "glp", 8099)
			waitClosed(t, done)
			if n := f.count(http.MethodDelete); n != 0 {
				t.Errorf("DELETEs = %d, want 0 after a rejected id", n)
			}
		})
	}
}

func TestStartSupervisorDiscovery_HidesSecretsOnFailure(t *testing.T) {
	f := newFakeSupervisor(t)
	f.configure(func(f *fakeSupervisor) {
		f.status = http.StatusForbidden
		f.body = "secret-body"
	})
	c := newSupervisorTestClient(t, f.srv)
	logs := captureLogs(t)

	done := c.StartSupervisorDiscovery(context.Background(), "glp", 8099)
	waitClosed(t, done)

	err := c.announceDiscovery(context.Background(), "glp", 8099)
	if err == nil {
		t.Fatal("announceDiscovery against a 403: want an error, got nil")
	}
	for _, secret := range []string{"sup-token", "secret-body"} {
		if strings.Contains(err.Error(), secret) {
			t.Errorf("error text leaked %q: %v", secret, err)
		}
		if strings.Contains(logs.String(), secret) {
			t.Errorf("log output leaked %q: %q", secret, logs.String())
		}
	}
	if !strings.Contains(logs.String(), announceFailedLog) {
		t.Fatalf("log output = %q, want the announce failure line", logs.String())
	}
}

func TestStartSupervisorDiscovery_WithdrawsOnShutdown(t *testing.T) {
	f := newFakeSupervisor(t)
	c := newSupervisorTestClient(t, f.srv)
	logs := captureLogs(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := c.StartSupervisorDiscovery(ctx, "glp", 8099)
	waitAnnounced(t, logs, 1)
	cancel()
	waitClosed(t, done)

	deletes := f.byMethod(http.MethodDelete)
	if len(deletes) != 1 {
		t.Fatalf("DELETEs = %d, want 1", len(deletes))
	}
	if deletes[0].Path != "/discovery/"+fakeUUID {
		t.Errorf("path = %q, want /discovery/%s", deletes[0].Path, fakeUUID)
	}
	if deletes[0].Auth != "Bearer sup-token" {
		t.Errorf("Authorization = %q", deletes[0].Auth)
	}
	if got := f.activeUUIDs(); len(got) != 0 {
		t.Errorf("active ids after withdraw = %v, want none", got)
	}
}

func TestStartSupervisorDiscovery_RestartKeepsOneMessage(t *testing.T) {
	f := newFakeSupervisor(t)
	c := newSupervisorTestClient(t, f.srv)
	logs := captureLogs(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := c.StartSupervisorDiscovery(ctx, "glp", 8099)
	waitAnnounced(t, logs, 1)
	cancel()
	waitClosed(t, done)

	ctx2, cancel2 := context.WithCancel(context.Background())
	done2 := c.StartSupervisorDiscovery(ctx2, "glp", 8099)
	waitAnnounced(t, logs, 2)
	if got := f.activeUUIDs(); len(got) != 1 {
		t.Fatalf("active ids after the second announce = %v, want exactly one", got)
	}
	cancel2()
	waitClosed(t, done2)
	if got := f.activeUUIDs(); len(got) != 0 {
		t.Errorf("active ids after the second withdraw = %v, want none", got)
	}
}

func TestStartSupervisorDiscovery_DoesNotBlock(t *testing.T) {
	f := newFakeSupervisor(t)
	release := make(chan struct{})
	defer close(release)
	f.configure(func(f *fakeSupervisor) { f.blockAnnounce = release })
	c := newSupervisorTestClient(t, f.srv)
	logs := captureLogs(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	start := time.Now()
	done := c.StartSupervisorDiscovery(ctx, "glp", 8099)
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("StartSupervisorDiscovery blocked for %v", elapsed)
	}
	f.waitPosted(t)
	cancel()
	waitClosed(t, done)
	if n := f.count(http.MethodDelete); n != 0 {
		t.Errorf("DELETEs = %d, want 0 when the announce never completed", n)
	}
	if strings.Contains(logs.String(), announceFailedLog) {
		t.Errorf("a cancelled announce must not log a failure: %q", logs.String())
	}
}

func TestStartSupervisorDiscovery_WithdrawIsBounded(t *testing.T) {
	f := newFakeSupervisor(t)
	release := make(chan struct{})
	defer close(release)
	f.configure(func(f *fakeSupervisor) { f.blockDelete = release })
	c := newSupervisorTestClient(t, f.srv)
	logs := captureLogs(t)

	prev := withdrawTimeout
	withdrawTimeout = 50 * time.Millisecond
	t.Cleanup(func() { withdrawTimeout = prev })

	ctx, cancel := context.WithCancel(context.Background())
	done := c.StartSupervisorDiscovery(ctx, "glp", 8099)
	waitAnnounced(t, logs, 1)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("done did not close within the withdraw timeout")
	}
	waitFor(t, "the withdraw failure log line", func() bool {
		return strings.Contains(logs.String(), withdrawFailedLog)
	})
	if strings.Contains(logs.String(), "sup-token") {
		t.Errorf("log output leaked the token: %q", logs.String())
	}
}

func TestSupervisorDiscovery_StandaloneSendsNothing(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer other.Close()

	t.Setenv("SUPERVISOR_TOKEN", "")
	t.Setenv("GLP_HA_URL", other.URL)
	t.Setenv("GLP_HA_TOKEN", "user-token")
	c := NewClientFromEnv()
	if c.supervisorBase != "" {
		t.Fatalf("supervisorBase = %q, want empty on a standalone install", c.supervisorBase)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if done := c.StartSupervisorDiscovery(ctx, "glp", 8099); !isClosed(done) {
		t.Error("StartSupervisorDiscovery on a standalone install did not return a closed channel")
	}
	if err := c.SupervisorGet(context.Background(), "/services/mqtt", nil); !errors.Is(err, errNoSupervisor) {
		t.Errorf("SupervisorGet error = %v, want errNoSupervisor", err)
	}

	mu.Lock()
	got := calls
	mu.Unlock()
	if got != 0 {
		t.Errorf("requests to the standalone HA server = %d, want 0", got)
	}
}

func TestStartSupervisorDiscovery_InvalidInput(t *testing.T) {
	f := newFakeSupervisor(t)
	c := newSupervisorTestClient(t, f.srv)

	for _, tc := range []struct {
		host string
		port int
	}{
		{"", 8099},
		{"glp", 0},
		{"glp", 70000},
	} {
		ctx, cancel := context.WithCancel(context.Background())
		done := c.StartSupervisorDiscovery(ctx, tc.host, tc.port)
		if !isClosed(done) {
			t.Errorf("StartSupervisorDiscovery(%q, %d) did not return a closed channel", tc.host, tc.port)
		}
		cancel()
	}
	if n := f.count(""); n != 0 {
		t.Errorf("requests = %d, want 0 for unusable input", n)
	}
}
