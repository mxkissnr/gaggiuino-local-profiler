package machines

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// recordingAdapter counts the calls the default machine's adapter receives,
// so a rejected request can be proven to have touched no adapter at all.
// Every method the tests below do not expect panics via fakePanicAdapter.
type recordingAdapter struct {
	fakePanicAdapter
	calls atomic.Int32
}

var _ Adapter = (*recordingAdapter)(nil)

func (a *recordingAdapter) Capabilities() Capabilities {
	return Capabilities{SettingsProxy: true, ProfileEdit: true}
}

func (a *recordingAdapter) GetSettings(context.Context, *Machine, string) (json.RawMessage, error) {
	a.calls.Add(1)
	return json.RawMessage(`{}`), nil
}

func (a *recordingAdapter) SaveSettings(context.Context, *Machine) error {
	a.calls.Add(1)
	return nil
}

func (a *recordingAdapter) SetOperationMode(context.Context, *Machine, proto.OperationMode) error {
	a.calls.Add(1)
	return nil
}

func (a *recordingAdapter) DeleteProfile(context.Context, *Machine, string) ([]ProfileSummary, error) {
	a.calls.Add(1)
	return nil, nil
}

// TestUnknownMachine_MutatingRequestsRejected is #1605's regression test: a
// mutating request that names a machine that does not exist (or an
// unparseable machineId) must be rejected with 404/400 instead of silently
// acting on the default machine, and must not reach that machine's adapter at
// all. GET keeps the old lenient fallback.
func TestUnknownMachine_MutatingRequestsRejected(t *testing.T) {
	h, registry, _ := newTestHandlers(t)
	mux := newMux(h)
	if _, err := registry.GetDefaultMachine(); err != nil { // seed default machine #1
		t.Fatalf("GetDefaultMachine: %v", err)
	}
	rec := &recordingAdapter{}
	h.gaggiuino = rec

	cases := []struct {
		name   string
		method string
		path   string
		body   string
		want   int
	}{
		{"opmode unknown", http.MethodPost, "/api/machine/opmode", `{"machineId":999}`, http.StatusNotFound},
		{"settings save unknown", http.MethodPost, "/api/machine/settings/save", `{"machineId":999}`, http.StatusNotFound},
		{"profile delete unknown", http.MethodDelete, "/api/machine/profile/1", `{"machineId":999}`, http.StatusNotFound},
		{"profile delete unparseable query", http.MethodDelete, "/api/machine/profile/1?machineId=abc", ``, http.StatusBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var r *http.Request
			if c.body != "" {
				r = httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
			} else {
				r = httptest.NewRequest(c.method, c.path, nil)
			}
			recv := doRequest(mux, r)
			if recv.Code != c.want {
				t.Fatalf("%s %s status = %d, want %d, body=%s", c.method, c.path, recv.Code, c.want, recv.Body)
			}
		})
	}

	if got := rec.calls.Load(); got != 0 {
		t.Fatalf("default machine adapter was called %d times on rejected requests, want 0", got)
	}

	// GET stays lenient: an unknown machineId still answers from the default machine.
	recv := doRequest(mux, httptest.NewRequest(http.MethodGet, "/api/machine/settings?machineId=999", nil))
	if recv.Code != http.StatusOK {
		t.Fatalf("GET settings with unknown machineId status = %d, want 200, body=%s", recv.Code, recv.Body)
	}
	if got := rec.calls.Load(); got != 1 {
		t.Fatalf("default machine adapter GetSettings calls = %d, want 1", got)
	}
}
