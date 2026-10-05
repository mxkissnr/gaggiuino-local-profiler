package webapp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/cutoutmodels"
)

// fakeManifest builds a small three-file manifest with real sizes and hashes,
// so tests exercise the same pinning path the production manifest uses.
func fakeManifest(t *testing.T) ([]cutoutmodels.File, map[string][]byte) {
	t.Helper()
	names := []string{"alpha.onnx", "beta.onnx", "gamma.onnx"}
	bodies := make(map[string][]byte, len(names))
	files := make([]cutoutmodels.File, 0, len(names))
	for i, name := range names {
		body := bytes.Repeat([]byte{byte('a' + i)}, 64+i*37)
		sum := sha256.Sum256(body)
		bodies[name] = body
		files = append(files, cutoutmodels.File{
			Name:   name,
			SHA256: hex.EncodeToString(sum[:]),
			Size:   int64(len(body)),
		})
	}
	return files, bodies
}

func findFile(t *testing.T, files []cutoutmodels.File, name string) cutoutmodels.File {
	t.Helper()
	for _, f := range files {
		if f.Name == name {
			return f
		}
	}
	t.Fatalf("file %s not in manifest", name)
	return cutoutmodels.File{}
}

// writeModelFile writes body to path, creating any parent directories.
func writeModelFile(t *testing.T, path string, body []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}

func modelPath(dir, name string) string {
	return filepath.Join(dir, cutoutmodels.Version, name)
}

func modelURL(name string) string {
	return "/models/" + cutoutmodels.Version + "/" + name
}

func assertNoModelFile(t *testing.T, dir, name string) {
	t.Helper()
	for _, p := range []string{modelPath(dir, name), modelPath(dir, name) + ".part"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("expected %s to be absent, stat err = %v", p, err)
		}
	}
}

// modelUpstream is an httptest server that counts hits and serves a manifest's
// bytes by base name. override, fixed at construction so it needs no locking,
// gets first refusal; returning true means it handled the request and the
// default file response is skipped.
type modelUpstream struct {
	*httptest.Server
	hits atomic.Int64
}

func newModelUpstream(t *testing.T, bodies map[string][]byte, override func(w http.ResponseWriter, r *http.Request) bool) *modelUpstream {
	t.Helper()
	up := &modelUpstream{}
	up.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up.hits.Add(1)
		if override != nil && override(w, r) {
			return
		}
		body, ok := bodies[path.Base(r.URL.Path)]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = w.Write(body)
	}))
	t.Cleanup(up.Close)
	return up
}

// modelMux wires the test seam with the production HTTP client (no total
// timeout, redirect guard) against up.
func modelMux(t *testing.T, dir string, up *modelUpstream, files []cutoutmodels.File) *http.ServeMux {
	t.Helper()
	mux := http.NewServeMux()
	newModelHandlers(dir, up.URL+"/", newModelHTTPClient(), files).RegisterRoutes(mux)
	return mux
}

func getModel(mux *http.ServeMux, method, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestModelHandlers_ServesOnDiskFileWithoutDownload(t *testing.T) {
	files, bodies := fakeManifest(t)
	dir := t.TempDir()
	writeModelFile(t, modelPath(dir, "alpha.onnx"), bodies["alpha.onnx"])
	up := newModelUpstream(t, bodies, nil)
	mux := modelMux(t, dir, up, files)

	rec := getModel(mux, http.MethodGet, modelURL("alpha.onnx"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !bytes.Equal(rec.Body.Bytes(), bodies["alpha.onnx"]) {
		t.Errorf("body = %q, want %q", rec.Body.Bytes(), bodies["alpha.onnx"])
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Errorf("Cache-Control = %q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Errorf("Content-Type = %q", got)
	}
	if n := up.hits.Load(); n != 0 {
		t.Errorf("upstream hits = %d, want 0", n)
	}
}

func TestModelHandlers_DownloadsOnFirstUse(t *testing.T) {
	files, bodies := fakeManifest(t)
	dir := t.TempDir()
	up := newModelUpstream(t, bodies, nil)
	mux := modelMux(t, dir, up, files)

	rec := getModel(mux, http.MethodGet, modelURL("alpha.onnx"))
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), bodies["alpha.onnx"]) {
		t.Fatalf("first GET: status=%d body=%q", rec.Code, rec.Body.Bytes())
	}
	if got, err := os.ReadFile(modelPath(dir, "alpha.onnx")); err != nil || !bytes.Equal(got, bodies["alpha.onnx"]) {
		t.Fatalf("persisted file: err=%v body=%q", err, got)
	}
	if _, err := os.Stat(modelPath(dir, "alpha.onnx") + ".part"); !os.IsNotExist(err) {
		t.Fatalf(".part left behind after download: stat err = %v", err)
	}
	if n := up.hits.Load(); n != 1 {
		t.Fatalf("upstream hits after first GET = %d, want 1", n)
	}

	rec = getModel(mux, http.MethodGet, modelURL("alpha.onnx"))
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), bodies["alpha.onnx"]) {
		t.Fatalf("second GET: status=%d body=%q", rec.Code, rec.Body.Bytes())
	}
	if n := up.hits.Load(); n != 1 {
		t.Errorf("upstream hits after second GET = %d, want 1 (served from disk)", n)
	}
}

func TestModelHandlers_RejectsCorruptDownload(t *testing.T) {
	files, bodies := fakeManifest(t)
	dir := t.TempDir()
	override := func(w http.ResponseWriter, r *http.Request) bool {
		corrupt := bytes.Repeat([]byte{'z'}, len(bodies["alpha.onnx"]))
		w.Header().Set("Content-Length", strconv.Itoa(len(corrupt)))
		_, _ = w.Write(corrupt)
		return true
	}
	up := newModelUpstream(t, bodies, override)
	mux := modelMux(t, dir, up, files)

	rec := getModel(mux, http.MethodGet, modelURL("alpha.onnx"))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	assertNoModelFile(t, dir, "alpha.onnx")
}

func TestModelHandlers_RejectsUpstreamFailures(t *testing.T) {
	files, bodies := fakeManifest(t)
	cases := map[string]func(w http.ResponseWriter, r *http.Request) bool{
		"404": func(w http.ResponseWriter, r *http.Request) bool {
			http.NotFound(w, r)
			return true
		},
		"500": func(w http.ResponseWriter, r *http.Request) bool {
			http.Error(w, "boom", http.StatusInternalServerError)
			return true
		},
	}
	for name, override := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			up := newModelUpstream(t, bodies, override)
			mux := modelMux(t, dir, up, files)

			rec := getModel(mux, http.MethodGet, modelURL("alpha.onnx"))
			if rec.Code != http.StatusBadGateway {
				t.Fatalf("status = %d, want 502", rec.Code)
			}
			assertNoModelFile(t, dir, "alpha.onnx")
		})
	}

	t.Run("closed", func(t *testing.T) {
		dir := t.TempDir()
		up := newModelUpstream(t, bodies, nil)
		up.Close()
		mux := modelMux(t, dir, up, files)

		rec := getModel(mux, http.MethodGet, modelURL("alpha.onnx"))
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("status = %d, want 502", rec.Code)
		}
		assertNoModelFile(t, dir, "alpha.onnx")
	})
}

func TestModelHandlers_RejectsOversizeDownload(t *testing.T) {
	files, bodies := fakeManifest(t)
	file := findFile(t, files, "alpha.onnx")
	oversize := bytes.Repeat([]byte{'a'}, int(file.Size)+10)

	t.Run("content-length", func(t *testing.T) {
		dir := t.TempDir()
		override := func(w http.ResponseWriter, r *http.Request) bool {
			w.Header().Set("Content-Length", strconv.Itoa(len(oversize)))
			_, _ = w.Write(oversize)
			return true
		}
		up := newModelUpstream(t, bodies, override)
		mux := modelMux(t, dir, up, files)

		rec := getModel(mux, http.MethodGet, modelURL("alpha.onnx"))
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("status = %d, want 502", rec.Code)
		}
		assertNoModelFile(t, dir, "alpha.onnx")
	})

	t.Run("chunked", func(t *testing.T) {
		dir := t.TempDir()
		override := func(w http.ResponseWriter, r *http.Request) bool {
			// No Content-Length: flushing an early write forces chunked framing.
			_, _ = w.Write(oversize[:8])
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			_, _ = w.Write(oversize[8:])
			return true
		}
		up := newModelUpstream(t, bodies, override)
		mux := modelMux(t, dir, up, files)

		rec := getModel(mux, http.MethodGet, modelURL("alpha.onnx"))
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("status = %d, want 502", rec.Code)
		}
		assertNoModelFile(t, dir, "alpha.onnx")
	})
}

func TestModelHandlers_ParallelFirstRequestDownloadsOnce(t *testing.T) {
	files, bodies := fakeManifest(t)
	dir := t.TempDir()
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	override := func(w http.ResponseWriter, r *http.Request) bool {
		once.Do(func() { close(entered) })
		<-release
		return false
	}
	up := newModelUpstream(t, bodies, override)
	mux := modelMux(t, dir, up, files)

	target := modelURL("alpha.onnx")
	type result struct {
		code int
		body []byte
	}
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
			results <- result{rec.Code, rec.Body.Bytes()}
		}()
	}
	<-entered
	close(release)
	for i := 0; i < 2; i++ {
		res := <-results
		if res.code != http.StatusOK || !bytes.Equal(res.body, bodies["alpha.onnx"]) {
			t.Errorf("parallel GET: status=%d body=%q", res.code, res.body)
		}
	}
	if n := up.hits.Load(); n != 1 {
		t.Errorf("upstream hits = %d, want 1", n)
	}
}

func TestModelHandlers_HeadFromManifest(t *testing.T) {
	files, bodies := fakeManifest(t)
	file := findFile(t, files, "alpha.onnx")
	dir := t.TempDir()
	up := newModelUpstream(t, bodies, nil)
	mux := modelMux(t, dir, up, files)

	rec := getModel(mux, http.MethodHead, modelURL("alpha.onnx"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Length"); got != strconv.FormatInt(file.Size, 10) {
		t.Errorf("Content-Length = %q, want %d", got, file.Size)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD body = %q, want empty", rec.Body.String())
	}
	if n := up.hits.Load(); n != 0 {
		t.Errorf("upstream hits = %d, want 0", n)
	}
	if _, err := os.Stat(modelPath(dir, "alpha.onnx")); !os.IsNotExist(err) {
		t.Errorf("HEAD created a file: stat err = %v", err)
	}
}

func TestModelHandlers_NotFound(t *testing.T) {
	files, bodies := fakeManifest(t)
	dir := t.TempDir()
	up := newModelUpstream(t, bodies, nil)
	mux := modelMux(t, dir, up, files)

	for _, target := range []string{
		"/models/models-v0/alpha.onnx",
		modelURL("nope.onnx"),
		modelURL("..%2Falpha.onnx"),
	} {
		rec := getModel(mux, http.MethodGet, target)
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s: status = %d, want 404", target, rec.Code)
		}
	}
	if n := up.hits.Load(); n != 0 {
		t.Errorf("upstream hits = %d, want 0", n)
	}

	// An empty dir turns the feature off: every method 404s.
	disabled := http.NewServeMux()
	newModelHandlers("", up.URL+"/", newModelHTTPClient(), files).RegisterRoutes(disabled)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		rec := getModel(disabled, method, modelURL("alpha.onnx"))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s with empty dir: status = %d, want 404", method, rec.Code)
		}
	}
}

func TestModelHandlers_UnwritableDir(t *testing.T) {
	files, bodies := fakeManifest(t)
	dir := filepath.Join(t.TempDir(), "not-a-dir")
	writeModelFile(t, dir, []byte("a regular file, not a directory"))
	up := newModelUpstream(t, bodies, nil)
	mux := modelMux(t, dir, up, files)

	rec := getModel(mux, http.MethodGet, modelURL("alpha.onnx"))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if n := up.hits.Load(); n != 0 {
		t.Errorf("upstream hits = %d, want 0", n)
	}
}

// failingWriter lets the first `allow` bytes through, then fails every write,
// simulating a destination whose disk fills mid-stream.
type failingWriter struct {
	w     io.Writer
	allow int
}

func (f *failingWriter) Write(p []byte) (int, error) {
	if f.allow <= 0 {
		return 0, errors.New("no space left on device")
	}
	n := len(p)
	if n > f.allow {
		n = f.allow
	}
	f.allow -= n
	written, err := f.w.Write(p[:n])
	if err != nil {
		return written, err
	}
	if written < len(p) {
		return written, errors.New("no space left on device")
	}
	return written, nil
}

// modelMuxWithHook wires the test seam with a wrapPart hook installed, so a test
// can inject a destination writer that fails mid-stream.
func modelMuxWithHook(t *testing.T, dir string, up *modelUpstream, files []cutoutmodels.File, wrap func(io.Writer) io.Writer) *http.ServeMux {
	t.Helper()
	h := newModelHandlers(dir, up.URL+"/", newModelHTTPClient(), files)
	h.wrapPart = wrap
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	return mux
}

func TestModelHandlers_WriteFailureIsStorageError(t *testing.T) {
	files, bodies := fakeManifest(t)
	dir := t.TempDir()
	up := newModelUpstream(t, bodies, nil)
	mux := modelMuxWithHook(t, dir, up, files, func(w io.Writer) io.Writer {
		return &failingWriter{w: w, allow: 4}
	})

	rec := getModel(mux, http.MethodGet, modelURL("alpha.onnx"))
	// A local write failure is the server's storage, not the upstream's fault.
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	assertNoModelFile(t, dir, "alpha.onnx")
}

func TestModelHandlers_CancelledDownloadLeavesNoPartFile(t *testing.T) {
	files, bodies := fakeManifest(t)
	file := findFile(t, files, "alpha.onnx")
	dir := t.TempDir()

	entered := make(chan struct{})
	release := make(chan struct{})
	override := func(w http.ResponseWriter, _ *http.Request) bool {
		// Announce the full length, send a prefix, then stall so the client is
		// mid-copy when the test cancels the request context.
		w.Header().Set("Content-Length", strconv.FormatInt(file.Size, 10))
		_, _ = w.Write(bodies["alpha.onnx"][:8])
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		close(entered)
		<-release
		return true
	}
	up := newModelUpstream(t, bodies, override)
	mux := modelMux(t, dir, up, files)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, modelURL("alpha.onnx"), nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		mux.ServeHTTP(rec, req)
		close(done)
	}()

	<-entered
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not return after the request was cancelled")
	}
	close(release)

	assertNoModelFile(t, dir, "alpha.onnx")
}

func TestModelHandlers_RemovesStaleVersions(t *testing.T) {
	files, _ := fakeManifest(t)
	dir := t.TempDir()
	mkdir(t, filepath.Join(dir, cutoutmodels.Version))
	mkdir(t, filepath.Join(dir, "models-v0"))
	mkdir(t, filepath.Join(dir, "not-models"))
	writeModelFile(t, filepath.Join(dir, "models-v9"), []byte("a file, not a directory"))

	up := newModelUpstream(t, map[string][]byte{}, nil)
	_ = modelMux(t, dir, up, files) // construction prunes stale dirs

	if _, err := os.Stat(filepath.Join(dir, "models-v0")); !os.IsNotExist(err) {
		t.Errorf("models-v0 should have been removed, stat err = %v", err)
	}
	for _, kept := range []string{cutoutmodels.Version, "not-models", "models-v9"} {
		if _, err := os.Stat(filepath.Join(dir, kept)); err != nil {
			t.Errorf("%s should have been kept: %v", kept, err)
		}
	}
}

func TestModelHandlers_OutranksStaticCatchAll(t *testing.T) {
	files, bodies := fakeManifest(t)
	dir := t.TempDir()
	writeModelFile(t, modelPath(dir, "alpha.onnx"), bodies["alpha.onnx"])
	up := newModelUpstream(t, bodies, nil)

	mux := http.NewServeMux()
	testHandlers(t).RegisterRoutes(mux)
	newModelHandlers(dir, up.URL+"/", newModelHTTPClient(), files).RegisterRoutes(mux)

	rec := getModel(mux, http.MethodGet, modelURL("alpha.onnx"))
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), bodies["alpha.onnx"]) {
		t.Fatalf("GET model hit the SPA handler: status=%d body=%q", rec.Code, rec.Body.Bytes())
	}

	spa := getModel(mux, http.MethodGet, "/manifest.json")
	if spa.Code != http.StatusOK {
		t.Errorf("GET /manifest.json: status = %d, want 200", spa.Code)
	}
}

func TestCheckModelRedirect(t *testing.T) {
	newReq := func(raw string) *http.Request {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatalf("parse %s: %v", raw, err)
		}
		return &http.Request{URL: u}
	}
	// via counts the requests already made; three entries reject the next hop.
	via := func(n int) []*http.Request {
		reqs := make([]*http.Request, n)
		for i := range reqs {
			reqs[i] = newReq("https://github.com/")
		}
		return reqs
	}

	cases := []struct {
		name    string
		target  string
		hops    int
		wantErr bool
	}{
		{"github", "https://github.com/mxkissnr/glp-models/releases/download/models-v1/a.onnx", 0, false},
		{"release-assets", "https://release-assets.githubusercontent.com/github-production-release-asset/a", 1, false},
		{"two hops then ok", "https://objects.githubusercontent.com/a", 2, false},
		{"http", "http://github.com/a", 0, true},
		{"other host", "https://example.com/a", 0, true},
		{"lookalike suffix", "https://evilgithubusercontent.com/a", 0, true},
		{"fourth hop", "https://github.com/a", 3, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkModelRedirect(newReq(tc.target), via(tc.hops))
			if tc.wantErr && err == nil {
				t.Errorf("checkModelRedirect(%s) = nil, want error", tc.target)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("checkModelRedirect(%s) = %v, want nil", tc.target, err)
			}
		})
	}
}
