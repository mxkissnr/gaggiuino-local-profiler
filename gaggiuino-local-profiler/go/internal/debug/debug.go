// Package debug is the Go port of routes/debug.js (Phase 2e, issue #901)
// plus routes/system.js's one debug helper:
//
//   - GET  /api/debug/export-db  — stream the raw glp.db file as a download
//   - POST /api/debug/import-db  — replace glp.db 1:1 from an uploaded file
//   - GET  /api/debug/machine    — raw dump of the default machine's
//     /api/system/status (routes/system.js, gated on NODE_ENV)
//
// The two DB routes are gated on GLP_DEV_BUILD exactly the way
// routes/debug.js gates them: the flag check is the first thing each
// handler does, and a non-dev build answers 404 with an empty body — the
// same response an unregistered route would give, so a real install can't
// even tell the route exists (routes/debug.js's own comment).
//
// server.js:192 sets a route-scoped raw body parser for /api/debug/import-db
// (express.raw({ type: 'application/octet-stream', limit: '500mb' })). Go's
// net/http has no global body-parser middleware chain, so importDB bounds
// its own body with http.MaxBytesReader(w, r.Body, importDBMaxBytes) —
// that reader IS the route-scoped 500 MB ceiling (see cmd/server/main.go's
// handler-chain comment, which anticipated exactly this).
//
// The DB-replace path mirrors routes/debug.js's #755 safety mechanism
// step for step, plus #959's streaming + validation hardening: the upload
// is streamed straight to a temp file in the DB directory (never
// io.ReadAll'd into a ~500 MB slice), then validated BEFORE anything
// touches the live DB — a 16-byte SQLite-magic check, a throwaway
// read-only handle running PRAGMA integrity_check, and a schema probe for
// the core tables. Only once all three pass does it checkpoint the live
// WAL, copy the current glp.db to a timestamped pre-import-backup,
// atomically rename the temp file into place, and delete the OLD
// database's -wal/-shm sidecars (a WAL from the old file would be replayed
// against the mismatched new main file on the next startup otherwise). A
// corrupt or wrong-schema upload is rejected with 400 and the live DB is
// left completely untouched. The running process keeps its already-open
// file descriptor pinned to the old inode through POSIX rename semantics
// — modernc.org/sqlite is no different from better-sqlite3 here — so only
// a restart picks up the new file, which is why the 200 response says
// restartRequired (no in-process pool drain / reopen).
//
// GET /api/debug/export-db additionally carries a dedicated
// "export-db:<ip>" feature rate limit (exportDBRateLimitPerMin, 5/min) on
// top of the app-wide 600/min backstop — a tightening the Node route
// (routes/debug.js) does not have, since the export streams the whole
// SQLite file and checkpoints the WAL on every hit. See exportDB and
// #999 / security audit #977 round 3 finding 3.2.
package debug

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	_ "modernc.org/sqlite"
)

// importDBMaxBytes mirrors server.js:192's express.raw({ limit: '500mb' })
// for /api/debug/import-db — 500 * 1024 * 1024, the same generous ceiling
// server.js documents for a DB with years of shot history. A var, not a
// const, purely so debug_test.go can lower it to exercise the 413 path
// without sending half a gigabyte through httptest.
var importDBMaxBytes int64 = 500 * 1024 * 1024

// sqliteMagic is routes/debug.js's SQLITE_MAGIC: the 16-byte header every
// SQLite 3 database file starts with, trailing NUL included
// (Buffer.from('SQLite format 3\0')).
var sqliteMagic = []byte("SQLite format 3\x00")

// execer is the only DB capability this package needs: routes/debug.js runs
// getDb().pragma('wal_checkpoint(TRUNCATE)') before both the export
// download and the pre-import backup. *sql.DB satisfies it.
type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// exportDBRateLimitPerMin is the dedicated per-IP ceiling for
// GET /api/debug/export-db (#999, security audit #977 round 3 finding 3.2).
// The export streams the entire SQLite file, so it is both a bandwidth
// amplifier and a WAL-checkpoint trigger on every hit. It gets its own
// feature limiter on top of the app-wide 600/min backstop. This is
// DELIBERATELY STRICTER THAN NODE: routes/debug.js feature-limits neither
// this route nor /api/shots/{id}/card, relying on the shared backstop
// alone. 5/min per IP is ample for a human pulling a manual DB backup.
const exportDBRateLimitPerMin = 5

// Handlers ports routes/debug.js's router plus routes/system.js's
// /api/debug/machine handler.
type Handlers struct {
	db       execer
	dbPath   string
	registry *machines.Registry
	rl       *ratelimit.KeyedLimiter

	// devBuild / nonProd are captured at construction from the environment,
	// matching routes/debug.js / routes/system.js reading process.env on a
	// value that never changes for a process lifetime.
	devBuild bool
	nonProd  bool

	// now / httpGet are test seams; nil means use the real ones.
	now     func() time.Time
	httpGet func(ctx context.Context, url string) (*http.Response, error)
}

// NewHandlers captures the GLP_DEV_BUILD / NODE_ENV state once and wires
// the DB handle (for the WAL checkpoint), the on-disk glp.db path (the
// file the export streams and the import replaces — cmd/server's resolved
// GLP_DB_PATH / db.DefaultPath), and the machine registry.
func NewHandlers(db execer, dbPath string, registry *machines.Registry) *Handlers {
	return &Handlers{
		db:       db,
		dbPath:   dbPath,
		registry: registry,
		rl:       ratelimit.NewKeyed(),
		devBuild: os.Getenv("GLP_DEV_BUILD") != "",
		nonProd:  os.Getenv("NODE_ENV") != "production",
	}
}

func (h *Handlers) clock() time.Time {
	if h.now != nil {
		return h.now()
	}
	return time.Now()
}

// RegisterRoutes mounts the debug routes. /api/debug/machine is registered
// only when NODE_ENV !== 'production', exactly as routes/system.js guards
// it (`if (process.env.NODE_ENV !== 'production')`) — on a production build
// the route genuinely does not exist and 404s.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/debug/export-db", h.exportDB)
	mux.HandleFunc("POST /api/debug/import-db", h.importDB)
	if h.nonProd {
		mux.HandleFunc("GET /api/debug/machine", h.machine)
		// Same gating as /api/debug/machine (NODE_ENV != production, behind
		// auth.RequireToken) — see ingress.go's package doc.
		mux.HandleFunc("GET /api/debug/ingress", h.ingress)
		mux.HandleFunc("GET /api/debug/ingress/sse-probe", h.ingressSSEProbe)
	}
}

// exportDB ports routes/debug.js's GET /api/debug/export-db.
func (h *Handlers) exportDB(w http.ResponseWriter, r *http.Request) {
	if !h.devBuild {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	// Dedicated per-IP feature limit (#999) — checked after the devBuild
	// gate so a non-dev build stays byte-for-byte indistinguishable from an
	// unregistered route (never 429s).
	if !h.rl.Allow("export-db:"+auth.RemoteIP(r), exportDBRateLimitPerMin) {
		httputil.WriteError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}

	if _, err := h.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		// routes/debug.js returns the raw err.message here (a 500 with
		// { error: <message> }, not the generic body) — matched.
		httputil.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	f, err := os.Open(h.dbPath)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	filename := fmt.Sprintf("glp-db-export-%s.db", h.clock().Format("2006-01-02_15-04-05"))
	// res.download(): Content-Disposition attachment + a by-extension
	// Content-Type (.db has no registered MIME, so express falls back to
	// application/octet-stream) + Content-Length.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	if _, err := io.Copy(w, f); err != nil {
		log.Printf("debug: DB export download failed: %v", err)
	}
}

// importDB ports routes/debug.js's POST /api/debug/import-db.
func (h *Handlers) importDB(w http.ResponseWriter, r *http.Request) {
	if !h.devBuild {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, importDBMaxBytes)

	nowMS := h.clock().UnixMilli()
	dir := filepath.Dir(h.dbPath)
	tmpPath := fmt.Sprintf("%s.importing-%d", h.dbPath, nowMS)

	// Stream the upload straight to a temp file on the same filesystem as
	// glp.db (so the eventual os.Rename stays a single-device atomic swap),
	// never a ~500 MB slice in RAM (#959).
	tmp, err := os.Create(tmpPath)
	if err != nil {
		log.Printf("debug: DB import failed: %v", err)
		httputil.WriteError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	written, copyErr := io.Copy(tmp, r.Body)
	closeErr := tmp.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		var mbe *http.MaxBytesError
		if errors.As(copyErr, &mbe) {
			// server.js:192's express.raw({ limit: '500mb' }) rejects an
			// oversized body with a 413 before the handler runs;
			// lib/middleware/error.js turns that into { error: <message> }.
			httputil.WriteError(w, http.StatusRequestEntityTooLarge, "request entity too large")
			return
		}
		httputil.WriteError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		log.Printf("debug: DB import failed: %v", closeErr)
		httputil.WriteError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	if written == 0 {
		_ = os.Remove(tmpPath)
		httputil.WriteError(w, http.StatusBadRequest, "No database file uploaded")
		return
	}
	if !fileHasSQLiteMagic(tmpPath) {
		_ = os.Remove(tmpPath)
		httputil.WriteError(w, http.StatusBadRequest, "Not a SQLite database file")
		return
	}
	if err := validateUploadedDB(tmpPath); err != nil {
		_ = os.Remove(tmpPath)
		log.Printf("debug: DB import rejected — uploaded file failed validation: %v", err)
		httputil.WriteError(w, http.StatusBadRequest, "Uploaded database failed validation")
		return
	}

	if _, err := h.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		_ = os.Remove(tmpPath)
		log.Printf("debug: DB import failed: %v", err)
		httputil.WriteError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	backupPath := filepath.Join(dir, fmt.Sprintf("pre-import-backup-%d.db", nowMS))
	if err := copyFile(h.dbPath, backupPath); err != nil {
		_ = os.Remove(tmpPath)
		log.Printf("debug: DB import failed: %v", err)
		httputil.WriteError(w, http.StatusInternalServerError, "Internal server error")
		return
	}

	if err := os.Rename(tmpPath, h.dbPath); err != nil {
		_ = os.Remove(tmpPath)
		log.Printf("debug: DB import failed: %v", err)
		httputil.WriteError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		sidecar := h.dbPath + suffix
		if _, statErr := os.Stat(sidecar); statErr == nil {
			_ = os.Remove(sidecar)
		}
	}

	log.Printf("debug: DB import: replaced glp.db (%d bytes, previous version backed up to %s) -- restart required to load it", written, backupPath)
	httputil.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":              true,
		"restartRequired": true,
		"backupPath":      filepath.Base(backupPath),
	})
}

// machine ports routes/system.js's GET /api/debug/machine (H2). Always 200:
// both the success and the failure branch answer with a JSON body, exactly
// as the Node original does (`res.json({ ok, ... })` in the catch too).
func (h *Handlers) machine(w http.ResponseWriter, r *http.Request) {
	baseURL, err := h.defaultMachineBaseURL(r.Context())
	if err != nil {
		httputil.WriteJSON(w, http.StatusOK, map[string]any{
			"ok": false, "baseUrl": baseURL, "error": err.Error(),
		})
		return
	}

	get := h.httpGet
	if get == nil {
		get = func(ctx context.Context, url string) (*http.Response, error) {
			req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if reqErr != nil {
				return nil, reqErr
			}
			client := &http.Client{Timeout: 5 * time.Second}
			return client.Do(req)
		}
	}

	resp, err := get(r.Context(), baseURL+"/api/system/status")
	if err != nil {
		httputil.WriteJSON(w, http.StatusOK, map[string]any{
			"ok": false, "baseUrl": baseURL, "error": err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	var data any
	if decErr := json.NewDecoder(io.LimitReader(resp.Body, 5<<20)).Decode(&data); decErr != nil {
		httputil.WriteJSON(w, http.StatusOK, map[string]any{
			"ok": false, "baseUrl": baseURL, "error": decErr.Error(),
		})
		return
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true, "baseUrl": baseURL, "data": data,
	})
}

// defaultMachineBaseURL resolves registry.baseUrlFor() (no machineId) — the
// default machine's SSRF-guarded base URL. On any failure it returns a
// best-effort host string alongside the error so the caller can still
// report { ok:false, baseUrl, error } the way Node's always-a-string
// getMachineBaseUrl() lets it.
func (h *Handlers) defaultMachineBaseURL(ctx context.Context) (string, error) {
	if h.registry == nil {
		return "", errors.New("machine registry unavailable")
	}
	m, err := h.registry.GetDefaultMachine()
	if err != nil {
		return "", err
	}
	baseURL, err := machines.BaseURLFor(ctx, m)
	if err != nil {
		return m.Host, err
	}
	return baseURL, nil
}

// fileHasSQLiteMagic checks the first 16 bytes of path against
// sqliteMagic without reading the whole file — routes/debug.js's
// SQLITE_MAGIC guard, moved off the (now streamed) in-memory buffer.
func fileHasSQLiteMagic(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	head := make([]byte, len(sqliteMagic))
	if _, err := io.ReadFull(f, head); err != nil {
		return false
	}
	return string(head) == string(sqliteMagic)
}

// validateUploadedDB opens the uploaded temp file with a throwaway
// read-only handle and runs PRAGMA integrity_check plus a probe for the
// core tables (#959). Any failure means the file is corrupt or is a
// SQLite file from something other than this app — reject it before the
// live DB is touched at all. The handle is fully closed here, before the
// caller's os.Rename.
func validateUploadedDB(path string) error {
	dsn := "file:" + path + "?_pragma=busy_timeout(2000)&_pragma=query_only(true)"
	probe, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("opening uploaded db: %w", err)
	}
	defer func() {
		probe.Close()
		// query_only still lets SQLite create a -wal/-shm beside the file on
		// open; tidy them so the subsequent os.Rename doesn't strand them.
		for _, sfx := range []string{"-wal", "-shm"} {
			_ = os.Remove(path + sfx)
		}
	}()
	probe.SetMaxOpenConns(1)

	var result string
	if err := probe.QueryRow(`PRAGMA integrity_check`).Scan(&result); err != nil {
		return fmt.Errorf("integrity_check: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("integrity_check reported %q", result)
	}

	for _, table := range []string{"shots", "kv"} {
		var one int
		err := probe.QueryRow(
			`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
		).Scan(&one)
		if err == sql.ErrNoRows {
			return fmt.Errorf("uploaded db is missing the %q table", table)
		}
		if err != nil {
			return fmt.Errorf("probing for %q table: %w", table, err)
		}
	}
	return nil
}

// copyFile mirrors routes/debug.js's fs.copyFileSync(DB_PATH, backupPath):
// a plain whole-file copy of the current database before it is replaced.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
