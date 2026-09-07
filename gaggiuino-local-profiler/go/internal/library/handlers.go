package library

import (
	"io"
	"net/http"
	"os"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports routes/library/{index,beans,grinders,baskets,puckscreens,
// milks,recipes}.js's Express routers onto Go 1.22+'s method-and-wildcard
// http.ServeMux, the same pattern shots/handlers.go established in Phase
// 1c — see that file's header comment for the registration-order caveat
// that doesn't apply here either (ServeMux always prefers the most
// specific literal pattern, so e.g. "/api/library/beans-info" always wins
// over "/api/library/bean/{id}" regardless of registration order).
//
// scan.go's barcode-lookup handler registers through the same mux but lives
// in its own file given its SSRF-guard-heavy shape.

const jsonBodyLimit = 16 * 1024 // express.json({ limit: '16kb' }) — server.js's global default.

// Handlers wires Repository (+ a shots.Repository for grinder wear stats,
// see service.go's ComputeGrinderWearStats doc comment) into net/http
// handlers.
type Handlers struct {
	repo            *Repository
	shotsRepo       *shots.Repository
	imageDir        string
	limiter         *rateLimiter
	onGrinderDelete func(grinderID int64) error
}

// SetOnGrinderDeleted wires the maintenance domain's cleanup of a deleted
// grinder's `grinder_{id}` maintenance-table row (LibraryService.js's
// getMaintenance()/saveMaintenance() round trip in the Node original's
// grinder-delete handler) as a callback rather than a direct import: this
// package already gets imported BY internal/maintenance (for grinder
// existence checks in canonicalTask() and grinder names in
// getMaintenance()/getMaintenanceLog()), so importing internal/maintenance
// back from here would close a cycle. cmd/server calls this once at
// startup, after both packages' Handlers exist — see main.go. A nil hook
// (never wired, e.g. in this package's own unit tests) is a no-op, matching
// the deferred behavior deleteGrinder had before Phase 1f: deleting a
// grinder leaves its `maintenance` row in place (harmless — getMaintenance
// only iterates the library's actual grinders — but not the active Node
// cleanup) — see this file's deleteGrinder doc comment.
func (h *Handlers) SetOnGrinderDeleted(fn func(grinderID int64) error) {
	h.onGrinderDelete = fn
}

// NewHandlers builds Handlers around repo and shotsDB (the same *sql.DB
// cmd/server already opens once and shares across every domain package —
// see shots.NewRepository's own call site in main.go). Image uploads are
// written under DefaultImageDir; tests override the unexported imageDir
// field to point at a throwaway directory instead (see helpers_test.go).
func NewHandlers(repo *Repository, shotsRepo *shots.Repository) *Handlers {
	return &Handlers{repo: repo, shotsRepo: shotsRepo, imageDir: DefaultImageDir, limiter: newRateLimiter()}
}

// RegisterRoutes registers every /api/library/* route onto mux.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/library", h.getLibrary)
	mux.HandleFunc("GET /api/library/beans-info", h.getBeansInfo)

	mux.HandleFunc("POST /api/library/bean", h.createBean)
	mux.HandleFunc("PUT /api/library/bean/{id}", h.updateBean)
	mux.HandleFunc("POST /api/library/bean/{id}/new-bag", h.newBag)
	mux.HandleFunc("POST /api/library/bean/{id}/freeze-portions", h.freezePortions)
	mux.HandleFunc("POST /api/library/bean/{id}/thaw-portion", h.thawPortion)
	mux.HandleFunc("POST /api/library/bean/{id}/adjust-frozen-portion", h.adjustFrozenPortion)
	mux.HandleFunc("DELETE /api/library/bean/{id}/bag/{bagId}", h.deleteBag)
	mux.HandleFunc("POST /api/library/bean/{id}/delete", h.deleteBean)
	mux.HandleFunc("POST /api/library/bean/{id}/toggle-active", h.toggleBeanActive)
	mux.HandleFunc("POST /api/library/bean/{id}/known-grind", h.knownGrind)
	mux.HandleFunc("GET /api/library/bean/{id}/image", h.getBeanImage)
	mux.HandleFunc("POST /api/library/bean/{id}/image", h.postBeanImage)

	mux.HandleFunc("POST /api/library/grinder", h.createGrinder)
	mux.HandleFunc("PUT /api/library/grinder/{id}", h.updateGrinder)
	mux.HandleFunc("POST /api/library/grinder/{id}/reset-burrs", h.resetBurrs)
	mux.HandleFunc("POST /api/library/grinder/{id}/delete", h.deleteGrinder)
	mux.HandleFunc("GET /api/library/grinder/{id}/image", h.getGrinderImage)
	mux.HandleFunc("POST /api/library/grinder/{id}/image", h.postGrinderImage)

	mux.HandleFunc("GET /api/library/baskets", h.listBaskets)
	mux.HandleFunc("POST /api/library/basket", h.createBasket)
	mux.HandleFunc("PUT /api/library/basket/{id}", h.updateBasket)
	mux.HandleFunc("DELETE /api/library/basket/{id}", h.deleteBasket)
	mux.HandleFunc("GET /api/library/basket/{id}/image", h.getBasketImage)
	mux.HandleFunc("POST /api/library/basket/{id}/image", h.postBasketImage)

	mux.HandleFunc("GET /api/library/puckscreens", h.listPuckScreens)
	mux.HandleFunc("POST /api/library/puckscreen", h.createPuckScreen)
	mux.HandleFunc("PUT /api/library/puckscreen/{id}", h.updatePuckScreen)
	mux.HandleFunc("DELETE /api/library/puckscreen/{id}", h.deletePuckScreen)
	mux.HandleFunc("GET /api/library/puckscreen/{id}/image", h.getPuckScreenImage)
	mux.HandleFunc("POST /api/library/puckscreen/{id}/image", h.postPuckScreenImage)

	mux.HandleFunc("GET /api/library/milks", h.listMilks)
	mux.HandleFunc("POST /api/library/milk", h.createMilk)
	mux.HandleFunc("PUT /api/library/milk/{id}", h.updateMilk)
	mux.HandleFunc("DELETE /api/library/milk/{id}", h.deleteMilk)
	mux.HandleFunc("POST /api/library/milk/{id}/deduct", h.deductMilk)
	mux.HandleFunc("POST /api/library/milk/{id}/restock", h.restockMilk)

	mux.HandleFunc("POST /api/library/recipe", h.createRecipe)
	mux.HandleFunc("PUT /api/library/recipe/{id}", h.updateRecipe)
	mux.HandleFunc("POST /api/library/recipe/{id}/delete", h.deleteRecipe)

	h.registerScanRoute(mux)
}

// ── response helpers (see internal/httputil) ─────────────────────────────

var (
	writeJSON  = httputil.WriteJSON
	writeError = httputil.WriteError
)

func internalError(w http.ResponseWriter, err error) {
	httputil.InternalError(w, "library", err)
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request) (Entity, bool) {
	body, ok := httputil.DecodeJSONBody[Entity](w, r, jsonBodyLimit)
	if !ok {
		return nil, false
	}
	if body == nil {
		body = Entity{}
	}
	return body, true
}

// rateLimitCreate ports the `if (!rateLimit(\`lib:${req.ip}\`, 30))` guard
// every library create-endpoint (bean/grinder/basket/milk/puckscreen/
// recipe) opens with.
func (h *Handlers) rateLimitCreate(w http.ResponseWriter, r *http.Request) bool {
	if h.limiter.allow("lib:"+auth.RemoteIP(r), 30) {
		return true
	}
	writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
	return false
}

// ── GET /api/library, GET /api/library/beans-info ─────────────────────────

// getLibrary ports GET /api/library: the full Library object, grinders
// enriched with a computed `wear` field on read (not stored) — see
// service.go's ComputeGrinderWearStats.
func (h *Handlers) getLibrary(w http.ResponseWriter, r *http.Request) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	var allShots []shots.Shot
	if len(lib.Grinders) > 0 {
		allShots, err = h.shotsRepo.FindAllExcludingTrash()
		if err != nil {
			internalError(w, err)
			return
		}
	}
	grinders := make([]Entity, len(lib.Grinders))
	for i, g := range lib.Grinders {
		shotsSince, gramsSince := ComputeGrinderWearFrom(allShots, g)
		grinders[i] = withWearEntity(g, shotsSince, gramsSince)
	}
	lib.Grinders = grinders
	writeJSON(w, http.StatusOK, lib)
}

// withWear ports `{ ...g, wear: libraryService.computeGrinderWearStats(g) }`.
// Field names are shotsSinceBurrs/gramsSinceBurrs, matching
// LibraryService.js's actual return shape — NOT openapi.yaml's Grinder.wear
// schema (documented there as `{shots, grams}`), which drifted from the
// real implementation; this package matches Node's real runtime behavior,
// same "doc vs. code disagree, code wins" rule shots/doc.go states.
func (h *Handlers) withWear(grinder Entity) Entity {
	shotsSince, gramsSince, err := ComputeGrinderWearStats(h.shotsRepo, grinder)
	if err != nil {
		return withWearEntity(grinder, 0, 0)
	}
	return withWearEntity(grinder, shotsSince, gramsSince)
}

// withWearEntity returns a copy of grinder with the computed `wear` field
// attached — the enrichment step shared by the single-grinder withWear and
// getLibrary's single-pass loop.
func withWearEntity(grinder Entity, shotsSince int, gramsSince float64) Entity {
	out := make(Entity, len(grinder)+1)
	for k, v := range grinder {
		out[k] = v
	}
	out["wear"] = Entity{"shotsSinceBurrs": shotsSince, "gramsSinceBurrs": gramsSince}
	return out
}

// getBeansInfo ports GET /api/library/beans-info.
func (h *Handlers) getBeansInfo(w http.ResponseWriter, r *http.Request) {
	lib, err := h.repo.GetLibrary()
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, GetBeansInfo(lib))
}

// ── image handling shared by bean/grinder/basket/puckscreen ───────────────

// serveImage ports the repeated `GET .../image` handler shape: 404 with
// {error:"no image"} when the entity/image is missing, otherwise serves the
// file with a 24h cache header.
func (h *Handlers) serveImage(w http.ResponseWriter, r *http.Request, ext, prefix string, id int64) {
	contentType, known := img.ExtContentType[ext]
	if ext == "" || !known {
		writeError(w, http.StatusNotFound, "no image")
		return
	}
	// `?thumb=1` serves the downscaled variant when present and otherwise
	// falls back to the full image — a missing thumbnail never 404s.
	thumb := r.URL.Query().Get("thumb") == "1"
	path := img.ServePath(h.imageDir, id, ext, prefix, thumb)
	if _, err := os.Stat(path); err != nil {
		writeError(w, http.StatusNotFound, "no image")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Type", contentType)
	http.ServeFile(w, r, path)
}

// readUploadedImage ports the repeated `express.raw({type:
// Object.keys(CONTENT_TYPE_EXT), limit: BEAN_IMAGE_MAX_BYTES})` body
// handling every entity's `POST .../image` route uses: an unrecognized
// Content-Type or an empty body is "no image data" (400); an oversized body
// is rejected by MaxBytesReader before ever reaching img.Save's own size
// check.
func readUploadedImage(w http.ResponseWriter, r *http.Request) (data []byte, contentType string, ok bool) {
	contentType = r.Header.Get("Content-Type")
	_, typeKnown := img.ContentTypeKnown(contentType)
	r.Body = http.MaxBytesReader(w, r.Body, img.MaxBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request entity too large")
		return nil, "", false
	}
	if !typeKnown || len(data) == 0 {
		writeError(w, http.StatusBadRequest, "no image data")
		return nil, "", false
	}
	return data, contentType, true
}
