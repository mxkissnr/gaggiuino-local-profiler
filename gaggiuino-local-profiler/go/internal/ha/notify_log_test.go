package ha

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"strings"
	"testing"
)

// TestSendNotify_LogsFailure guards #1625: every SendNotify caller discards
// the returned error, so a failing notify service must leave a log line or it
// stays invisible.
func TestSendNotify_LogsFailure(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/services/notify/mobile_app_test" {
			t.Errorf("path = %s, want /api/services/notify/mobile_app_test", r.URL.Path)
		}
		w.WriteHeader(http.StatusInternalServerError)
	})

	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })

	err := c.SendNotify(context.Background(), "notify.mobile_app_test", "title", "message", "")
	if err == nil {
		t.Fatal("SendNotify against a 500: want an error, got nil")
	}
	got := buf.String()
	if !strings.Contains(got, "notify.mobile_app_test") || !strings.Contains(got, "failed") {
		t.Fatalf("log output = %q, want it to record the failed notify service", got)
	}
}
