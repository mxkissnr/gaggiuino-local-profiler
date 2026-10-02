package mqtt

import (
	"log"
	"sync"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

// This file makes the per-read decision of whether the live-state cache is
// served from the persistent WS session (internal/machines/live.go, reached
// via the adapter) or this package's MQTT subscription. Both populate
// identically-shaped proto DTOs, so the caller (internal/system's poller)
// stays unaware of which transport is active.
//
// MQTT settings are a single global broker connection, not per-machine —
// only the default machine (registry id 1) is eligible; any additional
// configured machine always stays on its own baseUrl-keyed WS session
// regardless of the toggle.

// Transport is the WS-vs-MQTT dispatch seam. The poller holds one and, for
// every live read, asks it whether MQTT should serve this machine's data.
type Transport struct {
	client *Client
	repo   *Repository

	mu                  sync.Mutex
	lastLoggedTransport string
}

// NewTransport wires the shared *Client and the settings Repository.
func NewTransport(client *Client, repo *Repository) *Transport {
	return &Transport{client: client, repo: repo}
}

// DisconnectAll forwards to the underlying client (the settings handler
// calls it after a settings save).
func (t *Transport) DisconnectAll() {
	if t == nil || t.client == nil {
		return
	}
	t.client.DisconnectAll()
}

// eligible reports whether MQTT should serve the given machine's live data.
func (t *Transport) eligible(isDefaultMachine bool) (Conn, bool) {
	if !isDefaultMachine {
		return Conn{}, false
	}
	s := t.repo.GetSettings()
	if s.Transport != TransportMQTT || s.Host == "" {
		return Conn{}, false
	}
	return Conn{Host: s.Host, Port: s.Port, Username: s.Username, Password: s.Password, Prefix: s.Prefix}, true
}

// logTransportChange logs the active transport once, on change (#611).
func (t *Transport) logTransportChange(active string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if active == t.lastLoggedTransport {
		return
	}
	t.lastLoggedTransport = active
	log.Printf("Live-data transport for the default machine is now: %s", active)
}

// SensorSnapshot returns the MQTT sensor snapshot; the second return is true
// when MQTT handled the read (the caller then skips the adapter's WS path
// entirely).
func (t *Transport) SensorSnapshot(isDefaultMachine bool) (*proto.SensorStateSnapshotDto, bool) {
	conn, ok := t.eligible(isDefaultMachine)
	if isDefaultMachine {
		if ok {
			t.logTransportChange("MQTT")
		} else {
			t.logTransportChange("WebSocket")
		}
	}
	if !ok {
		return nil, false
	}
	return t.client.GetLiveSensorSnapshot(conn), true
}

// SystemState returns the MQTT system state; the second return is true when
// MQTT handled the read.
func (t *Transport) SystemState(isDefaultMachine bool) (*proto.SystemStateDto, bool) {
	conn, ok := t.eligible(isDefaultMachine)
	if !ok {
		return nil, false
	}
	return t.client.GetLiveSystemState(conn), true
}
