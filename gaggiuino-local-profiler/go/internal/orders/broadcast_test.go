package orders

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestBroadcastShopState_OpenedSendsNotify exercises the #901 Phase 1g
// closure of this domain's shop-open/shop-closed HA-notify broadcast
// deferral: flipping `enabled` false->true with a configured
// broadcastRecipients entry must fire a notify.* HA service call, with the
// "ready" wording when the wired PreheatInfoFunc reports the machine ready.
func TestBroadcastShopState_OpenedSendsNotify(t *testing.T) {
	var mu sync.Mutex
	var gotMessage string
	haSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/services/notify/mobile_app_test":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			gotMessage, _ = body["message"].(string)
			mu.Unlock()
		case "/api/states":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`[]`)) // no person entities -> every recipient stays included
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer haSrv.Close()
	t.Setenv("SUPERVISOR_TOKEN", "")
	t.Setenv("GLP_HA_URL", haSrv.URL)
	t.Setenv("GLP_HA_TOKEN", "test-token")

	h, repo, _ := newTestHandlers(t)
	h.SetPreheatInfoProvider(func() (bool, int) { return true, 0 })
	if err := repo.SaveSettings(Settings{"enabled": false}); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/orders/settings",
		[]byte(`{"enabled":true,"broadcastRecipients":["notify.mobile_app_test"]}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		got := gotMessage
		mu.Unlock()
		if got != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if gotMessage == "" {
		t.Fatal("expected a notify.mobile_app_test call, got none")
	}
	if !strings.Contains(gotMessage, "bereit") {
		t.Errorf("message = %q, want the 'ready' wording (PreheatInfoFunc reports ready=true)", gotMessage)
	}
}

// TestBroadcastShopState_NoRecipients_NeverCallsHA guards against a
// regression where an empty broadcastRecipients still fires a request.
func TestBroadcastShopState_NoRecipients_NeverCallsHA(t *testing.T) {
	called := false
	haSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	defer haSrv.Close()
	t.Setenv("SUPERVISOR_TOKEN", "")
	t.Setenv("GLP_HA_URL", haSrv.URL)
	t.Setenv("GLP_HA_TOKEN", "test-token")

	h, repo, _ := newTestHandlers(t)
	if err := repo.SaveSettings(Settings{"enabled": false}); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	mux := newMux(h)
	rec := doJSON(t, mux, http.MethodPost, "/api/orders/settings", []byte(`{"enabled":true}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	time.Sleep(50 * time.Millisecond) // give a wrongly-fired goroutine a chance to hit the fake server
	if called {
		t.Error("HA server was called despite no broadcastRecipients being configured")
	}
}
