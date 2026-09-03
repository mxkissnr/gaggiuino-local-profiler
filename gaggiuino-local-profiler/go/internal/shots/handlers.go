package shots

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// This file ports routes/shots.js's Express router onto Go 1.22+'s
// method-and-wildcard-pattern http.ServeMux (see RegisterRoutes). Two
// ordering subtleties in the Node original have no Go equivalent to
// replicate:
//
//   - Express matches routes in registration order, which is why
//     routes/shots.js registers '/api/shots/last' and '/api/shots/defaults'
//     *before* '/api/shots/:id' (a wildcard route registered first would
//     otherwise capture "last"/"defaults" as :id). Go's ServeMux instead
//     always prefers the most specific *pattern* regardless of registration
//     order — a literal segment ("/api/shots/last") always outranks a
//     wildcard one ("/api/shots/{id}") — so RegisterRoutes below has no
//     equivalent ordering requirement or comment to carry forward.
//   - routes/shots.js's POST /api/shots/:id/annotate runs its validate()
//     body-schema middleware *before* the handler's own id-parsing, so a
//     malformed body on an invalid-id request gets the validation 400, not
//     the "Invalid shot ID" 400. annotate() below preserves that exact
//     order (validate body, then parse id) even though Go's mux has
//     already routed the request by then.
const jsonBodyLimit = 16 * 1024 // express.json({ limit: '16kb' }) — server.js's global default; shots routes never override it.

// Handlers wires Service (+ its Repository, for the defaults/blocklist
// calls that don't go through Service) into net/http handlers.
type Handlers struct {
	service  *Service
	repo     *Repository
	imageDir string
	card     cardDeps
}

// SetCardDeps wires the two cross-domain lookups the share-card renderer
// (GET /api/shots/{id}/card) needs — the install-id short code and a
// bean-name → origin-country-code resolver. cmd/server passes closures over
// internal/db and internal/library so this package imports neither; either
// closure may be nil, in which case the card omits that piece exactly as
// lib/card.js does on a caught error. Optional: an unwired Handlers still
// renders a card, just without the footer install code / origin chip.
func (h *Handlers) SetCardDeps(installCode func() string, beanOriginCode func(coffeeName string) string) {
	h.card = cardDeps{installCode: installCode, beanOriginCode: beanOriginCode}
}

// NewHandlers builds Handlers around repo — the single DB-backed
// dependency every handler needs, matching cmd/server's existing
// db.Open()-then-wire-everything-else pattern. Image uploads are written
// under DefaultImageDir; tests construct a Handlers directly and override
// the unexported imageDir field to point at a throwaway directory instead
// (see helpers_test.go).
func NewHandlers(repo *Repository) *Handlers {
	return &Handlers{service: NewService(repo), repo: repo, imageDir: DefaultImageDir}
}

// RegisterRoutes registers every /shots.json and /api/shots/* route onto
// mux — see cmd/server's main.go for the middleware chain (security
// headers -> rate limit -> token auth) these routes run behind.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /shots.json", h.listShots)
	mux.HandleFunc("GET /api/shots", h.listShotsPage)
	mux.HandleFunc("GET /api/shots/last", h.lastShot)
	mux.HandleFunc("GET /api/shots/defaults", h.getDefaults)
	mux.HandleFunc("POST /api/shots/defaults", h.postDefaults)
	mux.HandleFunc("GET /api/shots/{id}", h.getShot)
	mux.HandleFunc("GET /api/shots/{id}/card", h.getCard)
	mux.HandleFunc("POST /api/shots/{id}/annotate", h.annotate)
	mux.HandleFunc("POST /api/shots/{id}/trash", h.trash)
	mux.HandleFunc("POST /api/shots/{id}/restore", h.restore)
	mux.HandleFunc("POST /api/shots/{id}/delete", h.delete)
	mux.HandleFunc("GET /api/shots/{id}/image", h.getImage)
	mux.HandleFunc("POST /api/shots/{id}/image", h.postImage)
	mux.HandleFunc("DELETE /api/shots/{id}/image", h.deleteImage)
}

// ── response helpers ────────────────────────────────────────────────────
//
// writeJSON / writeError live in json.go — the package-local goccy-backed
// equivalents of httputil.WriteJSON / httputil.WriteError (#951).

func withScore(shot Shot, detail ScoreDetail) Shot {
	out := shot.clone()
	out["score"] = detail.Score
	out["usedBeanTarget"] = detail.UsedBeanTarget
	return out
}

// ── id parsing ──────────────────────────────────────────────────────────

// jsParseInt ports JS's parseInt(s, 10): skip leading whitespace, an
// optional sign, then consume as many leading decimal digits as present
// ("123abc" -> 123, ok); no digits at all (after whitespace/sign) is NaN
// ("abc" -> not ok). strconv.ParseInt/Atoi are both stricter — they reject
// any trailing garbage outright — which would diverge from parseId()'s
// behavior in routes/shots.js for a param like "123abc".
func jsParseInt(s string) (int64, bool) {
	i, n := 0, len(s)
	for i < n {
		switch s[i] {
		case ' ', '\t', '\n', '\r', '\v', '\f':
			i++
			continue
		}
		break
	}
	start := i
	if i < n && (s[i] == '+' || s[i] == '-') {
		i++
	}
	digitsStart := i
	for i < n && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == digitsStart {
		return 0, false
	}
	v, err := strconv.ParseInt(s[start:i], 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// parseID ports routes/shots.js's parseId(param).
func parseID(param string) (int64, bool) {
	id, ok := jsParseInt(param)
	if !ok || id < 1 || id > MaxShotID {
		return 0, false
	}
	return id, true
}

// ── body decoding ───────────────────────────────────────────────────────

// decodeJSONBody ports express.json({limit:'16kb'})'s two failure modes:
// a body over the limit becomes a 413 (body-parser's own
// entity.too.large -> lib/middleware/error.js's status>=400,<500 branch),
// anything else that fails to parse becomes a 400. writes the error
// response itself and returns ok=false on either.
func decodeJSONBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	body, ok := httputil.DecodeJSONBody[map[string]any](w, r, jsonBodyLimit)
	if !ok {
		return nil, false
	}
	if body == nil {
		body = map[string]any{}
	}
	return body, true
}

// ── handlers ────────────────────────────────────────────────────────────

// listShots ports GET /shots.json.
func (h *Handlers) listShots(w http.ResponseWriter, r *http.Request) {
	var (
		list []Shot
		err  error
	)
	if r.URL.Query().Get("trash") == "1" {
		list, err = h.service.GetTrash()
	} else {
		list, err = h.service.GetAll()
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	out := make([]Shot, len(list))
	for i, shot := range list {
		out[i] = withScore(shot, h.service.ComputeScoreDetail(shot))
	}
	writeJSON(w, http.StatusOK, out)
}

// listShotsPage serves GET /api/shots (#957): a keyset-paginated,
// newest-first list of shot METADATA — every hydrated-shot field except the
// `datapoints` curve blob, plus score/usedBeanTarget/hasChartData. Unlike
// /shots.json (full dump, kept byte-for-byte for the HA integration) no
// response here carries the full-history curve payload, and no request
// decodes more than one page of datapoints.
//
// Query params: limit (default 60, clamped 1..200), cursor (opaque, empty =
// first page), machine (int; absent or "all" = every machine), trash ("1" =
// the trash list). A malformed cursor is a 400 — a client paging with a
// stale cursor should find out, not silently restart at page 1.
func (h *Handlers) listShotsPage(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	limit := 0
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}

	cursor, err := DecodeCursor(q.Get("cursor"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "Invalid cursor")
		return
	}

	var machineID int64
	if m := q.Get("machine"); m != "" && m != "all" {
		n, err := strconv.ParseInt(m, 10, 64)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "Invalid machine")
			return
		}
		machineID = n
	}

	var page Page
	if q.Get("trash") == "1" {
		page, err = h.service.GetTrashPage(cursor, limit, machineID)
	} else {
		page, err = h.service.GetPage(cursor, limit, machineID)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	shotsOut := make([]Shot, len(page.Rows))
	for i, row := range page.Rows {
		out := row.Shot.clone()
		stripDatapoints(out)
		out["score"] = row.Score
		out["usedBeanTarget"] = row.UsedBeanTarget
		out["hasChartData"] = row.HasChartData
		out["tempStabilityDev"] = row.TempStabilityDev
		shotsOut[i] = out
	}

	var nextCursor *string
	if page.HasMore {
		s := EncodeCursor(page.NextCursor)
		nextCursor = &s
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"shots":      shotsOut,
		"nextCursor": nextCursor,
		"hasMore":    page.HasMore,
	})
}

// lastShot ports GET /api/shots/last. Node reads shotService.getAll() and
// keeps `shots[shots.length - 1]`; this fetches only that one shot (see
// Service.GetLast / Repository.FindLastExcludingTrash) instead of hydrating
// the whole history to discard all but the newest (#951).
func (h *Handlers) lastShot(w http.ResponseWriter, r *http.Request) {
	last, err := h.service.GetLast()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if last == nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	writeJSON(w, http.StatusOK, withScore(last, h.service.ComputeScoreDetail(last)))
}

// getDefaults ports GET /api/shots/defaults (#654).
func (h *Handlers) getDefaults(w http.ResponseWriter, r *http.Request) {
	defaults, err := h.repo.GetShotDefaults()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, defaults)
}

// shotDefaultsFromBody ports routes/shots.js's POST /api/shots/defaults
// handler's explicit field-by-field pick with `?? null` / `?? empty
// string` fallbacks.
func shotDefaultsFromBody(body map[string]any) map[string]any {
	get := func(key string) any {
		if v, ok := body[key]; ok {
			return v
		}
		return nil
	}
	grinder := ""
	if v, ok := body["grinder"]; ok {
		if s, ok2 := v.(string); ok2 {
			grinder = s
		}
	}
	return map[string]any{
		"drinkType":    get("drinkType"),
		"coffee":       get("coffee"),
		"beanId":       get("beanId"),
		"basketId":     get("basketId"),
		"puckScreenId": get("puckScreenId"),
		"grinder":      grinder,
		"dose":         get("dose"),
	}
}

// postDefaults ports POST /api/shots/defaults.
func (h *Handlers) postDefaults(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	if issues := ValidateShotDefaults(body); len(issues) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Validation failed", "issues": issues})
		return
	}
	defaults := shotDefaultsFromBody(body)
	if err := h.repo.SaveShotDefaults(defaults); err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, defaults)
}

// getShot ports GET /api/shots/:id. Note this returns 200 null for both an
// invalid id AND a valid-but-nonexistent one — never a 400/404 — matching
// routes/shots.js exactly (`if (!id) return res.json(null)`;
// `if (!shot) return res.json(null)`).
func (h *Handlers) getShot(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusOK, nil)
		return
	}
	shot, err := h.service.GetByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if shot == nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}

	previous, err := h.service.GetPreviousByProfile(shot)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	resp := withScore(shot, h.service.ComputeScoreDetail(shot))
	if previous != nil {
		resp["previousShotId"] = previous["id"]
		resp["previousShot"] = withScore(previous, h.service.ComputeScoreDetail(previous))
	} else {
		resp["previousShotId"] = nil
		resp["previousShot"] = nil
	}
	writeJSON(w, http.StatusOK, resp)
}

// getCard ports routes/shots.js's GET /api/shots/:id/card — the share-card
// PNG (lib/card.js). See internal/shots/card.go for the SVG-template +
// resvg-wasm approach and the list of deliberate cosmetic deviations.
//
// routes/shots.js's `if (!cardAvailable()) return res.status(503)` branch
// has no equivalent: the renderer is always compiled into this binary. The
// frontend treats 501/503 identically ("card unavailable"), so a partial
// Go rollout is safe regardless. Node sets no Cache-Control on this route,
// only Content-Type + Content-Disposition — matched exactly.
func (h *Handlers) getCard(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid shot ID")
		return
	}
	shot, err := h.service.GetByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if shot == nil {
		writeError(w, http.StatusNotFound, "Shot not found")
		return
	}

	format := "square"
	if r.URL.Query().Get("format") == "story" {
		format = "story"
	}
	accent := r.URL.Query().Get("accent")
	theme := r.URL.Query().Get("theme")

	png, err := renderShareCard(shot, h.service.ComputeScore(shot), format, accent, theme, h.card)
	if err != nil {
		log.Printf("shots: share-card render for shot %d failed: %v", id, err)
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="glp-shot-%d-%s.png"`, id, format))
	w.WriteHeader(http.StatusOK)
	w.Write(png)
}

// annotate ports POST /api/shots/:id/annotate. Body validation runs before
// id parsing — see this file's header comment for why that order matters.
// SaveAnnotation itself has no existence check (matching ShotService.js's
// saveAnnotation), but annotations.shot_id REFERENCES shots(id) with
// foreign_keys=ON in both Node and Go, so annotating an id that isn't an
// actual shot row still fails — as a foreign-key constraint error, mapped
// to a generic 500 by both runtimes' error handling, not a 4xx — see
// handlers_test.go's TestAnnotate_NonexistentShotFailsOnForeignKey.
//
// libraryService.checkLowStockNotify(req.body) (the fire-and-forget
// low-stock notification routes/shots.js's annotate handler kicks off
// afterwards) is NOT called here: it needs internal/library (bean
// resolution, bag stock, HA-notify settings), which is still a Phase 0
// placeholder. Wire it in once the Library phase lands — until then,
// annotating a shot in the Go server never sends a low-stock notification.
func (h *Handlers) annotate(w http.ResponseWriter, r *http.Request) {
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	if issues := ValidateAnnotation(body); len(issues) > 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Validation failed", "issues": issues})
		return
	}
	id, ok := parseID(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid shot ID")
		return
	}
	if err := h.service.SaveAnnotation(id, body); err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// trash ports POST /api/shots/:id/trash.
func (h *Handlers) trash(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid shot ID")
		return
	}
	if err := h.service.TrashShot(id); err != nil {
		if errors.Is(err, ErrShotNotFound) {
			writeError(w, http.StatusNotFound, "Shot not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// restore ports POST /api/shots/:id/restore — no existence check, matching
// the Node original.
func (h *Handlers) restore(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid shot ID")
		return
	}
	if err := h.service.RestoreShot(id); err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// delete ports POST /api/shots/:id/delete: permanently deletes and adds
// the id to the blocklist so a later re-import/re-sync never resurrects it.
// The blocklist add goes through AppendToBlocklist's atomic INSERT OR
// IGNORE rather than a GetBlocklist+SaveBlocklist read-modify-write — see
// Repository.AppendToBlocklist's doc comment for why the latter loses
// updates under concurrent deletes (#901).
func (h *Handlers) delete(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid shot ID")
		return
	}
	shot, err := h.service.GetByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if shot == nil {
		writeError(w, http.StatusNotFound, "Shot not found")
		return
	}
	if err := h.service.PermanentDelete(id); err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if err := h.service.AppendToBlocklist(strconv.FormatInt(id, 10)); err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// getImage ports GET /api/shots/:id/image. An invalid id is treated
// exactly like "no image" (404), not a 400 — matching routes/shots.js's
// `const shot = id ? shotService.getById(id) : null;` (an invalid id
// short-circuits to shot = null before the 404 check, same outcome as a
// valid id with no shot).
func (h *Handlers) getImage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.PathValue("id"))
	var shot Shot
	if ok {
		var err error
		shot, err = h.service.GetByID(id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Internal server error")
			return
		}
	}
	ext := shot.imageExt()
	contentType, known := img.ExtContentType[ext]
	if ext == "" || !known {
		writeError(w, http.StatusNotFound, "no image")
		return
	}
	// `?thumb=1` serves the downscaled variant when present and otherwise
	// falls back to the full image — a missing thumbnail never 404s.
	thumb := r.URL.Query().Get("thumb") == "1"
	path := img.ServePath(h.imageDir, id, ext, "shot-", thumb)
	if _, err := os.Stat(path); err != nil {
		writeError(w, http.StatusNotFound, "no image")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Type", contentType)
	http.ServeFile(w, r, path)
}

// postImage ports POST /api/shots/:id/image (raw body upload, no URL
// fetch — see image.go's doc comment).
func (h *Handlers) postImage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid shot ID")
		return
	}
	shot, err := h.service.GetByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if shot == nil {
		writeError(w, http.StatusNotFound, "Shot not found")
		return
	}

	contentType := r.Header.Get("Content-Type")
	_, typeKnown := img.ContentTypeKnown(contentType)

	r.Body = http.MaxBytesReader(w, r.Body, img.MaxBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request entity too large")
		return
	}
	// Mirrors routes/shots.js's `!Buffer.isBuffer(req.body) ||
	// req.body.length === 0`: express.raw() only populates req.body as a
	// Buffer when Content-Type matches its whitelist, so an unrecognized
	// content type reaches the same "no image data" branch an empty body
	// does, distinctly from img.Save's own "unsupported image" check below.
	if !typeKnown || len(data) == 0 {
		writeError(w, http.StatusBadRequest, "no image data")
		return
	}

	ext, ok := img.Save(h.imageDir, "shot-", id, data, contentType, img.ModeUpload)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported image")
		return
	}
	if oldExt := shot.imageExt(); oldExt != "" && oldExt != ext {
		img.Delete(h.imageDir, id, oldExt, "shot-")
	}
	updated, err := h.service.SetImage(id, ext)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	// Only `score` is added here, not `usedBeanTarget` — matches
	// routes/shots.js's `res.json({ ...updated, score:
	// shotService.computeScore(updated) })` exactly.
	resp := updated.clone()
	resp["score"] = h.service.ComputeScore(updated)
	writeJSON(w, http.StatusOK, resp)
}

// deleteImage (method) ports DELETE /api/shots/:id/image. It stays named
// deleteImage on the Handlers receiver, mirroring the route it serves the
// same way every other handler here mirrors its route name.
func (h *Handlers) deleteImage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "Invalid shot ID")
		return
	}
	shot, err := h.service.GetByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if shot == nil {
		writeError(w, http.StatusNotFound, "Shot not found")
		return
	}
	if ext := shot.imageExt(); ext != "" {
		img.Delete(h.imageDir, id, ext, "shot-")
	}
	updated, err := h.service.ClearImage(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "shot": updated})
}
