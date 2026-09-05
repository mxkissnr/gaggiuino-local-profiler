package mqtt

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// This file ports routes/mqtt.js (#608): GET /api/mqtt/discovery,
// GET/POST /api/mqtt/settings, POST /api/mqtt/apply-to-machine.

// SupervisorAPI is the subset of *ha.Client this package needs for broker
// auto-discovery — an interface so tests don't need a real Supervisor.
type SupervisorAPI interface {
	SupervisorGet(ctx context.Context, path string, out any) error
}

// AdapterProvider mirrors internal/web/handlers_settings.go's own narrow
// dependency on *machines.Handlers.
type AdapterProvider interface {
	GetAdapter(m *machines.Machine) (machines.Adapter, error)
}

// Handlers ports routes/mqtt.js's router.
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
		"available": true,
		"host":      broker.Host,
		"port":      broker.Port,
		"username":  broker.Username,
		"password":  broker.Password,
	})
}

func (h *Handlers) getSettings(w http.ResponseWriter, _ *http.Request) {
	httputil.WriteJSON(w, http.StatusOK, h.repo.GetSettings())
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
	// takes effect on the very next read (mirrors gaggiuinoMqtt.disconnectAll()).
	h.transport.DisconnectAll()
	log.Printf("MQTT live-data transport settings updated")
	httputil.WriteJSON(w, http.StatusOK, saved)
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
	_, _ = w.Write(result)
}
