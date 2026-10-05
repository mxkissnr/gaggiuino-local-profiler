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

// manifestLink is injected before </head> for non-Ingress requests.
const manifestLink = `    <link rel="manifest" href="manifest.json">` + "\n" + `</head>`

// Handlers serves the embedded SPA bundle. See this package's doc comment
// for the handler behavior it follows.
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
// convention. Not prefixed with /api/ — GET requests fall through
// auth.RequireToken's static-asset bypass.
//
// "/" is a method-less catch-all: it only ever runs for paths no
// more-specific pattern claimed (every /api/* route, /shots.json, the
// /ui/kiosk redirect below). It is registered without a method because a
// method-bound "GET /" conflicts with cmd/server's method-less "/api/events"
// route under net/http.ServeMux's precedence rules (neither is strictly
// more specific); static filters non-GET/HEAD itself instead. A genuinely
// unknown path 404s — the SPA is tab-driven with no client-side history
// routing, so there is no index.html fallback to serve.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", h.index)
	mux.HandleFunc("GET /index.html", h.index)
	// GET /ui/kiosk is the pre-#1267 tablet kiosk address. It answers with a
	// relative redirect onto the rebuilt kiosk page; see kioskRedirect for
	// why the Location must stay relative.
	mux.HandleFunc("GET /ui/kiosk", h.kioskRedirect)
	mux.HandleFunc("/", h.static)
}

// kioskRedirect forwards the old /ui/kiosk bookmark (#1267) to the rebuilt
// TypeScript kiosk at /kiosk.html. The target is deliberately relative: under
// HA Ingress a request arrives at /api/hassio_ingress/<token>/ui/kiosk, so
// "../kiosk.html" resolves against the browser's own address bar (prefix
// included) where a leading slash would escape to the origin root. The raw
// query is carried over so old links like ?eink=1 still reach the new page.
func (h *Handlers) kioskRedirect(w http.ResponseWriter, r *http.Request) {
	loc := "../kiosk.html"
	if r.URL.RawQuery != "" {
		loc += "?" + r.URL.RawQuery
	}
	w.Header().Set("Location", loc)
	w.WriteHeader(http.StatusFound)
}

// index serves the templated index.html — see doc.go's "Handler behavior".
func (h *Handlers) index(w http.ResponseWriter, r *http.Request) {
	html := h.indexHTML
	if !auth.IsIngressRequest(r) {
		// Only the first occurrence of a string pattern is replaced —
		// bytes.Replace with n=1 does the same.
		html = bytes.Replace(html, []byte("</head>"), []byte(manifestLink), 1)
	}
	setNoCache(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(html)
}

// static serves any other file under dist/. A missing file 404s; a
// directory 404s (no listings); a .html file gets the same no-cache
// headers.
func (h *Handlers) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		// Non-GET/HEAD requests 404 rather than 405.
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

	// Everything under assets/ is content-hashed by cmd/frontend-build, so a
	// given name's bytes never change and it can be cached indefinitely; a new
	// build changes the name instead. This covers the embedded onnxruntime-web
	// runtime files (#1404) as much as the JS/CSS bundles.
	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
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

// setNoCache writes the three no-cache headers for HTML responses.
func setNoCache(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	h.Set("Pragma", "no-cache")
	h.Set("Expires", "0")
}
