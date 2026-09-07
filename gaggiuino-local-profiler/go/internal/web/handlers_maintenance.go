package web

import (
	"errors"
	"log"
	"net/http"
	"strconv"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web/templates"
)

// This file is Phase 2e's (#901) Maintenance-domain counterpart to
// handlers_machines.go: GET /maintenance (per-machine task list, with a
// machine switcher when more than one machine is registered) plus its one
// htmx write action, POST /maintenance/{task}/done. Built on
// maintenance.MarkTaskDone (service.go) — the same function
// internal/maintenance's own REST handlers.go's taskDone now calls too (a
// #901 Phase 2e service-layer extraction, the same fix Phase 2d already
// applied to internal/orders' AcceptOrder/CompleteOrder/DeclineOrder after
// finding the web queue silently missing a REST-handler-only side effect —
// see maintenance/service.go's MarkTaskDone doc comment). Calling that one
// shared function (rather than reaching for repo.SaveMaintenance directly)
// means this page's "mark done" button writes the exact same
// maintenance_log entry the REST API's own POST .../done does, not a
// stripped-down duplicate.
//
// Deliberately NOT built in this phase (see go/README.md's Status section
// for the same scope note): per-task threshold editing (POST
// /api/maintenance/{task}/threshold) and the maintenance log view/CRUD
// (GET/POST /api/maintenance/log, DELETE .../log/{id}) —
// public-src/views/maintenance.js's own "detail" expando and log table.
// Both are read/write surfaces of their own, sized like a follow-up
// package rather than a corner of this one; the "mark done" action is the
// one write path this phase's dispatch brief explicitly calls out.

// MaintenanceHandlers wires maintenance.Repository/shots.Repository/
// library.Repository/machines.Registry into the HTML handlers below — the
// same dependencies internal/maintenance's own REST Handlers uses (see
// cmd/server's maintenanceHandlers construction), not a duplicate of its
// JSON handlers.
type MaintenanceHandlers struct {
	repo      *maintenance.Repository
	shotsRepo *shots.Repository
	libRepo   *library.Repository
	registry  *machines.Registry
}

// NewMaintenanceHandlers builds MaintenanceHandlers around the same
// *sql.DB-backed dependencies cmd/server already opens once.
func NewMaintenanceHandlers(repo *maintenance.Repository, shotsRepo *shots.Repository, libRepo *library.Repository, registry *machines.Registry) *MaintenanceHandlers {
	return &MaintenanceHandlers{repo: repo, shotsRepo: shotsRepo, libRepo: libRepo, registry: registry}
}

// RegisterRoutes registers this file's page and htmx-action routes onto
// mux — not prefixed with /api/, for the same GET/HEAD-auth-bypass reason
// handlers.go's RegisterRoutes documents.
func (h *MaintenanceHandlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /maintenance", h.maintenancePage)
	mux.HandleFunc("POST /maintenance/{task}/done", h.doneAction)
}

// machineOptions builds the page's machine switcher — every registered
// machine, id+name only.
func (h *MaintenanceHandlers) machineOptions() ([]templates.MaintMachineOption, error) {
	if err := h.registry.EnsureDefaultMachine(); err != nil {
		return nil, err
	}
	list, err := h.registry.ListMachines()
	if err != nil {
		return nil, err
	}
	opts := make([]templates.MaintMachineOption, len(list))
	for i, m := range list {
		opts[i] = templates.MaintMachineOption{ID: m.ID, Name: m.Name}
	}
	return opts, nil
}

// resolveMachineID reads ?machineId= if present and valid, otherwise falls
// back to the registry's default machine — mirrors
// internal/maintenance/handlers.go's activeMachineID, minus that function's
// "all" case (this page always shows exactly one machine's tasks, see this
// file's own doc comment on scope).
func (h *MaintenanceHandlers) resolveMachineID(r *http.Request) (int64, error) {
	if raw := r.URL.Query().Get("machineId"); raw != "" {
		if id, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return id, nil
		}
	}
	if err := h.registry.EnsureDefaultMachine(); err != nil {
		return 0, err
	}
	m, err := h.registry.GetDefaultMachine()
	if err != nil {
		return 0, err
	}
	if m == nil {
		return 1, nil
	}
	return m.ID, nil
}

// tilesFor builds machineID's task list as templates.MaintTile rows.
func (h *MaintenanceHandlers) tilesFor(machineID int64) ([]templates.MaintTile, error) {
	maint, err := h.repo.GetMaintenance(machineID)
	if err != nil {
		return nil, err
	}
	stats, err := maintenance.ComputeMaintenanceStats(h.shotsRepo, maint, machineID)
	if err != nil {
		return nil, err
	}
	return maintTiles(stats), nil
}

// maintenancePage ports GET /maintenance.
func (h *MaintenanceHandlers) maintenancePage(w http.ResponseWriter, r *http.Request) {
	machineID, err := h.resolveMachineID(r)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	opts, err := h.machineOptions()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	tiles, err := h.tilesFor(machineID)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MaintenancePage(opts, machineID, tiles).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /maintenance: %v", err)
	}
}

// doneAction ports the htmx `hx-post="/maintenance/{task}/done"` interaction
// via maintenance.MarkTaskDone — see this file's own doc comment for why
// that shared function, not a direct repo.SaveMaintenance call, is what
// this handler calls.
func (h *MaintenanceHandlers) doneAction(w http.ResponseWriter, r *http.Request) {
	machineID, err := h.resolveMachineID(r)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	stats, err := maintenance.MarkTaskDone(h.repo, h.shotsRepo, h.libRepo, h.registry, r.PathValue("task"), "", machineID)
	if err != nil {
		if errors.Is(err, maintenance.ErrUnknownTask) {
			writeFragmentError(w, http.StatusNotFound, "Unknown task")
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MaintenanceListFragment(maintTiles(stats), machineID).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /maintenance/%s/done fragment: %v", r.PathValue("task"), err)
	}
}
