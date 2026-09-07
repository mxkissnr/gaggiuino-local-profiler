package webapp

import (
	"embed"
	"io/fs"
)

// distFS embeds the Vite/rolldown SPA build output. `all:` so Vite's
// underscore/dot-prefixed emitted assets are included too. Only a
// committed dist/index.html placeholder is tracked in git — the real
// bundle is staged by `make -C go frontend` / the Dockerfile's frontend
// stage; see this package's doc comment.
//
//go:embed all:dist
var distFS embed.FS

// dist returns the embedded build output rooted at dist/.
func dist() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		// dist/ is embedded above in this same package — a missing subtree
		// here is a build-time packaging bug, not a runtime condition a
		// caller can recover from (matches internal/web/assets.go).
		panic("webapp: dist assets not embedded: " + err.Error())
	}
	return sub
}
