package mqtt

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// This file wires the #608 MQTT routes: GET /api/mqtt/discovery, GET/POST
// /api/mqtt/settings, POST /api/mqtt/apply-to-machine.

// SupervisorAPI is the subset of *ha.Client this package needs for broker
// auto-discovery — an interface so tests don't need a real Supervisor.
type SupervisorAPI interface {
	SupervisorGet(ctx context.Context, path string, out any) error
}

// AdapterProvider is the narrow dependency on *machines.Handlers this
// package needs.
type AdapterProvider interface {
	GetAdapter(m *machines.Machine) (machines.Adapter, error)
}

// Handlers wires the MQTT routes.
type Handlers struct {
	repo      *Repository
	transport *Transport
	registry  *machines.Registry
	adapters  AdapterProvider
	ha        SupervisorAPI
}

func NewHandlers(repo *Repository, transport *Transport, registry *machines.Registry, adapters AdapterProvider, ha SupervisorAPI) *Handlers {
	return &Handlers{repo: repo, transport: transport, registry: registry, adapters: adapters, ha: ha}
}

func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/mqtt/discovery", h.discovery)
	mux.HandleFunc("GET /api/mqtt/settings", h.getSettings)
	mux.HandleFunc("POST /api/mqtt/settings", h.postSettings)
	mux.HandleFunc("POST /api/mqtt/apply-to-machine", h.applyToMachine)
}

func (h *Handlers) discovery(w http.ResponseWriter, r *http.Request) {
	broker := DiscoverSupervisorMQTT(r.Context(), h.ha)
	if broker == nil {
		httputil.WriteJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]any{
		"available":   true,
		"host":        broker.Host,
		"port":        broker.Port,
		"username":    broker.Username,
		"hasPassword": broker.Password != "",
	})
}

func (h *Handlers) getSettings(w http.ResponseWriter, _ *http.Request) {
	httputil.WriteJSON(w, http.StatusOK, redact(h.repo.GetSettings()))
}

func (h *Handlers) postSettings(w http.ResponseWriter, r *http.Request) {
	body, ok := httputil.DecodeJSONBody[map[string]any](w, r, 1<<20)
	if !ok {
		return
	}
	parsed, err := parseSettings(body)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid MQTT settings")
		return
	}
	// #1062: an explicit clearPassword wipes the stored password regardless
	// of whatever's in the password field, taking priority over both the
	// "keep unchanged" and "overwrite" cases below.
	if clear, _ := body["clearPassword"].(bool); clear {
		parsed.Password = ""
	} else if pw, present := body["password"].(string); present && pw != "" {
		// #1431: a non-empty password always wins — the caller typed a new
		// one, so no discovery lookup happens.
		parsed.Password = pw
	} else if useDiscovered, _ := body["useDiscoveredPassword"].(bool); useDiscovered {
		// #1431: GET /api/mqtt/discovery no longer returns the broker password
		// (only hasPassword), so the Settings UI can no longer prefill it. This
		// opt-in reuses the Supervisor-discovered broker's password instead. No
		// discovered broker is a hard error so an unrelated/stale stored
		// password is never silently kept.
		broker := DiscoverSupervisorMQTT(r.Context(), h.ha)
		if broker == nil {
			httputil.WriteError(w, http.StatusBadRequest, "no discovered MQTT broker")
			return
		}
		// #1431 follow-up: the discovered password belongs to the discovered
		// broker only. Without this, useDiscoveredPassword plus an arbitrary
		// host would forward the Supervisor's broker password to whatever
		// broker the caller names. Host is compared case-insensitively (DNS
		// names are); port/username are compared against the same defaults
		// parseSettings applies when the body omits them.
		if !strings.EqualFold(parsed.Host, broker.Host) ||
			parsed.Port != broker.Port ||
			parsed.Username != broker.Username {
			httputil.WriteError(w, http.StatusBadRequest, "the discovered password can only be used with the discovered broker")
			return
		}
		parsed.Password = broker.Password
	} else {
		// #1050: getSettings never echoes the real password back (see above),
		// so the Settings UI's re-submitted form has no way to send it back
		// unchanged — an absent password field means "keep the stored one",
		// not "clear it".
		parsed.Password = h.repo.GetSettings().Password
	}
	// #988: reject a broker host the SSRF guard would refuse to dial, same
	// threat model as a machine's own host (client.go's connect() re-checks
	// this again before every AddBroker, since a backup restore can also
	// set a broker host without going through this handler at all — this
	// check just gives immediate feedback instead of a silent background
	// connect failure).
	if parsed.Host != "" {
		if err := machines.AssertMachineHost(r.Context(), parsed.Host); err != nil {
			httputil.WriteError(w, http.StatusBadRequest, "MQTT broker host is not allowed")
			return
		}
	}
	saved, err := h.repo.SaveSettings(parsed)
	if err != nil {
		httputil.InternalError(w, "mqtt", err)
		return
	}
	// Drop any already-open session so a changed host/port/prefix/credentials
	// takes effect on the very next read.
	h.transport.DisconnectAll()
	log.Printf("MQTT live-data transport settings updated")
	httputil.WriteJSON(w, http.StatusOK, redact(saved))
}

func (h *Handlers) applyToMachine(w http.ResponseWriter, r *http.Request) {
	if err := h.registry.EnsureDefaultMachine(); err != nil {
		httputil.InternalError(w, "mqtt", err)
		return
	}
	machine, err := h.registry.GetDefaultMachine()
	if err != nil || machine == nil {
		httputil.InternalError(w, "mqtt", err)
		return
	}
	adapter, err := h.adapters.GetAdapter(machine)
	if err != nil {
		httputil.InternalError(w, "mqtt", err)
		return
	}
	if !adapter.Capabilities().SettingsProxy {
		httputil.WriteError(w, http.StatusNotImplemented, "machine type does not support the settings proxy")
		return
	}

	settings := h.repo.GetSettings()
	if settings.Host == "" {
		httputil.WriteError(w, http.StatusBadRequest, "no MQTT broker configured yet")
		return
	}

	// POST /api/settings/system expects the full settings object back, so
	// merge onto a fresh GET rather than send a partial payload.
	currentRaw, err := adapter.GetSettings(r.Context(), machine, "system")
	if err != nil {
		log.Printf("Applying MQTT settings to machine failed: %v", err)
		httputil.WriteError(w, http.StatusBadGateway, err.Error())
		return
	}
	var current map[string]any
	if err := json.Unmarshal(currentRaw, &current); err != nil || current == nil {
		current = map[string]any{}
	}
	current["mqttEnabled"] = true
	current["mqttHost"] = settings.Host
	current["mqttPort"] = settings.Port
	current["mqttUsername"] = settings.Username
	current["mqttPassword"] = settings.Password
	current["mqttTopicPrefix"] = settings.Prefix

	merged, err := json.Marshal(current)
	if err != nil {
		httputil.InternalError(w, "mqtt", err)
		return
	}
	result, err := adapter.UpdateSettings(r.Context(), machine, "system", merged)
	if err != nil {
		log.Printf("Applying MQTT settings to machine failed: %v", err)
		httputil.WriteError(w, http.StatusBadGateway, err.Error())
		return
	}
	log.Printf("Applied broker connection to machine #%d %q's own MQTT client settings", machine.ID, machine.Name)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(machines.RedactSystemSettings(result))
}
