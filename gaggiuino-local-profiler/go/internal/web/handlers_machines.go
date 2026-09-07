package web

import (
	"errors"
	"log"
	"net/http"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/system"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web/templates"
)

// This file is Phase 2c's (#901) Machines-domain counterpart to
// handlers.go/handlers_library.go: GET /machines (+ its two htmx write
// actions, set-default and delete) and GET /live, the live shot chart page
// — see go/README.md's Status section and this package's doc.go for the
// auth model every route below relies on unchanged. Both pages call
// machines.Registry directly (the same dependency internal/machines' own
// REST handlers_registry.go calls), never internal/machines' JSON
// handlers, mirroring every earlier Phase-2 page's convention.
//
// GET /live itself renders only static chrome (see
// templates/live.templ's own doc comment for why) — the actual live chart
// is static/live.js, a standalone vanilla-JS module consuming
// GET /api/events' live-snapshot/preheat-update SSE events directly,
// deliberately NOT built on this package's usual htmx-fragment-swap
// pattern (see go/README.md's Frontend section).

// MachinesHandlers wires machines.Registry (+ this Go server's own
// background poller, for the default machine's live reachable status and
// GET /live's static preheat-widget scaffolding) into the HTML handlers
// below.
type MachinesHandlers struct {
	registry *machines.Registry
	poller   *system.Poller
	rl       *ratelimit.KeyedLimiter
}

// NewMachinesHandlers builds MachinesHandlers around registry and poller —
// the same *machines.Registry/*system.Poller cmd/server already constructs
// once and shares with internal/machines' and internal/system's own REST
// handlers. poller is nil-safe: a caller without a running poller (e.g. a
// focused test) gets a Machines page with no reachable badge at all rather
// than a nil-pointer panic — see rows()' own comment.
func NewMachinesHandlers(registry *machines.Registry, poller *system.Poller) *MachinesHandlers {
	return &MachinesHandlers{registry: registry, poller: poller, rl: ratelimit.NewKeyed()}
}

// allowCreate rate-limits a "New machine" form submission — the same
// per-page helper convention handlers_library.go's own allowCreate
// establishes (#901 code review finding #7: createMachineAction used to
// call h.rl.Allow inline instead of through a named helper, the only one of
// this phase's create actions that did).
func (h *MachinesHandlers) allowCreate(r *http.Request) bool {
	return h.rl.Allow("web-machines:"+auth.RemoteIP(r), 30)
}

// RegisterRoutes registers this file's page and htmx-action routes onto
// mux — not prefixed with /api/, for the same GET/HEAD-auth-bypass reason
// handlers.go's RegisterRoutes documents.
func (h *MachinesHandlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /machines", h.machinesPage)
	mux.HandleFunc("POST /machines", h.createMachineAction)
	mux.HandleFunc("GET /machines/{id}", h.viewAction)
	mux.HandleFunc("GET /machines/{id}/edit", h.editAction)
	mux.HandleFunc("PUT /machines/{id}", h.updateAction)
	mux.HandleFunc("POST /machines/{id}/default", h.setDefaultAction)
	mux.HandleFunc("POST /machines/{id}/delete", h.deleteAction)

	mux.HandleFunc("GET /live", h.livePage)
}

// ── Machines list ──────────────────────────────────────────────────────

// rows builds every registered machine's templates.MachineRow, seeding the
// registry first the same way internal/machines' own listMachines handler
// does. reachable is only ever populated for the default machine — this Go
// rewrite's background poller (internal/system.Poller) doesn't track
// per-machine reachability for any other configured one, same as
// internal/system/status.go's statusMachine (GET /api/status's `machines`
// array) already documents for the JSON API.
func (h *MachinesHandlers) rows() ([]templates.MachineRow, error) {
	if err := h.registry.EnsureDefaultMachine(); err != nil {
		return nil, err
	}
	list, err := h.registry.ListMachines()
	if err != nil {
		return nil, err
	}
	var defaultReachable *bool
	if h.poller != nil {
		defaultReachable = h.poller.StatusInfo().MachineReachable
	}
	rows := make([]templates.MachineRow, len(list))
	for i, m := range list {
		var reachable *bool
		if m.IsDefault {
			reachable = defaultReachable
		}
		rows[i] = toMachineRow(m, reachable)
	}
	return rows, nil
}

// machinesPage ports GET /machines: every registered machine.
func (h *MachinesHandlers) machinesPage(w http.ResponseWriter, r *http.Request) {
	rows, err := h.rows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MachinesPage(rows, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /machines: %v", err)
	}
}

// createMachineAction ports the htmx `hx-post="machines"` interaction:
// builds a machines.MachineInput from the submitted name/type/host fields
// and calls machines.CreateMachineChecked (create.go) — the exact same
// validate -> SSRF-check -> Registry.CreateMachine sequence POST
// /api/machines' own handler now also calls. Answers 200 either way (see
// templates/machines.templ's MachinesContentFragment doc comment for why),
// re-rendering the form+list block with formError set on a validation/SSRF
// failure, or cleared (and the new machine shown) on success.
func (h *MachinesHandlers) createMachineAction(w http.ResponseWriter, r *http.Request) {
	if !h.allowCreate(r) {
		h.renderMachinesFragment(w, r, "Too many requests — please slow down")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderMachinesFragment(w, r, "Invalid form submission")
		return
	}
	name := r.FormValue("name")
	typ := r.FormValue("type")
	host := r.FormValue("host")
	in := machines.MachineInput{Name: &name, Type: &typ, Host: &host}
	if _, err := machines.CreateMachineChecked(r.Context(), h.registry, in); err != nil {
		var verr *machines.ValidationError
		if errors.As(err, &verr) {
			h.renderMachinesFragment(w, r, verr.Message)
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	h.renderMachinesFragment(w, r, "")
}

// renderMachinesFragment re-reads the current machine list and renders
// MachinesContentFragment with formError — shared by createMachineAction's
// success and validation-failure paths.
func (h *MachinesHandlers) renderMachinesFragment(w http.ResponseWriter, r *http.Request, formError string) {
	rows, err := h.rows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MachinesContentFragment(rows, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /machines fragment: %v", err)
	}
}

// rowByID re-reads the registry and returns the one row matching id — the
// shared lookup viewAction/editAction/updateAction all need to render a
// single machine row rather than the whole list, mirroring
// handlers_library.go's beanRowByID et al.
func (h *MachinesHandlers) rowByID(id int64) (templates.MachineRow, bool, error) {
	rows, err := h.rows()
	if err != nil {
		return templates.MachineRow{}, false, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, true, nil
		}
	}
	return templates.MachineRow{}, false, nil
}

// viewAction ports the htmx `hx-get="machines/{id}"` interaction: the Edit
// form's Cancel button swaps back to this plain view-mode row.
func (h *MachinesHandlers) viewAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid machine ID")
		return
	}
	row, found, err := h.rowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Machine not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MachineFragment(row).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /machines/%d: %v", id, err)
	}
}

// editAction ports the htmx `hx-get="machines/{id}/edit"` interaction:
// swaps the row for MachineEditFragment, its inline edit form.
func (h *MachinesHandlers) editAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid machine ID")
		return
	}
	row, found, err := h.rowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Machine not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MachineEditFragment(row, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /machines/%d/edit: %v", id, err)
	}
}

// updateAction ports the htmx `hx-put="machines/{id}"` interaction: builds a
// machines.MachineInput from the submitted edit-form fields and calls
// machines.UpdateMachineChecked (update.go) — the exact same
// validate -> SSRF-check -> Registry.UpdateMachine sequence PUT
// /api/machines/:id's own REST handler now also calls. onHostChanged is
// passed nil, the same no-op choice deleteAction's own doc comment already
// explains for this package's lack of a live WS-session client reference.
func (h *MachinesHandlers) updateAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid machine ID")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderEditError(w, r, id, "Invalid form submission")
		return
	}
	name := r.FormValue("name")
	typ := r.FormValue("type")
	host := r.FormValue("host")
	in := machines.MachineInput{Name: &name, Type: &typ, Host: &host}
	if _, found, err := machines.UpdateMachineChecked(r.Context(), h.registry, id, in, nil); err != nil {
		var verr *machines.ValidationError
		if errors.As(err, &verr) {
			h.renderEditError(w, r, id, verr.Message)
			return
		}
		httputil.InternalError(w, "web", err)
		return
	} else if !found {
		writeFragmentError(w, http.StatusNotFound, "Machine not found")
		return
	}
	row, found, err := h.rowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Machine not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MachineFragment(row).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering PUT /machines/%d: %v", id, err)
	}
}

// renderEditError re-renders MachineEditFragment with formError set — see
// handlers_library.go's renderBeanEditError for the same "don't lose the
// user's in-progress edit on a validation failure" rationale.
func (h *MachinesHandlers) renderEditError(w http.ResponseWriter, r *http.Request, id int64, formError string) {
	row, found, err := h.rowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Machine not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MachineEditFragment(row, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering PUT /machines/%d error fragment: %v", id, err)
	}
}

// setDefaultAction ports the htmx `hx-post="/machines/{id}/default"`
// interaction. Unlike beans' toggle-active (which only ever changes the one
// row it targets), reassigning the default machine changes two rows at
// once — the old default loses its badge and gains delete/set-default
// actions, the new one gets the opposite — so this answers with the whole
// re-rendered list (templates.MachineListFragment), targeting
// #machine-list, rather than a single row.
func (h *MachinesHandlers) setDefaultAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid machine ID")
		return
	}
	machine, err := h.registry.SetDefaultMachine(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if machine == nil {
		writeFragmentError(w, http.StatusNotFound, "Machine not found")
		return
	}
	rows, err := h.rows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MachineListFragment(rows).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /machines/%d/default fragment: %v", id, err)
	}
}

// deleteAction ports the htmx `hx-post="/machines/{id}/delete"`
// interaction: deletes the machine and, on success, answers an empty 200
// body so htmx's `hx-swap="outerHTML"` removes the row — same pattern as
// handlers.go's trashAction. Registry.DeleteMachine's two guards
// (ErrCannotDeleteDefault, ErrCannotDeleteLastMachine — the same ones
// internal/machines/handlers_registry.go's deleteMachine maps to a JSON 400)
// map to a 400 fragment here instead; the template already omits the
// delete action entirely for the default machine (machines.templ's
// `if !row.IsDefault`), so ErrCannotDeleteDefault can only be reached by a
// stale page racing a default change server-side, not a normal click.
// onHostEvicted is passed nil (unlike internal/machines/handlers_registry.go's
// own h.liveClient.DisconnectForHost) — this package has no reference to
// that live WS-session client; DeleteMachine treats a nil callback as a
// no-op, and an evicted host's session reconnects/fails naturally against a
// host nothing identifies anymore, same as RestoreMachines' documented
// gap.
func (h *MachinesHandlers) deleteAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid machine ID")
		return
	}
	deleted, err := h.registry.DeleteMachine(id, nil)
	if err != nil {
		if errors.Is(err, machines.ErrCannotDeleteDefault) || errors.Is(err, machines.ErrCannotDeleteLastMachine) {
			writeFragmentError(w, http.StatusBadRequest, err.Error())
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	if !deleted {
		writeFragmentError(w, http.StatusNotFound, "Machine not found")
		return
	}
	w.WriteHeader(http.StatusOK)
}

// ── Live page ──────────────────────────────────────────────────────────

// livePage ports GET /live: static chrome only (current machine's name) —
// see templates/live.templ's own doc comment for why everything else
// (status badge, readouts, chart, preheat widget) is left to
// static/live.js to populate client-side rather than being server-rendered
// here.
func (h *MachinesHandlers) livePage(w http.ResponseWriter, r *http.Request) {
	if err := h.registry.EnsureDefaultMachine(); err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	machine, err := h.registry.GetDefaultMachine()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	name := "No machine configured"
	if machine != nil && machine.Name != "" {
		name = machine.Name
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.LivePage(name).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /live: %v", err)
	}
}
