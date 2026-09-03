package web

import (
	"html"
	"log"
	"net/http"
	"strconv"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web/templates"
)

// Handlers wires shots.Service into the HTML handlers below — the same
// service internal/shots' own JSON handlers call, per this package's own
// doc comment above.
type Handlers struct {
	shots *shots.Service
}

// NewHandlers builds Handlers around svc.
func NewHandlers(svc *shots.Service) *Handlers {
	return &Handlers{shots: svc}
}

// webListCap bounds how many shots the no-JS templ views load (#957
// decision 7). listPage / detailFragment used to call Service.GetAll() +
// GetTrash(), each an O(history) scan that also scored every row; at 5000
// shots that made the fallback page multi-second. The SPA (public-src/) is
// the paginated experience — these server-rendered pages just show the
// latest webListCap with a "showing latest N" note.
const webListCap = 200

// RegisterRoutes registers this package's page and static-asset routes
// onto mux. Unlike every REST domain package's RegisterRoutes (see e.g.
// shots.Handlers.RegisterRoutes), these routes are NOT prefixed with
// /api/ — see this package's doc comment for why that's the auth-relevant
// choice, not an incidental one.
//
// Phase 1 (#901): cmd/server no longer registers these on the root mux. It
// passes a dedicated sub-mux that it mounts under /ui/ via
// http.StripPrefix, so "GET /shots" here is reached as GET /ui/shots and
// "GET /web/static/style.css" as GET /ui/web/static/style.css. The
// application root (GET /, GET /index.html, and every other static asset)
// now belongs to internal/webapp, which serves the production Vite SPA;
// these templ pages are the frozen no-JS fallback view. The
// leading-slash-free relative-path convention (this package's doc comment,
// "Ingress-safe relative paths") is unaffected: every page route is still
// exactly one segment deep relative to its siblings — just one segment
// deeper below /ui/, all together — so a relative link from /ui/shots to
// "beans" resolves to /ui/beans and to "web/static/style.css" resolves to
// /ui/web/static/style.css, prefix and all.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.Handle("GET /web/static/", staticHandler())
	mux.HandleFunc("GET /shots", h.listPage)
	mux.HandleFunc("GET /shots/{id}", h.detailFragment)
	mux.HandleFunc("POST /shots/{id}/trash", h.trashAction)
	mux.HandleFunc("POST /shots/{id}/restore", h.restoreAction)
}

// listPage ports GET /shots: Phase B's (#901) master-detail view — the
// live+trashed compact list (loadData()+loadTrashData() in public-src/
// views/shots/index.js) plus the newest live shot's own detail panel,
// pre-selected exactly like the SPA's own default (S.primaryShotId falls
// back to the most recent shot — see public-src/main.js's bootstrap). Both
// live and trashed are reversed from Repository's timestamp-ASC order into
// newest-first for display, matching that same default and every list
// UI's normal reading order.
func (h *Handlers) listPage(w http.ResponseWriter, r *http.Request) {
	live, err := h.shots.GetRecent(webListCap)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	trashed, err := h.shots.GetRecentTrash(webListCap)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}

	rows := make([]templates.ShotRow, len(live))
	for i, shot := range live {
		rows[i] = toShotRow(shot, h.shots.ComputeScore(shot))
	}
	trashRows := make([]templates.ShotRow, len(trashed))
	for i, shot := range trashed {
		trashRows[i] = toShotRow(shot, h.shots.ComputeScore(shot))
	}

	var detail *templates.ShotDetail
	if len(live) > 0 {
		d, err := h.buildDetail(live[0], rows)
		if err != nil {
			httputil.InternalError(w, "web", err)
			return
		}
		detail = &d
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.ShotsPage(rows, trashRows, detail, len(live) >= webListCap).Render(r.Context(), w); err != nil {
		// Render can only fail after writing has already started (a
		// broken client connection, mid-stream), so there's no valid
		// status code left to send — log and stop, matching net/http's
		// own convention for a write-time failure. httputil.InternalError
		// would be wrong here (a #901 code-review finding): it calls
		// WriteHeader(500) and writes a JSON error body, which after a
		// partial HTML write only produces a "superfluous WriteHeader"
		// warning plus a JSON blob appended straight after truncated HTML.
		log.Printf("web: rendering /shots: %v", err)
	}
}

// detailFragment ports GET /shots/{id}: the htmx fragment a shotRowActive
// click swaps into #shot-detail (hx-target/hx-swap="innerHTML" — see
// templates/shots.templ) — the same ShotDetailFragment template listPage's
// initial render uses for the pre-selected newest shot, so the two can
// never visually drift apart. A trashed shot's id still resolves (Service.
// GetByID doesn't filter by trash status — trashAction's own confirm step
// is the only place trashing removes a shot from view), which is harmless:
// nothing currently links a click at a trashed row to this route.
//
// A/B compare mode (#901, design pass 4 follow-up): an optional
// "?compare={id2}" query param (sent by ShotDetailFragment's own "Compare
// with…" <select>, hx-trigger="change") switches this same route to
// ShotCompareFragment instead — an invalid/unknown compare id is ignored
// (single-shot mode renders as if the param were absent) rather than
// erroring the whole request over what a stale/hand-edited query string
// got wrong, since single-shot mode is always a safe, valid fallback here.
func (h *Handlers) detailFragment(w http.ResponseWriter, r *http.Request) {
	id, ok := parseShotID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid shot ID")
		return
	}
	shot, err := h.shots.GetByID(id)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	if shot == nil {
		writeFragmentError(w, http.StatusNotFound, "Shot not found")
		return
	}

	if compareParam := r.URL.Query().Get("compare"); compareParam != "" {
		if compareID, ok := parseShotID(compareParam); ok && compareID != id {
			compareShot, err := h.shots.GetByID(compareID)
			if err != nil {
				httputil.InternalError(w, "web", err)
				return
			}
			if compareShot != nil {
				cd := templates.ShotCompareDetail{
					A: toShotDetail(shot, h.shots.ComputeScore(shot)),
					B: toShotDetail(compareShot, h.shots.ComputeScore(compareShot)),
				}
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				if err := templates.ShotCompareFragment(cd).Render(r.Context(), w); err != nil {
					log.Printf("web: rendering /shots/%d?compare=%d fragment: %v", id, compareID, err)
				}
				return
			}
		}
	}

	live, err := h.shots.GetRecent(webListCap)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	rows := make([]templates.ShotRow, len(live))
	for i, s := range live {
		rows[i] = toShotRow(s, h.shots.ComputeScore(s))
	}
	detail, err := h.buildDetail(shot, rows)
	if err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.ShotDetailFragment(detail).Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /shots/%d fragment: %v", id, err)
	}
}

// buildDetail is toShotDetail plus every same-profile-history field
// enrichWithComparison (view_shots_detail.go) adds — shared by listPage's
// initial pre-selected shot and detailFragment's single-shot (non-compare)
// path so the two can never drift apart, the same reasoning
// ShotDetailFragment's own doc comment already gives for the template
// itself. rows is the already-built, already-reversed (newest-first)
// []templates.ShotRow list both callers have anyway — reused here only for
// compareOptions' dropdown, no extra query.
func (h *Handlers) buildDetail(shot shots.Shot, rows []templates.ShotRow) (templates.ShotDetail, error) {
	score := h.shots.ComputeScore(shot)
	detail := toShotDetail(shot, score)

	previousShot, err := h.shots.GetPreviousByProfile(shot)
	if err != nil {
		return templates.ShotDetail{}, err
	}
	var previousScore *int
	if previousShot != nil {
		previousScore = h.shots.ComputeScore(previousShot)
	}
	compAdvice, err := h.shots.GetComparativeGrindAdvice(shot)
	if err != nil {
		return templates.ShotDetail{}, err
	}
	enrichWithComparison(&detail, score, previousShot, previousScore, compAdvice)

	id, _ := shot["id"].(int64)
	detail.CompareOptions = compareOptions(rows, id)
	return detail, nil
}

// trashAction ports the htmx `hx-post="/shots/{id}/trash"` interaction:
// trashes the shot and, on success, answers an empty 200 body so htmx's
// `hx-swap="outerHTML"` removes the row element entirely (see
// templates/shots.templ's shotRowActive) — no JSON envelope needed since
// nothing but htmx itself consumes this response.
func (h *Handlers) trashAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseShotID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid shot ID")
		return
	}
	if err := h.shots.TrashShot(id); err != nil {
		if err == shots.ErrShotNotFound {
			writeFragmentError(w, http.StatusNotFound, "Shot not found")
			return
		}
		httputil.InternalError(w, "web", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// restoreAction ports the htmx `hx-post="/shots/{id}/restore"` interaction
// — same empty-body-on-success pattern as trashAction, removing the row
// from the trash section.
func (h *Handlers) restoreAction(w http.ResponseWriter, r *http.Request) {
	id, ok := parseShotID(r.PathValue("id"))
	if !ok {
		writeFragmentError(w, http.StatusBadRequest, "Invalid shot ID")
		return
	}
	if err := h.shots.RestoreShot(id); err != nil {
		httputil.InternalError(w, "web", err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// parseShotID enforces the same positive-integer-within-MaxShotID bound
// internal/shots' own handlers.go's parseID does, using strconv directly
// rather than importing that package's unexported parseID/jsParseInt (this
// route doesn't need parseId()'s JS-parseInt leading-garbage tolerance —
// a path segment htmx itself always builds from row.ID, never user free
// text, so plain strconv.ParseInt's stricter all-digits-or-reject behavior
// is fine here).
func parseShotID(param string) (int64, bool) {
	id, err := strconv.ParseInt(param, 10, 64)
	if err != nil || id < 1 || id > shots.MaxShotID {
		return 0, false
	}
	return id, true
}

// writeFragmentError answers a small HTML fragment (not JSON — this
// route's only consumer is htmx, which swaps the response body straight
// into the DOM) at status, styled as a shot-row so it drops into the same
// hx-target the success path would have emptied.
func writeFragmentError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`<div class="shot-row"><span class="fragment-error" style="color:var(--err)">` + html.EscapeString(message) + `</span></div>`))
}
