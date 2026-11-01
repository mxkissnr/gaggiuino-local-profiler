package backup

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file implements POST /api/restore: the largest handler, split
// across a few helper functions the handler (postRestore, below) composes, following a top-to-bottom structure (parse request -> validate
// -> sanitize/preview -> [dry-run: return] -> apply -> side effects ->
// respond).
//
// # Streaming (#959)
//
// The request body is spooled to a temp file, never a slice. The bundle
// JSON is parsed twice with a streaming decoder (parseBundleStream): pass 1
// validates every shot and gathers the small sections for the dry-run
// preview; pass 2 (real restore only) re-streams the shots array straight
// into the batched upsert transaction. A legacy self-contained JSON bundle
// needs one extra shots pass between them (validateShotImages), because its
// inline images are only decoded once pass 1 has finished (#1852). Restore
// images are read one body at a time from the zip on disk. Peak memory is
// O(one shot + one image + the small sections), independent of dataset size.
//
// # Atomicity: narrowed, not eliminated
//
// Each section commits in its own transaction, so a failure partway through
// a restore can leave earlier sections applied and later ones not. The
// structured shots restore (wipe + every shot upsert + annotations + trash +
// blocklist + library-save) commits as ONE transaction via
// shots.Repository.RestoreShots — a mid-restore failure in that section
// rolls the whole section back, leaving the pre-restore shots intact. Orders
// restore is one tx (orders.ReplaceAll); the two maintenance restores,
// machines and kv are each their own tx. Atomicity remains per-section only:
// a failure after the shots tx commits but during, say, the maintenance write
// leaves shots restored and maintenance not. Threading a shared *sql.Tx
// through every repository across five packages (the only way to close that
// last gap in-process) remains out of scope. Flagged again in doc.go.
const maxShotID = shots.MaxShotID

// shotMeta is the per-shot validation state pass 1 collects while
// streaming the `shots` array — a few bytes each, never the shot body, so
// this stays O(shot count) small, not O(datapoints).
type shotMeta struct {
	jsonErr bool
	id      int64
	idOK    bool
	tsOK    bool
}

// postRestore handles POST /api/restore end to end, streamed (#959): body ->
// temp file, two-pass streaming bundle parse, batched transactional shots
// restore.
func (h *Handlers) postRestore(w http.ResponseWriter, r *http.Request) {
	contentType := r.Header.Get("Content-Type")
	isZip := strings.HasPrefix(contentType, "application/zip")

	// #1601: one coarse per-IP token for the upload itself, taken before the
	// body is spooled/unzipped/parsed — the finer dry-run/apply checks below
	// run only after parsing, since dryRun lives inside the body.
	if !h.rl.Allow("restore-upload:"+auth.RemoteIP(r), 30) {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}

	tmpPath, cleanup, err := streamRestoreBodyToTemp(r.Body, isZip)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer cleanup()

	// openBundle yields a fresh reader over backup.json's bytes (bounded by
	// the per-entry zip-bomb cap for a zip, a plain file stream for legacy
	// JSON). images is the lazy zip image source (or the legacy inline map,
	// set below once the bundle is parsed).
	var (
		openBundle    func() (io.ReadCloser, error)
		images        restoreImages
		totalUnzipped int64
	)
	if isZip {
		zr, jsonEntry, imgIdx, err := openRestoreZip(tmpPath)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		defer zr.Close()
		images = restoreImages{zip: imgIdx, total: &totalUnzipped}
		openBundle = func() (io.ReadCloser, error) {
			rc, err := jsonEntry.Open()
			if err != nil {
				return nil, err
			}
			return cappedReadCloser{Reader: newCappedReader(rc, restoreUnzipEntryLimit), c: rc}, nil
		}
	} else {
		openBundle = func() (io.ReadCloser, error) { return os.Open(tmpPath) }
	}

	// ── Pass 1: validate every shot, gather the small sections ───────────
	var (
		metas       []shotMeta
		shotPending []pendingImageWrite
	)
	rc, err := openBundle()
	if err != nil {
		internalError(w, err)
		return
	}
	b, shotCount, sawShotsArray, err := parseBundleStream(rc, func(raw json.RawMessage) error {
		var m map[string]any
		if uErr := json.Unmarshal(raw, &m); uErr != nil {
			metas = append(metas, shotMeta{jsonErr: true})
			return nil
		}
		id, idOK := jsIntStrict(m["id"])
		_, tsOK := m["timestamp"].(float64)
		metas = append(metas, shotMeta{id: id, idOK: idOK && id > 0, tsOK: tsOK})
		// Shot image validation happens here (one image body in memory at
		// most). Its cleared `.image` field only affects this in-memory
		// copy: pass 2 re-parses the raw entry, so the stored row is
		// sanitised by shots.shotInsertArgs instead. A legacy JSON bundle's
		// inline images are not decoded yet at this point, so its shots are
		// validated by validateShotImages below instead (#1852).
		if isZip {
			validateEntityImages([]map[string]any{m}, "shot-", images, &shotPending)
		}
		return nil
	})
	rc.Close()
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if isZip {
		b["dryRun"] = r.Header.Get("X-GLP-Dry-Run") == "true"
		if sectionsHeader := r.Header.Get("X-GLP-Sections"); sectionsHeader != "" {
			var sec any
			if err := json.Unmarshal([]byte(sectionsHeader), &sec); err != nil {
				writeError(w, http.StatusBadRequest, "Invalid X-GLP-Sections header")
				return
			}
			b["sections"] = sec
		}
		if passB64 := r.Header.Get("X-GLP-Passphrase-B64"); passB64 != "" {
			decoded, err := base64.StdEncoding.DecodeString(passB64)
			if err != nil {
				writeError(w, http.StatusBadRequest, "Invalid X-GLP-Passphrase-B64 header")
				return
			}
			b["passphrase"] = string(decoded)
		} else if pass := r.Header.Get("X-GLP-Passphrase"); pass != "" {
			// Legacy header: browsers can only carry ISO-8859-1 bytes in a
			// header value, so a non-ASCII passphrase arrives mangled (or makes
			// fetch throw). Kept so older clients and scripts sending an ASCII
			// passphrase keep working.
			b["passphrase"] = pass
		}
	} else {
		images = restoreImages{inline: decodeInlineImages(b["images"])}
	}

	isDryRun, _ := b["dryRun"].(bool)
	ip := auth.RemoteIP(r)
	var limitOK bool
	if isDryRun {
		limitOK = h.rl.Allow("restore-preview:"+ip, 30)
	} else {
		limitOK = h.rl.Allow("restore:"+ip, 3)
	}
	if !limitOK {
		writeError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}

	glpBackup, _ := b["glp_backup"].(bool)
	if !glpBackup || !sawShotsArray {
		writeError(w, http.StatusBadRequest, "Invalid backup file")
		return
	}
	if shotCount > maxShotID {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Backup contains too many shots (max %d)", maxShotID))
		return
	}

	sec := normaliseSections(b["sections"])
	wantsShots := sec.has("shots")
	if wantsShots {
		for i, mt := range metas {
			switch {
			case mt.jsonErr:
				writeError(w, http.StatusBadRequest, fmt.Sprintf("Backup shot #%d is not a valid object", i))
				return
			case !mt.idOK:
				writeError(w, http.StatusBadRequest, fmt.Sprintf("Backup shot #%d has an invalid id", i))
				return
			case !mt.tsOK:
				writeError(w, http.StatusBadRequest, fmt.Sprintf("Backup shot #%d (id=%d) has an invalid or missing timestamp", i, mt.id))
				return
			}
		}
	}

	// #1852: pass 1 ran before a legacy JSON bundle's inline images were
	// decoded, so none of its shots' photos could be validated there. Stream
	// the shots array once more (one shot in memory at a time, as in pass 1)
	// to queue only the photos whose bytes really are in the bundle.
	if !isZip && wantsShots {
		if err := validateShotImages(openBundle, images, &shotPending); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	plan := buildRestorePlan(b, images, shotCount)
	if plan.planErr != nil {
		writeError(w, http.StatusBadRequest, plan.planErr.Error())
		return
	}
	if wantsShots {
		plan.pending = append(plan.pending, shotPending...)
	}

	if isDryRun {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dryRun": true, "preview": plan.preview()})
		return
	}

	// ── Pass 2: re-stream the shots array into the batched restore tx ────
	shotIter := func(yield func(shots.Shot) error) error {
		src, err := openBundle()
		if err != nil {
			return err
		}
		defer src.Close()
		_, _, _, err = parseBundleStream(src, func(raw json.RawMessage) error {
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				return err
			}
			return yield(shots.Shot(m))
		})
		return err
	}

	if err := h.applyRestore(plan, shotIter); err != nil {
		internalError(w, err)
		return
	}

	if !h.applyRestoredToken(plan.restoredToken) {
		plan.secretsRestored = false
	}
	written, failed := h.writePendingImages(plan.images, plan.pending)

	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "shots": shotCount * boolToInt(wantsShots),
		// images is how many queued images were actually written and
		// imagesFailed how many could not be — so a caller (the E2E /
		// screenshot harness in particular) can verify the queued images were
		// really written instead of silently screenshotting 404s (#1185).
		"images":         written,
		"imagesFailed":   failed,
		"secretsPresent": plan.secretsPresent, "secretsRestored": plan.secretsRestored,
	})
}

// validateShotImages streams the bundle's shots array once to validate each
// shot's `.image` against imgs, queueing the ones whose bytes are present.
// Only the legacy JSON form needs it: a zip bundle's images are available
// during pass 1 already. The bundle is re-opened rather than kept in memory,
// and every key but `shots` is skipped without decoding, so peak memory stays
// one shot plus one image body (#959).
func validateShotImages(openBundle func() (io.ReadCloser, error), imgs restoreImages, pending *[]pendingImageWrite) error {
	rc, err := openBundle()
	if err != nil {
		return err
	}
	defer rc.Close()
	return streamShotBodies(rc, func(raw json.RawMessage) error {
		var m map[string]any
		if json.Unmarshal(raw, &m) != nil {
			return nil // pass 1 already rejected a malformed shot
		}
		validateEntityImages([]map[string]any{m}, "shot-", imgs, pending)
		return nil
	})
}

// streamShotBodies walks a backup bundle JSON object and hands every element
// of its `shots` array to onShot, discarding every other top-level key without
// decoding it — parseBundleStream's lean counterpart, for a pass that only
// needs the shots and must not materialise the bundle's inline `images` map a
// second time.
func streamShotBodies(r io.Reader, onShot func(json.RawMessage) error) error {
	dec := json.NewDecoder(r)
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return fmt.Errorf("invalid backup file (backup.json is not a JSON object)")
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return err
		}
		if key, _ := keyTok.(string); key != "shots" {
			if err := skipJSONValue(dec); err != nil {
				return err
			}
			continue
		}
		openTok, err := dec.Token()
		if err != nil {
			return err
		}
		if d, ok := openTok.(json.Delim); !ok || d != '[' {
			return nil // `shots` is not an array; pass 1 already rejected that
		}
		for dec.More() {
			var raw json.RawMessage
			if err := dec.Decode(&raw); err != nil {
				return err
			}
			if err := onShot(raw); err != nil {
				return err
			}
		}
		if _, err := dec.Token(); err != nil { // closing ']'
			return err
		}
	}
	return nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

var errBodyTooLarge = fmt.Errorf("request entity too large")

// errLibraryEncode rejects a restore whose coffee library cannot be encoded
// for storage: the library would otherwise be silently skipped while the
// preview still promised it.
var errLibraryEncode = fmt.Errorf("Backup coffee library could not be encoded")

// cappedReadCloser adds Close (delegating to the underlying zip entry
// reader) to a newCappedReader-wrapped stream.
type cappedReadCloser struct {
	io.Reader
	c io.Closer
}

func (r cappedReadCloser) Close() error { return r.c.Close() }
