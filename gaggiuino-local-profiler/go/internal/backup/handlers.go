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
	"strconv"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/achievements"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file implements the backup/restore routes (GET/POST /api/backup,
// POST /api/restore) on Go 1.22+'s method-and-wildcard http.ServeMux.

// restoreJSONBodyLimit/restoreZipBodyLimit cap the restore upload body. With
// #959's true streaming (the body goes to a temp file, never a slice) these
// are a zip-bomb / abuse guard on the compressed upload, no longer a memory
// guard — kept at their current values.
const (
	restoreJSONBodyLimit = 50 * 1024 * 1024
	restoreZipBodyLimit  = 50 * 1024 * 1024
	postBackupBodyLimit  = 16 * 1024 // POST /api/backup's own body is tiny (sections+passphrase).
)

// backupEnvelopeEstimateBytes and perShotEstimateBytes feed the
// X-GLP-Backup-Estimate response header on POST /api/backup — a purely
// client-side progress hint (#960). Both are deliberately approximate: the
// real body is DEFLATE-compressed and a hydrated shot's JSON (profile +
// datapoints) varies widely, so perShotEstimateBytes is a rough guess, not
// a measurement. The client MUST clamp the displayed bar at 99% until the
// stream actually ends (see the header spec above postBackup), which makes
// an under-estimate harmless and a mild over-estimate only cap the bar
// below 99% before it jumps to 100.
const (
	backupEnvelopeEstimateBytes = 4 * 1024 // non-shot JSON sections + envelope
	perShotEstimateBytes        = 4 * 1024 // rough deflated size of one hydrated shot's JSON
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
// restore need — one *sql.DB-backed dependency per domain, plus the two
// settings blobs that have no domain package of their own (see kv.go).
type Dependencies struct {
	DB              *sql.DB
	ShotsRepo       *shots.Repository
	LibRepo         *library.Repository
	OrdersRepo      *orders.Repository
	MaintenanceRepo *maintenance.Repository
	Registry        *machines.Registry
	// AchievementsRepo carries the achievements table through the shots
	// section's `achievements` bundle key. Restore writes via
	// achievements.Repository.ReplaceAll.
	AchievementsRepo *achievements.Repository
	// Token is the API token this server process is currently enforcing
	// (see cmd/server/main.go's auth.LoadOrCreateToken call). Included,
	// passphrase-encrypted, in a backup's `secrets` block when requested.
	// TokenFile is where a restored token is persisted — see restore.go's
	// applyRestoredToken doc comment for why writing it here does NOT take
	// effect in this already-running process until a restart (a real,
	// deliberate gap: internal/auth's RequireToken middleware closes over a
	// fixed string at startup, with no mutable/live token source to swap into,
	// and building one is out of scope).
	Token     string
	TokenFile string
}

// Handlers wires Dependencies into net/http handlers.
type Handlers struct {
	deps Dependencies
	rl   *ratelimit.KeyedLimiter

	// onExported runs after a backup export has been written completely and
	// without error — both GET /api/backup's legacy JSON and POST
	// /api/backup's zip. Set via SetOnExported by cmd/server, which uses it
	// to drive the backup achievement (#1286 R2). A callback rather than a
	// direct achievements.Service call so this domain stays decoupled from
	// the achievements package (mirrors machines.Handlers.SetOnProfileSaved).
	// A nil hook is a no-op; the callback never alters the response.
	onExported func()
}

// SetOnExported wires the side effect to run after a backup export has been
// written completely and without error (#1286 R2). cmd/server uses it to let
// the achievements service see a `backup-exported` event, which unlocks the
// backup badge. A nil hook (never wired, e.g. in this package's own unit
// tests) is a no-op, and the callback never changes the response — the
// export itself already succeeded.
func (h *Handlers) SetOnExported(fn func()) {
	h.onExported = fn
}

func (h *Handlers) notifyExported() {
	if h.onExported != nil {
		h.onExported()
	}
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

// backupTimestamp returns a filename-safe local-time timestamp, e.g.
// "2026-08-06_08-32-05".
func backupTimestamp() string {
	return time.Now().Format("2006-01-02_15-04-05")
}

// backupRateLimitPerMin is the dedicated per-IP ceiling for GET /api/backup
// (#1056). The legacy export streams the entire database plus every stored
// image on every hit — strictly more than GET /api/debug/export-db, which
// only streams the raw SQLite file and is already limited to 5/min (#999,
// security audit #977 round 3 finding 3.2) — so it gets the same feature
// limiter on top of the app-wide 600/min backstop. This is DELIBERATELY
// STRICTER than the image-upload routes, which rely on the shared backstop
// alone.
const backupRateLimitPerMin = 5

// ── GET /api/backup ──────────────────────────────────────────────────────

// getBackup serves GET /api/backup: always the unscoped, all-sections,
// secrets-free legacy JSON export — streamed straight to the response
// (backup.json's contents plus an inline base64 `images` map), never
// assembled in RAM (#959).
func (h *Handlers) getBackup(w http.ResponseWriter, r *http.Request) {
	if !h.rl.Allow("backup:"+auth.RemoteIP(r), backupRateLimitPerMin) {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}
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
		return
	}
	h.notifyExported()
}

// ── POST /api/backup ─────────────────────────────────────────────────────

// postBackup streams the selective/encrypted zip export. Before the first
// body byte it emits X-GLP-Backup-Estimate: an approximate upper-ish bound
// on the response size (stat-only — it never opens an image or a shot row),
// for a client-side determinate progress bar. Clients clamp at 99% until
// the stream ends and treat a missing/zero/non-numeric header as
// indeterminate (a missing header is unknown, not zero).
func (h *Handlers) postBackup(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, postBackupBodyLimit)
	var body struct {
		Passphrase string `json:"passphrase"`
		Sections   any    `json:"sections"`
	}
	// An empty/absent body is valid (full, secrets-free export) — only a
	// malformed non-empty body is an error; passphrase/sections are optional
	// fields and the request never requires a body.
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

	est, err := h.backupSizeEstimate(sec)
	if err != nil {
		internalError(w, err)
		return
	}

	w.Header().Set("X-GLP-Backup-Estimate", strconv.FormatInt(est, 10))
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
		return
	}
	h.notifyExported()
}

// backupSizeEstimate computes the X-GLP-Backup-Estimate value for a given
// section scope. It is stat-only: it counts shot rows and sums the on-disk
// size of the image files streamImagesIntoZip would bundle, without opening
// a single image or hydrating a single shot. The image filter mirrors
// streamImagesIntoZip exactly (skip directories and *.thumb.* files). A
// missing/unreadable image directory is treated as "no images" rather than
// an error; only a DB failure counting shots propagates (still pre-header,
// so a clean 500).
func (h *Handlers) backupSizeEstimate(sec sections) (int64, error) {
	inScope := sec == nil || sec.has("shots")
	est := int64(backupEnvelopeEstimateBytes)
	if !inScope {
		return est, nil
	}

	n, err := h.deps.ShotsRepo.Count()
	if err != nil {
		return 0, err
	}
	est += int64(n) * perShotEstimateBytes

	entries, err := os.ReadDir(imageDir)
	if err != nil {
		return est, nil
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.Contains(entry.Name(), ".thumb.") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		est += info.Size()
	}
	return est, nil
}

// streamImagesIntoZip copies every file in imageDir into zw as an
// images/<name> entry, one io.Copy at a time — a file is never read into a
// slice. Best-effort per file: one unreadable file must not abort the
// archive.
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
