package webapp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/cutoutmodels"
)

// errModelStorage marks a local filesystem failure (mkdir, create, sync,
// rename) so serveGet can answer 503 before it ever contacts the upstream,
// distinct from the 502 a failed or corrupt download gets.
var errModelStorage = errors.New("model storage unavailable")

const (
	// modelCacheControl is safe because the URL pins one model release
	// (cutoutmodels.Version) whose files are hash-verified before they are
	// stored, so a given URL's bytes never change.
	modelCacheControl = "public, max-age=31536000, immutable"

	// modelResponseHeaderTimeout bounds how long a download waits for the
	// upstream's response headers. There is deliberately no total timeout:
	// the largest model is ~44 MB and may stream slowly.
	modelResponseHeaderTimeout = 30 * time.Second

	// maxModelRedirectHops bounds a download's redirect chain: the original
	// request plus up to two redirects. A fourth request is refused, so a
	// compromised release URL cannot walk the download to an unrelated host.
	maxModelRedirectHops = 3
)

// ModelHandlers serves the on-device cut-out model files (#1404). The ONNX
// models are no longer baked into the image: the first GET for a file downloads
// it from the pinned release (cutoutmodels) into dir/<version>/, verifies its
// SHA-256, and serves it from disk thereafter. They are large and immutable, so
// they are served with a long-lived cache rather than embedded in the binary
// like the SPA bundle.
//
// Like Handlers, the routes are not prefixed with /api/, so GET/HEAD requests
// fall through auth.RequireToken's static-asset bypass — the browser probes
// these before any token exists.
type ModelHandlers struct {
	dir     string
	baseURL string
	client  *http.Client
	files   []cutoutmodels.File

	// locks serializes downloads per file name so two concurrent first
	// requests fetch the bytes once; the loser re-checks disk after locking.
	locks map[string]*sync.Mutex

	// wrapPart is a test-only hook: it wraps the destination .part writer before
	// the streaming copy so a test can inject a write failure (e.g. disk full).
	// Production leaves it nil and the file is written to directly.
	wrapPart func(io.Writer) io.Writer
}

// modelFileWriter records the first error from the destination .part file's
// Write. An io.Copy failure is otherwise ambiguous — a read from the upstream
// body and a write to the local file both surface as the copy's error — so this
// lets the caller tell a disk failure (errModelStorage) from a failed download.
type modelFileWriter struct {
	w   io.Writer
	err error
}

func (f *modelFileWriter) Write(p []byte) (int, error) {
	if f.err != nil {
		return 0, f.err
	}
	n, err := f.w.Write(p)
	if err == nil && n != len(p) {
		err = io.ErrShortWrite
	}
	f.err = err
	return n, err
}

// NewModelHandlers builds ModelHandlers reading model files from dir. An empty
// dir means the feature is off: every request 404s.
func NewModelHandlers(dir string) *ModelHandlers {
	return newModelHandlers(dir, cutoutmodels.ReleaseBase, newModelHTTPClient(), cutoutmodels.Files)
}

// newModelHandlers is the test seam: it takes the release base URL, the HTTP
// client and the pinned manifest explicitly, so tests can point them at an
// httptest server with a fake manifest.
func newModelHandlers(dir, baseURL string, client *http.Client, files []cutoutmodels.File) *ModelHandlers {
	h := &ModelHandlers{
		dir:     dir,
		baseURL: baseURL,
		client:  client,
		files:   files,
		locks:   make(map[string]*sync.Mutex, len(files)),
	}
	for _, f := range files {
		h.locks[f.Name] = &sync.Mutex{}
	}
	if dir != "" {
		h.removeStaleVersions()
	}
	return h
}

// removeStaleVersions deletes sibling directories left by an earlier model
// release so a superseded download does not linger in the data volume. Only
// directories whose name starts with "models-v" and is not the current
// cutoutmodels.Version are touched; every other entry is left alone.
func (h *ModelHandlers) removeStaleVersions() {
	entries, err := os.ReadDir(h.dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == cutoutmodels.Version || !strings.HasPrefix(name, "models-v") || !entry.IsDir() {
			continue
		}
		if err := os.RemoveAll(filepath.Join(h.dir, name)); err != nil {
			log.Printf("webapp: remove stale model dir %s: %v", name, err)
		}
	}
}

// RegisterRoutes registers GET /models/{version}/{file} onto mux. The pattern
// is more specific than Handlers's method-less "/" catch-all, so
// net/http.ServeMux routes model requests here instead of to the SPA's static
// handler. A GET pattern also matches HEAD.
func (h *ModelHandlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /models/{version}/{file}", h.serveModel)
}

// serveModel serves one pinned model file. The manifest (files) is the only
// allowlist: an unknown version or a name not in it 404s before the filesystem
// is touched, so a request cannot select a free-form path.
func (h *ModelHandlers) serveModel(w http.ResponseWriter, r *http.Request) {
	if h.dir == "" {
		http.NotFound(w, r)
		return
	}
	if r.PathValue("version") != cutoutmodels.Version {
		http.NotFound(w, r)
		return
	}
	file, ok := h.lookup(r.PathValue("file"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodHead {
		// Answered purely from the manifest: the frontend's availability
		// probe must never trigger a download.
		h.serveHead(w, file)
		return
	}
	h.serveGet(w, r, file)
}

func (h *ModelHandlers) lookup(name string) (cutoutmodels.File, bool) {
	for _, f := range h.files {
		if f.Name == name {
			return f, true
		}
	}
	return cutoutmodels.File{}, false
}

// serveHead answers a HEAD from the pinned manifest: 200 with the known size,
// whether or not the file is on disk yet.
func (h *ModelHandlers) serveHead(w http.ResponseWriter, file cutoutmodels.File) {
	w.Header().Set("Content-Length", strconv.FormatInt(file.Size, 10))
	w.Header().Set("Cache-Control", modelCacheControl)
	setModelContentType(w, file.Name)
	w.WriteHeader(http.StatusOK)
}

// serveGet serves the file from disk, downloading it first when it is absent.
func (h *ModelHandlers) serveGet(w http.ResponseWriter, r *http.Request, file cutoutmodels.File) {
	path := filepath.Join(h.dir, cutoutmodels.Version, file.Name)
	if f, info, ok := openModelFile(path); ok {
		serveModelFile(w, r, file, f, info)
		return
	}

	// One lock per file: a concurrent first request waits here, then finds the
	// finished download on disk and never touches the upstream. newModelHandlers
	// seeds one entry per manifest file, and lookup only returns manifest files.
	lock := h.locks[file.Name]
	lock.Lock()
	defer lock.Unlock()

	if f, info, ok := openModelFile(path); ok {
		serveModelFile(w, r, file, f, info)
		return
	}

	if err := h.download(r.Context(), file, path); err != nil {
		if errors.Is(err, errModelStorage) {
			log.Printf("webapp: model %s storage error: %v", file.Name, err)
			http.Error(w, "model storage unavailable", http.StatusServiceUnavailable)
			return
		}
		log.Printf("webapp: model %s download failed: %v", file.Name, err)
		http.Error(w, "model download failed", http.StatusBadGateway)
		return
	}

	f, info, ok := openModelFile(path)
	if !ok {
		log.Printf("webapp: model %s missing after download", file.Name)
		http.Error(w, "model storage unavailable", http.StatusServiceUnavailable)
		return
	}
	serveModelFile(w, r, file, f, info)
}

// download fetches one pinned file to path via a .part sibling, verifying the
// pinned size and SHA-256 before the atomic rename. A filesystem error before
// or during the fetch is errModelStorage (503); anything else — a non-200, a
// transport error, a size mismatch or a hash mismatch — is a failed download
// (502) and leaves no .part behind.
func (h *ModelHandlers) download(ctx context.Context, file cutoutmodels.File, path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("%w: %v", errModelStorage, err)
	}
	part := path + ".part"
	out, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("%w: %v", errModelStorage, err)
	}
	keep := false
	defer func() {
		if !keep {
			_ = out.Close()
			_ = os.Remove(part)
		}
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.baseURL+file.Name, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("upstream status %d", resp.StatusCode)
	}

	// LimitReader(Size+1) both caps a hostile body and detects one that is
	// longer than pinned, since a short read can never be confused with an
	// exact match once the byte count is checked below.
	dest := io.Writer(out)
	if h.wrapPart != nil {
		dest = h.wrapPart(out)
	}
	fileWriter := &modelFileWriter{w: dest}
	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(fileWriter, hasher), io.LimitReader(resp.Body, file.Size+1))
	if err != nil {
		// A local write failure (disk full) surfaces here just like a failed
		// upstream read; the writer's recorded error tells the two apart.
		if fileWriter.err != nil {
			return fmt.Errorf("%w: %v", errModelStorage, fileWriter.err)
		}
		return fmt.Errorf("read upstream: %w", err)
	}
	if written != file.Size {
		return fmt.Errorf("size mismatch: got %d bytes, want %d", written, file.Size)
	}
	if got := hex.EncodeToString(hasher.Sum(nil)); got != file.SHA256 {
		return fmt.Errorf("sha256 mismatch: got %s", got)
	}
	if err := out.Sync(); err != nil {
		return fmt.Errorf("%w: %v", errModelStorage, err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("%w: %v", errModelStorage, err)
	}
	if err := os.Rename(part, path); err != nil {
		return fmt.Errorf("%w: %v", errModelStorage, err)
	}
	keep = true
	log.Printf("webapp: downloaded model %s (%d bytes)", file.Name, file.Size)
	return nil
}

func openModelFile(path string) (*os.File, os.FileInfo, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, false
	}
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		_ = f.Close()
		return nil, nil, false
	}
	return f, info, true
}

func serveModelFile(w http.ResponseWriter, r *http.Request, file cutoutmodels.File, f *os.File, info os.FileInfo) {
	defer f.Close()
	w.Header().Set("Cache-Control", modelCacheControl)
	setModelContentType(w, file.Name)
	http.ServeContent(w, r, file.Name, info.ModTime(), f)
}

// setModelContentType pins .onnx to a generic binary download; Go's MIME table
// has no registered type for it and sniffing a multi-megabyte model wastes work.
func setModelContentType(w http.ResponseWriter, name string) {
	if strings.HasSuffix(name, ".onnx") {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
}

// newModelHTTPClient is the production client: a clone of http.DefaultTransport
// with a bounded time-to-first-byte and the redirect guard below.
func newModelHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = modelResponseHeaderTimeout
	return &http.Client{
		Transport:     transport,
		CheckRedirect: checkModelRedirect,
	}
}

// checkModelRedirect restricts a model download's redirect chain: at most
// maxModelRedirectHops requests, https only, and only github.com or a
// *.githubusercontent.com host. GitHub's release assets redirect there from
// github.com, and nothing else is trusted.
func checkModelRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= maxModelRedirectHops {
		return fmt.Errorf("stopped after %d hops", maxModelRedirectHops)
	}
	if req.URL.Scheme != "https" {
		return fmt.Errorf("refusing non-https redirect to %q", req.URL.String())
	}
	host := req.URL.Hostname()
	if host == "github.com" || strings.HasSuffix(host, ".githubusercontent.com") {
		return nil
	}
	return fmt.Errorf("refusing redirect to untrusted host %q", host)
}
