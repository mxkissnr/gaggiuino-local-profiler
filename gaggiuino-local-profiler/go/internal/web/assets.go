package web

import (
	"embed"
	"io/fs"
	"net/http"
)

// staticFS embeds static/ (vendored htmx/Alpine, style.css, first-party
// glp-token.js) into the binary — no separate asset directory needs to
// ship alongside it at runtime, matching go/README.md's "single static Go
// binary" goal. See static/vendor/NOTICE.md for exactly what's vendored
// and why.
//
//go:embed static
var staticFS embed.FS

// staticHandler serves everything under static/ at the /web/static/
// prefix RegisterRoutes mounts it on.
func staticHandler() http.Handler {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		// static/ is embedded above in this same package — a missing
		// subtree here would be a build-time packaging bug, not a
		// runtime condition callers can recover from.
		panic("web: static assets not embedded: " + err.Error())
	}
	return http.StripPrefix("/web/static/", http.FileServer(http.FS(sub)))
}
