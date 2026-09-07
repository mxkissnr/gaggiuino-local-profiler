package achievements

import (
	"net/http"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// This file ports routes/achievements.js (the whole route is 22 lines):
//
//	GET /api/achievements?lang=<de|en|it|fr|es|nl>
//	  -> { cards: CARD_KEYS, badges: <state for lang> }
//
// Open badges always carry their real `stamp` (the frontend owns name/
// description via its own i18n bundle, keyed by id); secret badges carry
// neither `stamp` nor `name`/`description` until `unlocked` — see
// secrets.go's header for exactly what that does and doesn't protect.

// Handlers wires the Service into the one GET route.
type Handlers struct {
	svc *Service
}

// NewHandlers builds Handlers around a Service.
func NewHandlers(svc *Service) *Handlers {
	return &Handlers{svc: svc}
}

// RegisterRoutes registers GET /api/achievements onto mux.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/achievements", h.getAchievements)
}

func (h *Handlers) getAchievements(w http.ResponseWriter, r *http.Request) {
	lang := r.URL.Query().Get("lang")
	if !supportedLangs[lang] {
		lang = "en"
	}
	state, err := h.svc.GetState(lang)
	if err != nil {
		httputil.InternalError(w, "achievements", err)
		return
	}
	if state == nil {
		state = []map[string]any{}
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]any{
		"cards":  cards(),
		"badges": state,
	})
}
