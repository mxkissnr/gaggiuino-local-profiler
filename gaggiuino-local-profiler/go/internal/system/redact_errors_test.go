package system

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// #1626: a machine error that reaches a client goes through the one shared
// redaction function, whether the poller recorded it or the ?machineId probe
// produced it on the spot. The probe path was not redacted at all before.

const leakyMachineErr = `Get "http://192.168.1.50/api/system/status": dial tcp 192.168.1.50:80: connect: connection refused`

func TestRecordMachineError_RedactsHostsAndURLs(t *testing.T) {
	p, registry, _, _ := newMultiMachinePoller(t)
	m2 := addOtherMachine(t, registry, "Second", "gaggimate", "machine2.test", true)

	p.recordMachineError(m2.ID, errors.New(`ws://machine2.test/ws: dial tcp 10.0.0.9:80: i/o timeout`))

	got := p.MachineStatus(m2.ID).LastError
	if got == nil {
		t.Fatal("LastError = nil, want the redacted error")
	}
	if want := "[url]: dial tcp [host]: i/o timeout"; *got != want {
		t.Fatalf("LastError = %q, want %q", *got, want)
	}
}

func TestGetStatus_MachineIdProbeErrorIsRedacted(t *testing.T) {
	p, registry, fake, sqlDB := newMultiMachinePoller(t)
	m2 := addOtherMachine(t, registry, "Second", "gaggiuino", "192.168.1.50", true)
	fake.setStatus(machines.Status{}, errors.New(leakyMachineErr))

	h := NewHandlers(p, NewDemoService(sqlDB, shots.NewRepository(sqlDB), nil), testAPIToken)
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/status?machineId=%d", m2.ID), nil)
	req.Header.Set("X-GLP-Token", testAPIToken)
	rec := httptest.NewRecorder()
	newSystemMux(h).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeMap(t, rec.Body.Bytes())

	msg, _ := body["lastMachineError"].(string)
	if strings.Contains(msg, "192.168.1.50") {
		t.Fatalf("lastMachineError leaks the machine address: %q", msg)
	}
	if want := `Get "[url]": dial tcp [host]: connect: connection refused`; msg != want {
		t.Fatalf("lastMachineError = %q, want %q", msg, want)
	}
	if body["machineReachable"] != false {
		t.Fatalf("machineReachable = %v, want false (reachability stays visible)", body["machineReachable"])
	}
}
