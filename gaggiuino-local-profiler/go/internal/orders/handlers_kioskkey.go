package orders

import (
	"net/http"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
)

// ── Kiosk key ────────────────────────────────────────────────────────────

// SetKioskKeyStore wires the guest kiosk's orders-only key store (#1731), the
// same *auth.KioskKeyStore RequireToken consults. Without it both kiosk-key
// routes answer 503 rather than panicking: only cmd/server's real wiring is
// expected to leave this unset.
func (h *Handlers) SetKioskKeyStore(kiosk *auth.KioskKeyStore) {
	h.kioskKey = kiosk
}

// getKioskKey serves GET /api/orders/kiosk-key: the current orders-only key,
// created on the first call.
func (h *Handlers) getKioskKey(w http.ResponseWriter, r *http.Request) {
	key, ok := h.currentKioskKey(w, func() (string, error) { return h.kioskKey.Get() })
	if !ok {
		return
	}
	writeKioskKey(w, key)
}

// rotateKioskKey serves POST /api/orders/kiosk-key/rotate: a freshly generated
// key, after which the previous one no longer authenticates anywhere.
func (h *Handlers) rotateKioskKey(w http.ResponseWriter, r *http.Request) {
	key, ok := h.currentKioskKey(w, func() (string, error) { return h.kioskKey.Rotate() })
	if !ok {
		return
	}
	writeKioskKey(w, key)
}

func (h *Handlers) currentKioskKey(w http.ResponseWriter, get func() (string, error)) (string, bool) {
	if h.kioskKey == nil {
		writeError(w, http.StatusServiceUnavailable, "kiosk key unavailable")
		return "", false
	}
	key, err := get()
	if err != nil {
		internalError(w, err)
		return "", false
	}
	return key, true
}

func writeKioskKey(w http.ResponseWriter, key string) {
	// The body is a credential, so keep it out of any HTTP cache.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"kioskKey": key})
}
