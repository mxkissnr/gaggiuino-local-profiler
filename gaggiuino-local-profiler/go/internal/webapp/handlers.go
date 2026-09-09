package webapp

import (
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
)

// manifestLink is injected before </head> for non-Ingress requests, byte
// for byte what server.js's app.get(['/', '/index.html']) handler inserts.
const manifestLink = `    <link rel="manifest" href="manifest.json">` + "\n" + `</head>`

// Handlers serves the embedded SPA bundle. See this package's doc comment
// for the server.js parity it mirrors.
type Handlers struct {
	dist      fs.FS
	indexHTML []byte
}

// NewHandlers builds Handlers around the embedded dist/ build output.
func NewHandlers() *Handlers {
	return newHandlers(dist())
}

// newHandlers is the fs.FS-injectable core NewHandlers wraps — tests pass a
// fstest.MapFS so static-asset serving can be exercised without the real
// build having run.
func newHandlers(dist fs.FS) *Handlers {
	index, err := fs.ReadFile(dist, "index.html")
	if err != nil {
		// index.html is always present: a committed placeholder when the
		// Vite build hasn't run, the real shell when it has (see doc.go).
		panic("webapp: dist/index.html missing: " + err.Error())
	}
	return &Handlers{dist: dist, indexHTML: index}
}

// RegisterRoutes registers the SPA routes onto mux, following the codebase
// convention (see internal/web's *Handlers.RegisterRoutes). Not prefixed
// with /api/ — GET requests fall through auth.RequireToken's static-asset
// bypass exactly as the Node app's own static frontend does.
//
// "/" is a method-less catch-all: it only ever runs for paths no
// more-specific pattern claimed (every /api/* route, /shots.json, the /ui/
// templ subtree). It is registered without a method because a method-bound
// "GET /" conflicts with cmd/server's "/ui/" subtree pattern under
// net/http.ServeMux's precedence rules (neither is strictly more specific);
// static filters non-GET/HEAD itself instead. A genuinely unknown path
// 404s, matching express.static + Express's default 404 — the SPA is
// tab-driven with no client-side history routing, so there is no
// index.html fallback to serve.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", h.index)
	mux.HandleFunc("GET /index.html", h.index)
	mux.HandleFunc("/", h.static)
}

// index serves the server-templated index.html — see doc.go's "Handler
// parity with server.js".
func (h *Handlers) index(w http.ResponseWriter, r *http.Request) {
	html := h.indexHTML
	if !auth.IsIngressRequest(r) {
		// String.prototype.replace with a string pattern replaces the first
		// occurrence only — bytes.Replace with n=1 matches that.
		html = bytes.Replace(html, []byte("</head>"), []byte(manifestLink), 1)
	}
	setNoCache(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(html)
}

// static serves any other file under dist/. A missing file 404s; a
// directory 404s (no listings); a .html file gets the same no-cache
// headers express.static's setHeaders callback applies.
func (h *Handlers) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		// express.static ignores non-GET/HEAD and Express falls through to
		// its default 404; match that rather than sending a 405.
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	// GET / and GET /index.html have their own registrations; this guard
	// only matters if a future refactor routes them here.
	if name == "" || name == "index.html" {
		h.index(w, r)
		return
	}
	// Reject traversal / absolute lookups before touching the FS. fs.Valid
	// rejects "", leading "/", "." segments, "..", and non-slash separators.
	if !fs.ValidPath(name) {
		http.NotFound(w, r)
		return
	}

	f, err := h.dist.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	seeker, ok := f.(io.ReadSeeker)
	if !ok {
		// Every embed.FS regular file is an io.ReadSeeker; this only trips
		// under a test fs that returns a non-seeking file.
		http.Error(w, "asset not seekable", http.StatusInternalServerError)
		return
	}

	if strings.HasSuffix(name, ".html") {
		setNoCache(w)
	}
	// http.ServeContent sets Content-Type from the extension (falling back
	// to a content sniff), and handles Range / conditional requests. Embed
	// files report a zero ModTime, which ServeContent then omits rather
	// than sending a bogus Last-Modified.
	http.ServeContent(w, r, path.Base(name), info.ModTime(), seeker)
}

// setNoCache writes server.js's three no-cache headers for HTML responses.
func setNoCache(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	h.Set("Pragma", "no-cache")
	h.Set("Expires", "0")
}
