package webapp

import (
	"io"
	"io/fs"
	"net/http"
	"os"
	"strings"
)

// ModelHandlers serves the on-device cut-out model files (the IS-Net/SlimSAM
// ONNX models plus the onnxruntime-web wasm runtime) that the Dockerfile
// downloads into GLP_MODELS_DIR. They are large and immutable, so they are
// served straight off disk with a long-lived cache rather than embedded in the
// binary like the SPA bundle.
//
// Like Handlers, the routes are not prefixed with /api/, so GET/HEAD requests
// fall through auth.RequireToken's static-asset bypass — the browser fetches
// these before any token exists.
type ModelHandlers struct {
	dir string
}

// NewModelHandlers builds ModelHandlers reading model files from dir. An empty
// dir means the feature is off: every request 404s.
func NewModelHandlers(dir string) *ModelHandlers {
	return &ModelHandlers{dir: dir}
}

// RegisterRoutes registers GET /models/{file} onto mux. The pattern is more
// specific than Handlers's method-less "/" catch-all, so net/http.ServeMux
// routes model requests here instead of to the SPA's static handler.
func (h *ModelHandlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /models/{file}", h.serveModel)
}

// serveModel serves one model file by its base name only. Anything that could
// escape the models directory — an invalid path, anything with a slash, or a
// dot-leading name — 404s before the filesystem is touched.
func (h *ModelHandlers) serveModel(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("file")
	if h.dir == "" || !fs.ValidPath(name) || strings.Contains(name, "/") || strings.HasPrefix(name, ".") {
		http.NotFound(w, r)
		return
	}

	f, err := os.DirFS(h.dir).Open(name)
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
		http.Error(w, "model file not seekable", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Cache-Control", "public, max-age=604800")
	// Go's MIME table knows .wasm and .mjs; .onnx has no registered type, so
	// pin it to a binary download rather than letting ServeContent sniff.
	if strings.HasSuffix(name, ".onnx") {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	http.ServeContent(w, r, name, info.ModTime(), seeker)
}
