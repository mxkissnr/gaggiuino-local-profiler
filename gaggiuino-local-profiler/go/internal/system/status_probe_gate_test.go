package system

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// #1626: GET /api/status answers without a token, but only a caller with the
// token or one arriving through HA Ingress may make it live-probe a machine.
// The fake adapter's probe always fails, so a probe shows up as
// machineReachable=false; an unauthenticated caller instead gets the
// machine's last polled state, which is "unknown" (null) here because the
// machine was never polled.
func TestGetStatus_MachineIdProbeNeedsTokenOrIngress(t *testing.T) {
	p, registry, fake, sqlDB := newMultiMachinePoller(t)
	m2 := addOtherMachine(t, registry, "Second", "gaggiuino", "machine2.test", true)
	fake.setStatus(machines.Status{}, errors.New("connection refused"))
	mux := newSystemMux(NewHandlers(p, NewDemoService(sqlDB, shots.NewRepository(sqlDB), nil), testAPIToken))
	path := fmt.Sprintf("/api/status?machineId=%d", m2.ID)

	get := func(prepare func(*http.Request)) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		prepare(req)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
		return decodeMap(t, rec.Body.Bytes())
	}

	if got := get(func(*http.Request) {})["machineReachable"]; got != nil {
		t.Fatalf("unauthenticated machineReachable = %v, want null (no live probe)", got)
	}
	if got := get(func(r *http.Request) { r.Header.Set("X-GLP-Token", "wrong") })["machineReachable"]; got != nil {
		t.Fatalf("wrong-token machineReachable = %v, want null (no live probe)", got)
	}
	if got := get(func(r *http.Request) { r.Header.Set("X-GLP-Token", testAPIToken) })["machineReachable"]; got != false {
		t.Fatalf("token machineReachable = %v, want false (live probe ran)", got)
	}
	ingress := func(r *http.Request) {
		r.RemoteAddr = "172.30.32.2:12345"
		r.Header.Set("X-Ingress-Path", "/api/hassio_ingress/faketoken")
	}
	if got := get(ingress)["machineReachable"]; got != false {
		t.Fatalf("ingress machineReachable = %v, want false (live probe ran)", got)
	}
}

// An unauthenticated caller still sees the machine's polled reachability,
// just not a fresh probe of it.
func TestGetStatus_MachineIdWithoutTokenUsesPolledState(t *testing.T) {
	p, registry, _, sqlDB := newMultiMachinePoller(t)
	m2 := addOtherMachine(t, registry, "Second", "gaggiuino", "machine2.test", true)
	p.recordMachineError(m2.ID, errors.New("machine 2 down"))
	mux := newSystemMux(NewHandlers(p, NewDemoService(sqlDB, shots.NewRepository(sqlDB), nil), testAPIToken))

	body := decodeMap(t, doGet(mux, fmt.Sprintf("/api/status?machineId=%d", m2.ID)).Body.Bytes())
	if body["machineReachable"] != false {
		t.Fatalf("machineReachable = %v, want false (polled state)", body["machineReachable"])
	}
	if _, ok := body["lastMachineError"]; ok {
		t.Fatalf("lastMachineError present for an unauthenticated caller: %v", body["lastMachineError"])
	}
}
