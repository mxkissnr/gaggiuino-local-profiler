package ha

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newTestClient points a Client at a fake HA REST API — same
// GLP_HA_URL/GLP_HA_TOKEN env-var path a standalone-Docker install uses
// (#764), so NewClientFromEnv's real derivation logic is exercised rather
// than bypassed.
func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	t.Setenv("SUPERVISOR_TOKEN", "")
	t.Setenv("GLP_HA_URL", srv.URL)
	t.Setenv("GLP_HA_TOKEN", "test-token")
	return NewClientFromEnv()
}

func TestGetSwitchState(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/states/switch.machine" {
			t.Errorf("path = %s, want /api/states/switch.machine", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q", got)
		}
		json.NewEncoder(w).Encode(map[string]string{"state": "on"})
	})
	on := c.GetSwitchState(context.Background(), "switch.machine")
	if on == nil || !*on {
		t.Fatalf("GetSwitchState = %v, want true", on)
	}
}

func TestGetSwitchState_NoEntity_ReturnsNil(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("should not make a request with no entity")
	})
	if got := c.GetSwitchState(context.Background(), ""); got != nil {
		t.Errorf("GetSwitchState('') = %v, want nil", got)
	}
}

func TestGetSwitchState_Disabled_ReturnsNil(t *testing.T) {
	t.Setenv("SUPERVISOR_TOKEN", "")
	t.Setenv("GLP_HA_URL", "")
	c := NewClientFromEnv()
	if got := c.GetSwitchState(context.Background(), "switch.machine"); got != nil {
		t.Errorf("GetSwitchState on a disabled client = %v, want nil", got)
	}
	if c.Enabled() {
		t.Error("Enabled() = true, want false with no token configured")
	}
}

func TestCallHaService_Success(t *testing.T) {
	var gotBody map[string]any
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/services/switch/turn_on" {
			t.Errorf("path = %s", r.URL.Path)
		}
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	})
	err := c.CallHaService(context.Background(), "switch", "turn_on", map[string]any{"entity_id": "switch.machine"})
	if err != nil {
		t.Fatalf("CallHaService: %v", err)
	}
	if gotBody["entity_id"] != "switch.machine" {
		t.Errorf("posted body = %v", gotBody)
	}
}

func TestCallHaService_Disabled_ReturnsError(t *testing.T) {
	t.Setenv("SUPERVISOR_TOKEN", "")
	t.Setenv("GLP_HA_URL", "")
	c := NewClientFromEnv()
	if err := c.CallHaService(context.Background(), "switch", "turn_on", nil); err == nil {
		t.Error("expected an error when no HA token is configured")
	}
}

func TestGetHaLanguage_CachesAndFallsBackToEnglish(t *testing.T) {
	calls := 0
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		json.NewEncoder(w).Encode(map[string]string{"language": "de-DE"})
	})
	lang := c.GetHaLanguage(context.Background())
	if lang != "de" {
		t.Fatalf("GetHaLanguage = %q, want de", lang)
	}
	c.GetHaLanguage(context.Background())
	if calls != 1 {
		t.Errorf("expected exactly one HTTP call (cached after that), got %d", calls)
	}
}

func TestGetHaLanguage_UnrecognizedFallsBackToEnglish(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"language": "zz"})
	})
	if lang := c.GetHaLanguage(context.Background()); lang != "en" {
		t.Errorf("GetHaLanguage = %q, want en for an unrecognized language", lang)
	}
}
