package web

import (
	_ "embed"
	"net/http"
)

// kiosk.html is a single self-contained page (own inline CSS/JS, no build
// step) for running on a tablet as a walk-up ordering kiosk — distinct from
// GET /ui/menu (this package's other guest-facing page): that one assumes
// a phone visitor who leaves after one order, this one assumes a shared
// device sitting on a table all day, so it optimizes for large touch
// targets, guest-name-per-order (multiple people share the same tablet),
// and auto-resetting back to the picker a few seconds after each order
// instead of leaving a "thanks" screen up. It talks to the same JSON API
// (GET /api/menu, POST /api/orders, GET /api/orders + /api/orders/queue-eta
// for the "what's next" panel) that the main SPA and GET /orders use, so
// no new backend surface exists purely for this page.
//
//go:embed static/kiosk.html
var kioskHTML []byte

// RegisterKioskRoute registers GET /kiosk on the given mux — pass uiMux (so
// it ends up reachable at /ui/kiosk after main.go's StripPrefix("/ui", ...)
// mount), matching every other web.*Handlers page: its relative
// "web/static/kiosk.js" reference only resolves once this page itself sits
// one path segment below where that static handler is mounted. Auth-wise
// it needs no token since GET/HEAD to a non-/api/ path already bypasses
// auth.RequireToken (same registration-outside-/api/ model doc.go's "Auth
// model" section describes); its own JS bootstraps a token client-side for
// its /api/* calls exactly like static/glp-token.js does for the htmx
// pages.
func RegisterKioskRoute(mux *http.ServeMux) {
	mux.HandleFunc("GET /kiosk", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Write(kioskHTML)
	})
}
