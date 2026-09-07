package web

import (
	"errors"
	"log"
	"net/http"
	"strconv"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web/templates"
)

// This file is Phase 2b's (#901) Library-domain counterpart to handlers.go:
// GET /beans (+ its one htmx write action, toggle-active) and five read-only
// list pages (Grinders, Baskets, Puck Screens, Milks, Recipes) — see
// go/README.md's Status section and this package's own doc.go for the auth
// model every route below relies on unchanged (GET pages public per the
// Ingress-trust model, the one write action behind auth.RequireToken's
// GET/HEAD-scoped bypass, X-GLP-Token wired in globally via
// templates/layout.templ's glp-token.js — nothing new to wire per page).
//
// Every handler here calls internal/library's existing Repository/exported
// service functions (library.ComputeGrinderWearStats, library.ComputeBeanRemaining,
// library.ToggleBeanActive) directly — the same dependencies
// internal/library's own REST handlers.go call — never internal/library's
// http.Handler-returning REST endpoints themselves, mirroring how
// handlers.go's shots page calls shots.Service instead of internal/shots'
// JSON handlers.

// LibraryHandlers wires library.Repository (+ a shots.Repository for the
// two cross-domain reads Beans/Grinders need — bean consumption, grinder
// wear) into the HTML handlers below. rl rate-limits the six "New ..."
// create actions below — this package's own limiter, separate from
// internal/library.Handlers' own "lib:"+ip-keyed one (rateLimitCreate),
// since these actions call library.CreateBean et al. directly and bypass
// that REST handler entirely; without its own limiter every create form
// here would have no rate protection at all, the same reasoning
// handlers_orders.go's NewOrdersHandlers doc comment gives for its own rl.
type LibraryHandlers struct {
	repo      *library.Repository
	shotsRepo *shots.Repository
	rl        *ratelimit.KeyedLimiter
	// imageDir mirrors internal/library.Handlers' own unexported imageDir
	// field (#901 code review finding #4) — createBeanAction used to pass
	// the hardcoded library.DefaultImageDir straight to library.CreateBean
	// instead of a configurable field the way the REST path does, so a test
	// (or a future caller) overriding where bean images land had no way to
	// reach this package's own create action.
	imageDir string
}

// NewLibraryHandlers builds LibraryHandlers around repo and shotsRepo — the
// same *library.Repository/*shots.Repository cmd/server already constructs
// once and shares with internal/library's and internal/shots' own REST
// handlers.
func NewLibraryHandlers(repo *library.Repository, shotsRepo *shots.Repository) *LibraryHandlers {
	return &LibraryHandlers{repo: repo, shotsRepo: shotsRepo, rl: ratelimit.NewKeyed(), imageDir: library.DefaultImageDir}
}

// RegisterRoutes registers this file's page and htmx-action routes onto
// mux — not prefixed with /api/, for the same GET/HEAD-auth-bypass reason
// handlers.go's RegisterRoutes documents.
func (h *LibraryHandlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /beans", h.beansPage)
	mux.HandleFunc("POST /beans", h.createBeanAction)
	mux.HandleFunc("POST /beans/{id}/toggle-active", h.toggleBeanActiveAction)
	mux.HandleFunc("GET /beans/{id}", h.beanViewAction)
	mux.HandleFunc("GET /beans/{id}/edit", h.beanEditAction)
	mux.HandleFunc("PUT /beans/{id}", h.updateBeanAction)

	mux.HandleFunc("GET /grinders", h.grindersPage)
	mux.HandleFunc("POST /grinders", h.createGrinderAction)
	mux.HandleFunc("GET /grinders/{id}", h.grinderViewAction)
	mux.HandleFunc("GET /grinders/{id}/edit", h.grinderEditAction)
	mux.HandleFunc("PUT /grinders/{id}", h.updateGrinderAction)

	mux.HandleFunc("GET /baskets", h.basketsPage)
	mux.HandleFunc("POST /baskets", h.createBasketAction)
	mux.HandleFunc("GET /baskets/{id}", h.basketViewAction)
	mux.HandleFunc("GET /baskets/{id}/edit", h.basketEditAction)
	mux.HandleFunc("PUT /baskets/{id}", h.updateBasketAction)

	mux.HandleFunc("GET /puckscreens", h.puckScreensPage)
	mux.HandleFunc("POST /puckscreens", h.createPuckScreenAction)
	mux.HandleFunc("GET /puckscreens/{id}", h.puckScreenViewAction)
	mux.HandleFunc("GET /puckscreens/{id}/edit", h.puckScreenEditAction)
	mux.HandleFunc("PUT /puckscreens/{id}", h.updatePuckScreenAction)

	mux.HandleFunc("GET /milks", h.milksPage)
	mux.HandleFunc("POST /milks", h.createMilkAction)
	mux.HandleFunc("GET /milks/{id}", h.milkViewAction)
	mux.HandleFunc("GET /milks/{id}/edit", h.milkEditAction)
	mux.HandleFunc("PUT /milks/{id}", h.updateMilkAction)

	mux.HandleFunc("GET /recipes", h.recipesPage)
	mux.HandleFunc("POST /recipes", h.createRecipeAction)
	mux.HandleFunc("GET /recipes/{id}", h.recipeViewAction)
	mux.HandleFunc("GET /recipes/{id}/edit", h.recipeEditAction)
	mux.HandleFunc("PUT /recipes/{id}", h.updateRecipeAction)
}

// allowCreate rate-limits a "New ..." form submission, matching
// internal/library.Handlers.rateLimitCreate's own 30-per-window budget for
// the "lib:"-prefixed key its REST create endpoints share — a distinct
// "web-library:"-prefixed key here since these actions never reach that
// REST handler.
func (h *LibraryHandlers) allowCreate(r *http.Request) bool {
	return h.rl.Allow("web-library:"+auth.RemoteIP(r), 30)
}

// ── Beans ──────────────────────────────────────────────────────────────

// beanRows projects every bean in the library the same way public-src/
// views/library.js's renderBeanList reads S.coffeeLibrary — see
// view_library.go's toBeanRow. Shared by beansPage and createBeanAction,
// both of which need the freshly (re-)read list after their own request.
func (h *LibraryHandlers) beanRows() ([]templates.BeanRow, error) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		return nil, err
	}
	return h.beanRowsFromLib(lib)
}

// beanRowsFromLib is beanRows' projection step split out from its own
// repo.GetLibrary() read (#901 code review finding #3) — createBeanAction
// already gets the freshly-saved Library back from library.CreateBean, so
// it calls this directly instead of paying a second, redundant GetLibrary
// read purely to re-render the row it just created.
func (h *LibraryHandlers) beanRowsFromLib(lib library.Library) ([]templates.BeanRow, error) {
	doseRows, err := h.shotsRepo.GetAnnotatedDoses()
	if err != nil {
		return nil, err
	}
	rows := make([]templates.BeanRow, len(lib.Beans))
	for i, bean := range lib.Beans {
		rows[i] = toBeanRow(bean, doseRows, lib.Beans)
	}
	return rows, nil
}

// beansPage ports GET /beans: the "New bean" form plus every bean in the
// library.
func (h *LibraryHandlers) beansPage(w http.ResponseWriter, r *http.Request) {
	rows, err := h.beanRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BeansPage(rows, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /beans: %v", err)
	}
}

// createBeanAction ports the htmx `hx-post="beans"` interaction: builds a
// library.Entity body from the submitted form fields (name, roaster,
// category — the "first usable pass" field set this page's dispatch brief
// scopes to, not the two dozen optional fields POST /api/library/bean also
// accepts) and calls library.CreateBean (create.go) — the exact same
// read-validate-save function that REST endpoint's own handler now also
// calls, per this package's "reuse the service layer" convention. Answers
// 200 either way (see library.templ's own doc comment on why a 4xx here
// would leave the error invisible to htmx's default responseHandling), with
// the same beansContent fragment createBeanAction and beansPage both
// render — formError set on a validation failure, empty (and the just-
// submitted fields cleared) on success.
func (h *LibraryHandlers) createBeanAction(w http.ResponseWriter, r *http.Request) {
	if !h.allowCreate(r) {
		h.renderBeansFragment(w, r, "Too many requests — please slow down")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderBeansFragment(w, r, "Invalid form submission")
		return
	}
	body := library.Entity{
		"name":     r.FormValue("name"),
		"roaster":  r.FormValue("roaster"),
		"category": r.FormValue("category"),
	}
	_, lib, err := library.CreateBean(h.repo, h.imageDir, body)
	if err != nil {
		var verr *library.ValidationError
		if errors.As(err, &verr) {
			h.renderBeansFragment(w, r, verr.Message)
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	h.renderBeansFragmentFromLib(w, r, lib, "")
}

// renderBeansFragment re-reads the current bean list and renders
// BeansContentFragment with formError — used for the "no Library available
// yet" paths (rate-limited, bad form, validation failure) that never
// reached library.CreateBean.
func (h *LibraryHandlers) renderBeansFragment(w http.ResponseWriter, r *http.Request, formError string) {
	rows, err := h.beanRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BeansContentFragment(rows, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /beans fragment: %v", err)
	}
}

// renderBeansFragmentFromLib is renderBeansFragment's counterpart for a
// caller that already has the current Library (a just-succeeded create) —
// see beanRowsFromLib's own doc comment.
func (h *LibraryHandlers) renderBeansFragmentFromLib(w http.ResponseWriter, r *http.Request, lib library.Library, formError string) {
	rows, err := h.beanRowsFromLib(lib)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BeansContentFragment(rows, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /beans fragment: %v", err)
	}
}

// toggleBeanActiveAction ports the htmx `hx-post="/beans/{id}/toggle-active"`
// interaction: flips the bean's enabled flag via the same
// library.ToggleBeanActive the REST API's POST /api/library/bean/:id/toggle-active
// now also calls (internal/library/handlers_beans.go), then answers with the
// re-rendered row so htmx's `hx-swap="outerHTML"` reflects the new
// enabled/disabled state in place — unlike shots' trash/restore actions,
// this one doesn't remove the row from the page. Reuses the Library
// ToggleBeanActive already read (and saved) for the row's allBeans param
// instead of issuing a second GetLibrary call just to re-render one row.
func (h *LibraryHandlers) toggleBeanActiveAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid bean ID")
		return
	}
	bean, lib, found, err := library.ToggleBeanActive(h.repo, id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Bean not found")
		return
	}
	doseRows, err := h.shotsRepo.GetAnnotatedDoses()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	row := toBeanRow(bean, doseRows, lib.Beans)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BeanFragment(row).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /beans/%d/toggle-active fragment: %v", id, err)
	}
}

// beanRowByID re-reads the library and returns the one row matching id — the
// shared lookup beanViewAction/beanEditAction/updateBeanAction all need to
// render a single bean row rather than the whole list.
func (h *LibraryHandlers) beanRowByID(id int64) (templates.BeanRow, bool, error) {
	rows, err := h.beanRows()
	if err != nil {
		return templates.BeanRow{}, false, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, true, nil
		}
	}
	return templates.BeanRow{}, false, nil
}

// beanViewAction ports the htmx `hx-get="beans/{id}"` interaction: the Edit
// form's Cancel button swaps back to this plain view-mode row.
func (h *LibraryHandlers) beanViewAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid bean ID")
		return
	}
	row, found, err := h.beanRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Bean not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BeanFragment(row).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /beans/%d: %v", id, err)
	}
}

// beanEditAction ports the htmx `hx-get="beans/{id}/edit"` interaction:
// swaps the row for BeanEditFragment, its inline edit form.
func (h *LibraryHandlers) beanEditAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid bean ID")
		return
	}
	row, found, err := h.beanRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Bean not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BeanEditFragment(row, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /beans/%d/edit: %v", id, err)
	}
}

// updateBeanAction ports the htmx `hx-put="beans/{id}"` interaction: builds
// a partial-update library.Entity from the submitted edit-form fields and
// calls library.UpdateBean (update.go) — the exact same field-patch logic
// PUT /api/library/bean/:id's own REST handler now also calls. The decaf
// checkbox needs its own "was the field present at all" hidden companion
// input (decaf_present) since an unchecked HTML checkbox simply omits its
// name from the submitted form — without it, unchecking Decaf and saving
// would silently leave the old value in place instead of clearing it.
// Answers with the re-rendered view-mode row on success, or the edit form
// again with formError set on a validation failure (same "success and
// failure share one fragment" convention as the New forms, since htmx 2.0's
// default responseHandling never swaps a non-2xx response into the DOM —
// see beansContent's own doc comment).
func (h *LibraryHandlers) updateBeanAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid bean ID")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderBeanEditError(w, r, id, "Invalid form submission")
		return
	}
	body := library.Entity{
		"name":      r.FormValue("name"),
		"roaster":   r.FormValue("roaster"),
		"category":  r.FormValue("category"),
		"roastDate": r.FormValue("roastDate"),
		"stock_g":   r.FormValue("stock_g"),
		"notes":     r.FormValue("notes"),
	}
	if r.FormValue("decaf_present") != "" {
		body["decaf"] = r.FormValue("decaf") == "true"
	}
	_, lib, found, err := library.UpdateBean(h.repo, id, body)
	if err != nil {
		var verr *library.ValidationError
		if errors.As(err, &verr) {
			h.renderBeanEditError(w, r, id, verr.Message)
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Bean not found")
		return
	}
	rows, err := h.beanRowsFromLib(lib)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	for _, row := range rows {
		if row.ID == id {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			if err := templates.BeanFragment(row).Render(r.Context(), w); err != nil {
				log.Printf("web: rendering PUT /beans/%d: %v", id, err)
			}
			return
		}
	}
	writeFragmentError(w, http.StatusNotFound, "Bean not found")
}

// renderBeanEditError re-renders BeanEditFragment with formError set — used
// when a submitted edit fails validation, so the user's in-progress edits
// aren't lost the way a full-page bounce back to the view row would lose
// them.
func (h *LibraryHandlers) renderBeanEditError(w http.ResponseWriter, r *http.Request, id int64, formError string) {
	row, found, err := h.beanRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Bean not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BeanEditFragment(row, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering PUT /beans/%d error fragment: %v", id, err)
	}
}

// ── Grinders ───────────────────────────────────────────────────────────

// grinderRows projects every grinder in the library, including its
// computed wear stats — shared by grindersPage and createGrinderAction.
func (h *LibraryHandlers) grinderRows() ([]templates.GrinderRow, error) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		return nil, err
	}
	return h.grinderRowsFromLib(lib)
}

// grinderRowsFromLib is grinderRows' projection step split out from its own
// repo.GetLibrary() read — see beanRowsFromLib's doc comment (#901 code
// review finding #3).
func (h *LibraryHandlers) grinderRowsFromLib(lib library.Library) ([]templates.GrinderRow, error) {
	var allShots []shots.Shot
	if len(lib.Grinders) > 0 {
		var err error
		allShots, err = h.shotsRepo.FindAllExcludingTrash()
		if err != nil {
			return nil, err
		}
	}
	rows := make([]templates.GrinderRow, len(lib.Grinders))
	for i, grinder := range lib.Grinders {
		shotsSince, gramsSince := library.ComputeGrinderWearFrom(allShots, grinder)
		rows[i] = toGrinderRow(grinder, shotsSince, gramsSince)
	}
	return rows, nil
}

// grindersPage ports GET /grinders: the "New grinder" form plus every
// grinder in the library — no per-grinder write action beyond creation in
// this package (see the dispatch brief's own scope call).
func (h *LibraryHandlers) grindersPage(w http.ResponseWriter, r *http.Request) {
	rows, err := h.grinderRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.GrindersPage(rows, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /grinders: %v", err)
	}
}

// createGrinderAction ports the htmx `hx-post="grinders"` interaction —
// same shape as createBeanAction, built on library.CreateGrinder.
func (h *LibraryHandlers) createGrinderAction(w http.ResponseWriter, r *http.Request) {
	if !h.allowCreate(r) {
		h.renderGrindersFragment(w, r, "Too many requests — please slow down")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderGrindersFragment(w, r, "Invalid form submission")
		return
	}
	body := library.Entity{
		"name":         r.FormValue("name"),
		"burrType":     r.FormValue("burrType"),
		"purchaseDate": r.FormValue("purchaseDate"),
	}
	_, lib, err := library.CreateGrinder(h.repo, body)
	if err != nil {
		var verr *library.ValidationError
		if errors.As(err, &verr) {
			h.renderGrindersFragment(w, r, verr.Message)
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	h.renderGrindersFragmentFromLib(w, r, lib, "")
}

func (h *LibraryHandlers) renderGrindersFragment(w http.ResponseWriter, r *http.Request, formError string) {
	rows, err := h.grinderRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.GrindersContentFragment(rows, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /grinders fragment: %v", err)
	}
}

func (h *LibraryHandlers) renderGrindersFragmentFromLib(w http.ResponseWriter, r *http.Request, lib library.Library, formError string) {
	rows, err := h.grinderRowsFromLib(lib)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.GrindersContentFragment(rows, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /grinders fragment: %v", err)
	}
}

// grinderRowByID re-reads the library and returns the one row matching id —
// see beanRowByID's own doc comment.
func (h *LibraryHandlers) grinderRowByID(id int64) (templates.GrinderRow, bool, error) {
	rows, err := h.grinderRows()
	if err != nil {
		return templates.GrinderRow{}, false, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, true, nil
		}
	}
	return templates.GrinderRow{}, false, nil
}

func (h *LibraryHandlers) grinderViewAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid grinder ID")
		return
	}
	row, found, err := h.grinderRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Grinder not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.GrinderFragment(row).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /grinders/%d: %v", id, err)
	}
}

func (h *LibraryHandlers) grinderEditAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid grinder ID")
		return
	}
	row, found, err := h.grinderRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Grinder not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.GrinderEditFragment(row, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /grinders/%d/edit: %v", id, err)
	}
}

// updateGrinderAction ports the htmx `hx-put="grinders/{id}"` interaction —
// same shape as updateBeanAction, built on library.UpdateGrinder.
func (h *LibraryHandlers) updateGrinderAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid grinder ID")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderGrinderEditError(w, r, id, "Invalid form submission")
		return
	}
	body := library.Entity{
		"name":         r.FormValue("name"),
		"burrType":     r.FormValue("burrType"),
		"purchaseDate": r.FormValue("purchaseDate"),
		"notes":        r.FormValue("notes"),
	}
	_, lib, found, err := library.UpdateGrinder(h.repo, id, body)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Grinder not found")
		return
	}
	rows, err := h.grinderRowsFromLib(lib)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	for _, row := range rows {
		if row.ID == id {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			if err := templates.GrinderFragment(row).Render(r.Context(), w); err != nil {
				log.Printf("web: rendering PUT /grinders/%d: %v", id, err)
			}
			return
		}
	}
	writeFragmentError(w, http.StatusNotFound, "Grinder not found")
}

func (h *LibraryHandlers) renderGrinderEditError(w http.ResponseWriter, r *http.Request, id int64, formError string) {
	row, found, err := h.grinderRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Grinder not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.GrinderEditFragment(row, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering PUT /grinders/%d error fragment: %v", id, err)
	}
}

// ── Baskets, Puck Screens, Milks, Recipes ─────────────────────────────
//
// All four have no cross-domain computation (unlike Beans' consumption
// math or Grinders' wear stats), so each page/create-action pair is a
// straight GetLibrary + per-entity projection + Render, plus its own
// library.Create* call for the write action.

func (h *LibraryHandlers) basketRows() ([]templates.BasketRow, error) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		return nil, err
	}
	return h.basketRowsFromLib(lib), nil
}

// basketRowsFromLib is basketRows' projection step split out from its own
// repo.GetLibrary() read — see beanRowsFromLib's doc comment (#901 code
// review finding #3).
func (h *LibraryHandlers) basketRowsFromLib(lib library.Library) []templates.BasketRow {
	rows := make([]templates.BasketRow, len(lib.Baskets))
	for i, basket := range lib.Baskets {
		rows[i] = toBasketRow(basket)
	}
	return rows
}

func (h *LibraryHandlers) basketsPage(w http.ResponseWriter, r *http.Request) {
	rows, err := h.basketRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BasketsPage(rows, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /baskets: %v", err)
	}
}

func (h *LibraryHandlers) createBasketAction(w http.ResponseWriter, r *http.Request) {
	if !h.allowCreate(r) {
		h.renderBasketsFragment(w, r, "Too many requests — please slow down")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderBasketsFragment(w, r, "Invalid form submission")
		return
	}
	body := library.Entity{
		"name":     r.FormValue("name"),
		"wallType": r.FormValue("wallType"),
		"shape":    r.FormValue("shape"),
	}
	_, lib, err := library.CreateBasket(h.repo, body)
	if err != nil {
		var verr *library.ValidationError
		if errors.As(err, &verr) {
			h.renderBasketsFragment(w, r, verr.Message)
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BasketsContentFragment(h.basketRowsFromLib(lib), "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /baskets fragment: %v", err)
	}
}

func (h *LibraryHandlers) renderBasketsFragment(w http.ResponseWriter, r *http.Request, formError string) {
	rows, err := h.basketRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BasketsContentFragment(rows, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /baskets fragment: %v", err)
	}
}

// basketRowByID re-reads the library and returns the one row matching id —
// see beanRowByID's own doc comment.
func (h *LibraryHandlers) basketRowByID(id int64) (templates.BasketRow, bool, error) {
	rows, err := h.basketRows()
	if err != nil {
		return templates.BasketRow{}, false, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, true, nil
		}
	}
	return templates.BasketRow{}, false, nil
}

func (h *LibraryHandlers) basketViewAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid basket ID")
		return
	}
	row, found, err := h.basketRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Basket not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BasketFragment(row).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /baskets/%d: %v", id, err)
	}
}

func (h *LibraryHandlers) basketEditAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid basket ID")
		return
	}
	row, found, err := h.basketRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Basket not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BasketEditFragment(row, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /baskets/%d/edit: %v", id, err)
	}
}

// updateBasketAction ports the htmx `hx-put="baskets/{id}"` interaction —
// same shape as updateBeanAction, built on library.UpdateBasket (which
// carries its own wallType/shape enum validation, surfaced here as
// formError the same way createBasketAction surfaces it).
func (h *LibraryHandlers) updateBasketAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid basket ID")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderBasketEditError(w, r, id, "Invalid form submission")
		return
	}
	body := library.Entity{
		"name":         r.FormValue("name"),
		"wallType":     r.FormValue("wallType"),
		"shape":        r.FormValue("shape"),
		"doseCapacity": r.FormValue("doseCapacity"),
		"holeCount":    r.FormValue("holeCount"),
		"notes":        r.FormValue("notes"),
	}
	_, lib, found, err := library.UpdateBasket(h.repo, id, body)
	if err != nil {
		var verr *library.ValidationError
		if errors.As(err, &verr) {
			h.renderBasketEditError(w, r, id, verr.Message)
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Basket not found")
		return
	}
	for _, row := range h.basketRowsFromLib(lib) {
		if row.ID == id {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			if err := templates.BasketFragment(row).Render(r.Context(), w); err != nil {
				log.Printf("web: rendering PUT /baskets/%d: %v", id, err)
			}
			return
		}
	}
	writeFragmentError(w, http.StatusNotFound, "Basket not found")
}

func (h *LibraryHandlers) renderBasketEditError(w http.ResponseWriter, r *http.Request, id int64, formError string) {
	row, found, err := h.basketRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Basket not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BasketEditFragment(row, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering PUT /baskets/%d error fragment: %v", id, err)
	}
}

func (h *LibraryHandlers) puckScreenRows() ([]templates.PuckScreenRow, error) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		return nil, err
	}
	return h.puckScreenRowsFromLib(lib), nil
}

// puckScreenRowsFromLib is puckScreenRows' projection step split out from
// its own repo.GetLibrary() read — see beanRowsFromLib's doc comment (#901
// code review finding #3).
func (h *LibraryHandlers) puckScreenRowsFromLib(lib library.Library) []templates.PuckScreenRow {
	rows := make([]templates.PuckScreenRow, len(lib.PuckScreens))
	for i, puckScreen := range lib.PuckScreens {
		rows[i] = toPuckScreenRow(puckScreen)
	}
	return rows
}

func (h *LibraryHandlers) puckScreensPage(w http.ResponseWriter, r *http.Request) {
	rows, err := h.puckScreenRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.PuckScreensPage(rows, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /puckscreens: %v", err)
	}
}

func (h *LibraryHandlers) createPuckScreenAction(w http.ResponseWriter, r *http.Request) {
	if !h.allowCreate(r) {
		h.renderPuckScreensFragment(w, r, "Too many requests — please slow down")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderPuckScreensFragment(w, r, "Invalid form submission")
		return
	}
	body := library.Entity{
		"name":      r.FormValue("name"),
		"thickness": r.FormValue("thickness"),
		"material":  r.FormValue("material"),
	}
	_, lib, err := library.CreatePuckScreen(h.repo, body)
	if err != nil {
		var verr *library.ValidationError
		if errors.As(err, &verr) {
			h.renderPuckScreensFragment(w, r, verr.Message)
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.PuckScreensContentFragment(h.puckScreenRowsFromLib(lib), "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /puckscreens fragment: %v", err)
	}
}

func (h *LibraryHandlers) renderPuckScreensFragment(w http.ResponseWriter, r *http.Request, formError string) {
	rows, err := h.puckScreenRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.PuckScreensContentFragment(rows, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /puckscreens fragment: %v", err)
	}
}

// puckScreenRowByID re-reads the library and returns the one row matching
// id — see beanRowByID's own doc comment.
func (h *LibraryHandlers) puckScreenRowByID(id int64) (templates.PuckScreenRow, bool, error) {
	rows, err := h.puckScreenRows()
	if err != nil {
		return templates.PuckScreenRow{}, false, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, true, nil
		}
	}
	return templates.PuckScreenRow{}, false, nil
}

func (h *LibraryHandlers) puckScreenViewAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid puck screen ID")
		return
	}
	row, found, err := h.puckScreenRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Puck screen not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.PuckScreenFragment(row).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /puckscreens/%d: %v", id, err)
	}
}

func (h *LibraryHandlers) puckScreenEditAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid puck screen ID")
		return
	}
	row, found, err := h.puckScreenRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Puck screen not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.PuckScreenEditFragment(row, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /puckscreens/%d/edit: %v", id, err)
	}
}

// updatePuckScreenAction ports the htmx `hx-put="puckscreens/{id}"`
// interaction — same shape as updateBasketAction, built on
// library.UpdatePuckScreen (which carries its own thickness enum
// validation).
func (h *LibraryHandlers) updatePuckScreenAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid puck screen ID")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderPuckScreenEditError(w, r, id, "Invalid form submission")
		return
	}
	body := library.Entity{
		"name":      r.FormValue("name"),
		"thickness": r.FormValue("thickness"),
		"material":  r.FormValue("material"),
		"notes":     r.FormValue("notes"),
	}
	_, lib, found, err := library.UpdatePuckScreen(h.repo, id, body)
	if err != nil {
		var verr *library.ValidationError
		if errors.As(err, &verr) {
			h.renderPuckScreenEditError(w, r, id, verr.Message)
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Puck screen not found")
		return
	}
	for _, row := range h.puckScreenRowsFromLib(lib) {
		if row.ID == id {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			if err := templates.PuckScreenFragment(row).Render(r.Context(), w); err != nil {
				log.Printf("web: rendering PUT /puckscreens/%d: %v", id, err)
			}
			return
		}
	}
	writeFragmentError(w, http.StatusNotFound, "Puck screen not found")
}

func (h *LibraryHandlers) renderPuckScreenEditError(w http.ResponseWriter, r *http.Request, id int64, formError string) {
	row, found, err := h.puckScreenRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Puck screen not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.PuckScreenEditFragment(row, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering PUT /puckscreens/%d error fragment: %v", id, err)
	}
}

func (h *LibraryHandlers) milkRows() ([]templates.MilkRow, error) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		return nil, err
	}
	return h.milkRowsFromLib(lib), nil
}

// milkRowsFromLib is milkRows' projection step split out from its own
// repo.GetLibrary() read — see beanRowsFromLib's doc comment (#901 code
// review finding #3).
func (h *LibraryHandlers) milkRowsFromLib(lib library.Library) []templates.MilkRow {
	rows := make([]templates.MilkRow, len(lib.Milks))
	for i, milk := range lib.Milks {
		rows[i] = toMilkRow(milk)
	}
	return rows
}

func (h *LibraryHandlers) milksPage(w http.ResponseWriter, r *http.Request) {
	rows, err := h.milkRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MilksPage(rows, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /milks: %v", err)
	}
}

func (h *LibraryHandlers) createMilkAction(w http.ResponseWriter, r *http.Request) {
	if !h.allowCreate(r) {
		h.renderMilksFragment(w, r, "Too many requests — please slow down")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderMilksFragment(w, r, "Invalid form submission")
		return
	}
	// stockMl is handed to library.CreateMilk as the raw submitted string,
	// same as every other field here — CreateMilk's own floatOrZero
	// coercion (jsParseFloat) already handles a string amount, matching
	// what POST /api/library/milk's JSON body decode produces. This used to
	// pre-parse with strconv.ParseFloat, stricter than floatOrZero and the
	// only one of the six create actions with different parsing behavior
	// from its own REST counterpart for the same field (#901 code review
	// finding #6).
	body := library.Entity{
		"name":    r.FormValue("name"),
		"emoji":   r.FormValue("emoji"),
		"stockMl": r.FormValue("stockMl"),
	}
	_, lib, err := library.CreateMilk(h.repo, body)
	if err != nil {
		var verr *library.ValidationError
		if errors.As(err, &verr) {
			h.renderMilksFragment(w, r, verr.Message)
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MilksContentFragment(h.milkRowsFromLib(lib), "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /milks fragment: %v", err)
	}
}

func (h *LibraryHandlers) renderMilksFragment(w http.ResponseWriter, r *http.Request, formError string) {
	rows, err := h.milkRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MilksContentFragment(rows, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /milks fragment: %v", err)
	}
}

// milkRowByID re-reads the library and returns the one row matching id —
// see beanRowByID's own doc comment.
func (h *LibraryHandlers) milkRowByID(id int64) (templates.MilkRow, bool, error) {
	rows, err := h.milkRows()
	if err != nil {
		return templates.MilkRow{}, false, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, true, nil
		}
	}
	return templates.MilkRow{}, false, nil
}

func (h *LibraryHandlers) milkViewAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid milk ID")
		return
	}
	row, found, err := h.milkRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Milk not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MilkFragment(row).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /milks/%d: %v", id, err)
	}
}

func (h *LibraryHandlers) milkEditAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid milk ID")
		return
	}
	row, found, err := h.milkRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Milk not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MilkEditFragment(row, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /milks/%d/edit: %v", id, err)
	}
}

// updateMilkAction ports the htmx `hx-put="milks/{id}"` interaction — same
// shape as updateBeanAction, built on library.UpdateMilk.
func (h *LibraryHandlers) updateMilkAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid milk ID")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderMilkEditError(w, r, id, "Invalid form submission")
		return
	}
	body := library.Entity{
		"name":    r.FormValue("name"),
		"emoji":   r.FormValue("emoji"),
		"stockMl": r.FormValue("stockMl"),
	}
	_, lib, found, err := library.UpdateMilk(h.repo, id, body)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Milk not found")
		return
	}
	for _, row := range h.milkRowsFromLib(lib) {
		if row.ID == id {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			if err := templates.MilkFragment(row).Render(r.Context(), w); err != nil {
				log.Printf("web: rendering PUT /milks/%d: %v", id, err)
			}
			return
		}
	}
	writeFragmentError(w, http.StatusNotFound, "Milk not found")
}

func (h *LibraryHandlers) renderMilkEditError(w http.ResponseWriter, r *http.Request, id int64, formError string) {
	row, found, err := h.milkRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Milk not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.MilkEditFragment(row, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering PUT /milks/%d error fragment: %v", id, err)
	}
}

func (h *LibraryHandlers) recipeRows() ([]templates.RecipeRow, error) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		return nil, err
	}
	return h.recipeRowsFromLib(lib), nil
}

// recipeRowsFromLib is recipeRows' projection step split out from its own
// repo.GetLibrary() read — see beanRowsFromLib's doc comment (#901 code
// review finding #3).
func (h *LibraryHandlers) recipeRowsFromLib(lib library.Library) []templates.RecipeRow {
	rows := make([]templates.RecipeRow, len(lib.Recipes))
	for i, recipe := range lib.Recipes {
		rows[i] = toRecipeRow(recipe)
	}
	return rows
}

func (h *LibraryHandlers) recipesPage(w http.ResponseWriter, r *http.Request) {
	rows, err := h.recipeRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.RecipesPage(rows, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /recipes: %v", err)
	}
}

func (h *LibraryHandlers) createRecipeAction(w http.ResponseWriter, r *http.Request) {
	if !h.allowCreate(r) {
		h.renderRecipesFragment(w, r, "Too many requests — please slow down")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderRecipesFragment(w, r, "Invalid form submission")
		return
	}
	body := library.Entity{
		"name":       r.FormValue("name"),
		"brewMethod": r.FormValue("brewMethod"),
		"drinkType":  r.FormValue("drinkType"),
	}
	_, lib, err := library.CreateRecipe(h.repo, body)
	if err != nil {
		var verr *library.ValidationError
		if errors.As(err, &verr) {
			h.renderRecipesFragment(w, r, verr.Message)
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.RecipesContentFragment(h.recipeRowsFromLib(lib), "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /recipes fragment: %v", err)
	}
}

func (h *LibraryHandlers) renderRecipesFragment(w http.ResponseWriter, r *http.Request, formError string) {
	rows, err := h.recipeRows()
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.RecipesContentFragment(rows, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering POST /recipes fragment: %v", err)
	}
}

// recipeRowByID re-reads the library and returns the one row matching id —
// see beanRowByID's own doc comment.
func (h *LibraryHandlers) recipeRowByID(id int64) (templates.RecipeRow, bool, error) {
	rows, err := h.recipeRows()
	if err != nil {
		return templates.RecipeRow{}, false, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, true, nil
		}
	}
	return templates.RecipeRow{}, false, nil
}

func (h *LibraryHandlers) recipeViewAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid recipe ID")
		return
	}
	row, found, err := h.recipeRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Recipe not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.RecipeFragment(row).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /recipes/%d: %v", id, err)
	}
}

func (h *LibraryHandlers) recipeEditAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid recipe ID")
		return
	}
	row, found, err := h.recipeRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Recipe not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.RecipeEditFragment(row, "").Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /recipes/%d/edit: %v", id, err)
	}
}

// updateRecipeAction ports the htmx `hx-put="recipes/{id}"` interaction —
// same shape as updateBeanAction, built on library.UpdateRecipe.
func (h *LibraryHandlers) updateRecipeAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseLibraryID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid recipe ID")
		return
	}
	if err := r.ParseForm(); err != nil {
		h.renderRecipeEditError(w, r, id, "Invalid form submission")
		return
	}
	body := library.Entity{
		"name":       r.FormValue("name"),
		"brewMethod": r.FormValue("brewMethod"),
		"drinkType":  r.FormValue("drinkType"),
		"notes":      r.FormValue("notes"),
	}
	_, lib, found, err := library.UpdateRecipe(h.repo, id, body)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Recipe not found")
		return
	}
	for _, row := range h.recipeRowsFromLib(lib) {
		if row.ID == id {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			if err := templates.RecipeFragment(row).Render(r.Context(), w); err != nil {
				log.Printf("web: rendering PUT /recipes/%d: %v", id, err)
			}
			return
		}
	}
	writeFragmentError(w, http.StatusNotFound, "Recipe not found")
}

func (h *LibraryHandlers) renderRecipeEditError(w http.ResponseWriter, r *http.Request, id int64, formError string) {
	row, found, err := h.recipeRowByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if !found {
		writeFragmentError(w, http.StatusNotFound, "Recipe not found")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.RecipeEditFragment(row, formError).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering PUT /recipes/%d error fragment: %v", id, err)
	}
}

// parseLibraryID parses a path {id} segment the same way handlers.go's
// parseShotID does for the Shots page: plain strconv (this path segment is
// always htmx's own hx-post URL built from a Row's ID, never user free
// text), with no upper bound — library entity ids are millisecond-epoch
// timestamps (see internal/library/model.go's newID), not the small
// sequential range internal/shots.MaxShotID caps.
func parseLibraryID(param string) (int64, bool) {
	id, err := strconv.ParseInt(param, 10, 64)
	if err != nil || id < 1 {
		return 0, false
	}
	return id, true
}
