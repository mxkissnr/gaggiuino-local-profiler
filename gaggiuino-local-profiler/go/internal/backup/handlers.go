package backup

import (
	"archive/zip"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports routes/backup.js's Express router (GET/POST /api/backup,
// POST /api/restore) onto Go 1.22+'s method-and-wildcard http.ServeMux.

// restoreJSONBodyLimit/restoreZipBodyLimit mirror server.js's
// `app.use('/api/restore', express.json({ limit: '50mb' }))` /
// `express.raw({ type: 'application/zip', limit: '50mb' })`. With #959's
// true streaming (the body goes to a temp file, never a slice) these are a
// zip-bomb / abuse guard on the compressed upload, no longer a memory
// guard — kept at their current values.
const (
	restoreJSONBodyLimit = 50 * 1024 * 1024
	restoreZipBodyLimit  = 50 * 1024 * 1024
	postBackupBodyLimit  = 16 * 1024 // POST /api/backup's own body is tiny (sections+passphrase) — server.js's global express.json({limit:'16kb'}) default applies.
)

// restoreUnzipEntryLimit/restoreUnzipTotalLimit bound how much
// *decompressed* data the restore path will read out of a single zip
// entry, and cumulatively across every entry it reads. restoreZipBodyLimit
// only caps the compressed request body; without this a small,
// highly-compressible entry (a "zip bomb") could still inflate past memory
// as it is streamed through the JSON decoder / image validator (#901 code
// review). Package-level vars (not consts) so tests can shrink them to a
// few KB instead of deflating hundreds of MB per run.
var (
	restoreUnzipEntryLimit int64 = 100 * 1024 * 1024
	restoreUnzipTotalLimit int64 = 300 * 1024 * 1024
)

// Dependencies wires every cross-domain repository this package's export/
// restore need — one *sql.DB-backed dependency per domain this rewrite has
// split its own routes/*.js file into, plus the two ports never got a
// domain package of their own (see kv.go).
type Dependencies struct {
	DB              *sql.DB
	ShotsRepo       *shots.Repository
	LibRepo         *library.Repository
	OrdersRepo      *orders.Repository
	MaintenanceRepo *maintenance.Repository
	Registry        *machines.Registry
	// Token is the API token this server process is currently enforcing
	// (see cmd/server/main.go's auth.LoadOrCreateToken call). Included,
	// passphrase-encrypted, in a backup's `secrets` block when requested.
	// TokenFile is where a restored token is persisted — see restore.go's
	// applyRestoredToken doc comment for why writing it here does NOT take
	// effect in this already-running process until a restart (a real,
	// deliberate gap from Node's live state.apiToken — internal/auth's
	// RequireToken middleware closes over a fixed string at startup, with
	// no mutable/live token source to swap into, and building one is out
	// of this phase's scope).
	Token     string
	TokenFile string
}

// Handlers wires Dependencies into net/http handlers.
type Handlers struct {
	deps Dependencies
	rl   *ratelimit.KeyedLimiter
}

// NewHandlers builds Handlers around deps. TokenFile defaults to
// auth.DefaultTokenFile if unset.
func NewHandlers(deps Dependencies) *Handlers {
	if deps.TokenFile == "" {
		deps.TokenFile = auth.DefaultTokenFile
	}
	return &Handlers{deps: deps, rl: ratelimit.NewKeyed()}
}

// RegisterRoutes registers /api/backup and /api/restore onto mux.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/backup", h.getBackup)
	mux.HandleFunc("POST /api/backup", h.postBackup)
	mux.HandleFunc("POST /api/restore", h.postRestore)
}

// ── response helpers (see internal/httputil) ────────────────────────────

var (
	writeJSON  = httputil.WriteJSON
	writeError = httputil.WriteError
)

func internalError(w http.ResponseWriter, err error) {
	httputil.InternalError(w, "backup", err)
}

// backupTimestamp ports routes/backup.js's backupTimestamp(): a filename-
// safe local-time timestamp, e.g. "2026-08-06_08-32-05".
func backupTimestamp() string {
	return time.Now().Format("2006-01-02_15-04-05")
}

// ── GET /api/backup ──────────────────────────────────────────────────────

// getBackup ports GET /api/backup: always the unscoped, all-sections,
// secrets-free legacy JSON export — streamed straight to the response
// (backup.json's contents plus an inline base64 `images` map), never
// assembled in RAM (#959).
func (h *Handlers) getBackup(w http.ResponseWriter, r *http.Request) {
	small, err := h.deps.gatherSmallSections("")
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="glp-backup-%s.json"`, backupTimestamp()))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := h.deps.writeBundleJSON(w, small, nil, true); err != nil {
		log.Printf("backup: streaming legacy JSON export failed mid-response: %v", err)
	}
}

// ── POST /api/backup ─────────────────────────────────────────────────────

func (h *Handlers) postBackup(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, postBackupBodyLimit)
	var body struct {
		Passphrase string `json:"passphrase"`
		Sections   any    `json:"sections"`
	}
	// An empty/absent body is valid (full, secrets-free export) — only a
	// malformed non-empty body is an error, mirroring express.json()'s own
	// leniency (routes/backup.js reads req.body?.passphrase/req.body?.sections
	// with optional chaining, never requiring a body at all).
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				writeError(w, http.StatusRequestEntityTooLarge, "request entity too large")
			} else {
				writeError(w, http.StatusBadRequest, "Invalid JSON body")
			}
			return
		}
	}
	sec := normaliseSections(body.Sections)

	// Everything that can still fail cleanly (DB reads for the small
	// sections, secrets encryption) runs before the first byte of the
	// response — a failure here is a proper 500. Once the 200 + partial
	// zip is on the wire an error can only be logged (see writeBundleJSON).
	small, err := h.deps.gatherSmallSections(body.Passphrase)
	if err != nil {
		internalError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="glp-backup-%s.zip"`, backupTimestamp()))
	w.WriteHeader(http.StatusOK)

	zw := zip.NewWriter(w)
	jw, err := zw.CreateHeader(&zip.FileHeader{Name: "backup.json", Method: zip.Deflate})
	if err != nil {
		log.Printf("backup: creating backup.json zip entry: %v", err)
		return
	}
	if err := h.deps.writeBundleJSON(jw, small, sec, false); err != nil {
		log.Printf("backup: streaming backup.json failed mid-response: %v", err)
		return
	}

	if sec == nil || sec.has("shots") {
		streamImagesIntoZip(zw)
	}

	if err := zw.Close(); err != nil {
		log.Printf("backup: closing backup zip: %v", err)
	}
}

// streamImagesIntoZip copies every file in imageDir into zw as an
// images/<name> entry, one io.Copy at a time — a file is never read into a
// slice. Best-effort per file: one unreadable file must not abort the
// archive (matches routes/backup.js).
func streamImagesIntoZip(zw *zip.Writer) {
	entries, err := os.ReadDir(imageDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.Contains(entry.Name(), ".thumb.") {
			continue // thumbnails are regenerated on restore, not bundled
		}
		f, err := os.Open(filepath.Join(imageDir, entry.Name()))
		if err != nil {
			continue
		}
		iw, err := zw.CreateHeader(&zip.FileHeader{Name: "images/" + entry.Name(), Method: zip.Deflate})
		if err != nil {
			f.Close()
			log.Printf("backup: creating image zip entry %s: %v", entry.Name(), err)
			return
		}
		if _, err := io.Copy(iw, f); err != nil {
			log.Printf("backup: streaming image %s into zip: %v", entry.Name(), err)
		}
		f.Close()
	}
}
