package backup

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports routes/backup.js's POST /api/restore: the single
// largest handler in the Node app, so this port is split across a few
// helper functions the handler (postRestore, in handlers.go's sibling —
// see below) composes, roughly mirroring the Node function's own
// top-to-bottom structure (parse request -> validate -> sanitize/preview
// -> [dry-run: return] -> apply -> side effects -> respond).
//
// # Streaming (#959)
//
// The request body is spooled to a temp file, never a slice. The bundle
// JSON is parsed twice with a streaming decoder (parseBundleStream): pass 1
// validates every shot and gathers the small sections for the dry-run
// preview; pass 2 (real restore only) re-streams the shots array straight
// into the batched upsert transaction. Restore images are read one body at
// a time from the zip on disk. Peak memory is O(one shot + one image + the
// small sections), independent of dataset size.
//
// # Atomicity: narrowed, not eliminated
//
// routes/backup.js wraps every DB write in one getDb().transaction(...).
// This Go port's structured shots restore (wipe + every shot upsert +
// annotations + trash + blocklist + library-save) now commits as ONE
// transaction via shots.Repository.RestoreShots — a mid-restore failure in
// that section rolls the whole section back, leaving the pre-restore shots
// intact. Orders restore is one tx (orders.ReplaceAll); the two
// maintenance restores, machines and kv are each their own tx. What is
// still NOT Node-identical: atomicity *across* those sections — a failure
// after the shots tx commits but during, say, the maintenance write leaves
// shots restored and maintenance not. Threading a shared *sql.Tx through
// every repository across five packages (the only way to close that last
// gap in-process) remains out of scope. Flagged again in doc.go and
// go/README.md.
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

// postRestore ports POST /api/restore end to end, streamed (#959): body ->
// temp file, two-pass streaming bundle parse, batched transactional shots
// restore.
func (h *Handlers) postRestore(w http.ResponseWriter, r *http.Request) {
	contentType := r.Header.Get("Content-Type")
	isZip := strings.HasPrefix(contentType, "application/zip")

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
		// most). Discarded below if the shots section isn't in scope.
		validateEntityImages([]map[string]any{m}, "shot-", images, &shotPending)
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
		if pass := r.Header.Get("X-GLP-Passphrase"); pass != "" {
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

	plan := buildRestorePlan(b, images, shotCount)
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

	h.applyRestoredToken(plan.restoredToken)
	h.writePendingImages(plan.images, plan.pending)

	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "shots": shotCount * boolToInt(wantsShots),
		"secretsPresent": plan.secretsPresent, "secretsRestored": plan.secretsRestored,
	})
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

var errBodyTooLarge = fmt.Errorf("request entity too large")

// cappedReadCloser adds Close (delegating to the underlying zip entry
// reader) to a newCappedReader-wrapped stream.
type cappedReadCloser struct {
	io.Reader
	c io.Closer
}

func (r cappedReadCloser) Close() error { return r.c.Close() }

// restorePlan is every "what would actually be written" computation —
// identical whether this is a dry run or a real restore, so preview counts
// and applied counts can never drift apart.
type restorePlan struct {
	b          map[string]any
	sec        sections
	wantsShots bool
	shotCount  int

	images restoreImages

	sanitizedLib map[string]any // nil if not restoring a library
	libraryJSON  []byte         // marshalled library.Library for RestoreShots; nil = don't touch
	pending      []pendingImageWrite

	// pre-validated shots-section side data, applied inside RestoreShots' tx
	validAnnotations map[string]map[string]any
	validTrash       map[string]int64
	blocklist        []string // non-nil (possibly empty) = wipe+rewrite the blocklist

	validMaintenance    []maintenance.RawRow
	maintenanceTotal    int
	validMaintenanceLog []maintenance.RawLogRow
	maintenanceLogTotal int

	validOrders []orders.Order
	ordersTotal int

	wantsMachines    bool
	restoredMachines []machines.Machine

	wantsSettings bool

	secretsPresent   bool
	secretsRestored  bool
	decryptedSecrets map[string]any
	restoredToken    string
}

// buildRestorePlan ports the "Every 'what would actually be written'
// computation" block of routes/backup.js's POST /api/restore, from
// `sections := normaliseSections(...)` through `restoredToken`.
func buildRestorePlan(b map[string]any, images restoreImages, shotCount int) restorePlan {
	sec := normaliseSections(b["sections"])
	wantsShots := sec.has("shots")

	plan := restorePlan{b: b, sec: sec, wantsShots: wantsShots, shotCount: shotCount, images: images}

	wantsSecrets := sec.has("secrets")
	passphrase, _ := b["passphrase"].(string)
	secretsBlob, hasSecretsField := b["secrets"].(map[string]any)
	plan.secretsPresent = wantsSecrets && hasSecretsField
	if plan.secretsPresent && passphrase != "" {
		if enc := decodeEncryptedSecrets(secretsBlob); enc != nil {
			plan.decryptedSecrets = DecryptSecrets(enc, passphrase)
		}
	}
	plan.secretsRestored = plan.decryptedSecrets != nil

	if wantsShots {
		if rawLib, ok := b["coffee_library"].(map[string]any); ok {
			sanitized := map[string]any{}
			for k, v := range rawLib {
				sanitized[k] = v
			}
			validateRestoredLibraryImages(sanitized, images, &plan.pending)
			plan.sanitizedLib = sanitized
			if jb, err := json.Marshal(mapToLibrary(sanitized)); err == nil {
				plan.libraryJSON = jb
			}
		}
		if ann, ok := b["annotations"].(map[string]any); ok {
			plan.validAnnotations = map[string]map[string]any{}
			for idStr, raw := range ann {
				m, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				if issues := shots.ValidateAnnotation(m); len(issues) > 0 {
					continue
				}
				if _, err := strconv.ParseInt(idStr, 10, 64); err != nil {
					continue
				}
				plan.validAnnotations[idStr] = m
			}
		}
		if trash, ok := b["trash"].(map[string]any); ok {
			plan.validTrash = map[string]int64{}
			for idStr, raw := range trash {
				if _, err := strconv.ParseInt(idStr, 10, 64); err != nil {
					continue
				}
				deletedAt, ok := jsFiniteNumber(raw)
				if !ok {
					deletedAt = float64(nowMillis())
				}
				plan.validTrash[idStr] = int64(deletedAt)
			}
		}
		if arr, ok := b["blocklist"].([]any); ok {
			list := make([]string, 0, len(arr))
			for _, v := range arr {
				if n, ok := jsFiniteNumber(v); ok {
					list = append(list, formatBlocklistValue(n))
				} else if s, ok := v.(string); ok {
					list = append(list, s)
				}
			}
			plan.blocklist = list
		}
	}

	if sec.has("maintenance") {
		if arr, ok := b["maintenance"].([]any); ok {
			plan.maintenanceTotal = len(arr)
			for _, v := range arr {
				m, _ := v.(map[string]any)
				if sanitized, ok := sanitizeMaintenanceRow(m); ok {
					plan.validMaintenance = append(plan.validMaintenance, toRawRow(sanitized))
				}
			}
		}
		if arr, ok := b["maintenance_log"].([]any); ok {
			plan.maintenanceLogTotal = len(arr)
			for _, v := range arr {
				m, _ := v.(map[string]any)
				if sanitized, ok := sanitizeMaintenanceLogRow(m); ok {
					plan.validMaintenanceLog = append(plan.validMaintenanceLog, toRawLogRow(sanitized))
				}
			}
		}
	}

	if sec.has("orders") {
		if arr, ok := b["orders"].([]any); ok {
			plan.ordersTotal = len(arr)
			for _, v := range arr {
				m, _ := v.(map[string]any)
				if sanitized, ok := sanitizeOrderRow(m); ok {
					plan.validOrders = append(plan.validOrders, orders.Order(sanitized))
				}
			}
		}
	}

	if arr, ok := b["machines"].([]any); ok && sec.has("machines") {
		plan.wantsMachines = true
		var list []machines.Machine
		if err := reDecode(arr, &list); err == nil {
			plan.restoredMachines = list
		}
	}

	plan.wantsSettings = sec.has("settings")

	if s, ok := plan.decryptedSecrets["apiToken"].(string); ok {
		plan.restoredToken = sanitizeToken(s)
	}

	return plan
}

func decodeEncryptedSecrets(m map[string]any) *EncryptedSecrets {
	var enc EncryptedSecrets
	if err := reDecode(m, &enc); err != nil {
		return nil
	}
	return &enc
}

// sanitizeToken ports `decryptedSecrets?.apiToken.replace(/[\r\n\0]/g,
// ”).trim().slice(0, 200)`.
func sanitizeToken(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r == '\r' || r == '\n' || r == 0 {
			continue
		}
		out = append(out, r)
	}
	trimmed := trimString(string(out))
	return truncateRunes(trimmed, 200)
}

func toRawRow(m map[string]any) maintenance.RawRow {
	machineID, _ := m["machineId"].(int64)
	key, _ := m["key"].(string)
	data, _ := json.Marshal(m["data"])
	return maintenance.RawRow{MachineID: machineID, Key: key, Data: data}
}

func toRawLogRow(m map[string]any) maintenance.RawLogRow {
	get := func(k string) int64 { v, _ := m[k].(int64); return v }
	getS := func(k string) string { v, _ := m[k].(string); return v }
	return maintenance.RawLogRow{
		ID: get("id"), TS: get("ts"), Date: getS("date"), Task: getS("task"),
		Machine: getS("machine"), ShotCount: get("shotCount"), Notes: getS("notes"),
		MachineID: get("machineId"),
	}
}

// reDecode round-trips v (already-decoded generic JSON values) through
// encoding/json into a specifically-typed out — used where a typed
// destination (machines.Machine, EncryptedSecrets) is easier to populate
// via a second decode pass than by hand-picking fields out of a
// map[string]any, the same trade-off shots.Shot/library.Entity/
// orders.Order's own "just use the generic map" choice makes in the other
// direction for shapes with no fixed structure.
func reDecode(v any, out any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

// preview ports the dry-run response's `preview` object.
func (p restorePlan) preview() map[string]any {
	shotsCount := 0
	if p.wantsShots {
		shotsCount = p.shotCount
	}
	return map[string]any{
		"shots":               shotsCount,
		"library":             p.wantsShots && p.sanitizedLib != nil,
		"maintenance":         len(p.validMaintenance),
		"maintenanceTotal":    p.maintenanceTotal,
		"maintenanceLog":      len(p.validMaintenanceLog),
		"maintenanceLogTotal": p.maintenanceLogTotal,
		"orders":              len(p.validOrders),
		"ordersTotal":         p.ordersTotal,
		"machines":            machineCountForPreview(p),
		"settings":            p.wantsSettings && p.b["kv"] != nil,
		"images":              len(p.pending),
		"secretsPresent":      p.secretsPresent,
		"secretsRestored":     p.secretsRestored,
		"sectionsPresent":     sectionsPresent(p.b),
	}
}

func machineCountForPreview(p restorePlan) int {
	if !p.wantsMachines {
		return 0
	}
	if arr, ok := p.b["machines"].([]any); ok {
		return len(arr)
	}
	return 0
}

// sectionsPresent ports `Object.keys(SECTION_PRESENCE_BUNDLE_KEYS).filter(key
// => SECTION_PRESENCE_BUNDLE_KEYS[key].some(k => k in b))`.
func sectionsPresent(b map[string]any) []string {
	out := []string{}
	for _, name := range sectionOrder {
		for _, key := range sectionPresenceBundleKeys[name] {
			if _, ok := b[key]; ok {
				out = append(out, name)
				break
			}
		}
	}
	return out
}

// applyRestore ports the real (non-dry-run) restore. The shots section
// (wipe + every shot upsert + annotations + trash + blocklist + library)
// now commits as ONE transaction via shots.Repository.RestoreShots
// (#959); the remaining sections stay their own internal txs — see this
// file's header comment for the narrowed atomicity gap.
func (h *Handlers) applyRestore(p restorePlan, shotIter func(yield func(shots.Shot) error) error) error {
	d := h.deps
	if p.wantsShots {
		if err := d.ShotsRepo.RestoreShots(shots.RestoreInput{
			Shots:       shotIter,
			Annotations: p.validAnnotations,
			Trash:       p.validTrash,
			Blocklist:   p.blocklist,
			LibraryJSON: p.libraryJSON,
		}); err != nil {
			return err
		}
	}

	if p.sec.has("maintenance") {
		if _, ok := p.b["maintenance"].([]any); ok {
			if err := d.MaintenanceRepo.RestoreMaintenanceRaw(p.validMaintenance); err != nil {
				return err
			}
		}
		if _, ok := p.b["maintenance_log"].([]any); ok {
			if err := d.MaintenanceRepo.RestoreMaintenanceLogRaw(p.validMaintenanceLog); err != nil {
				return err
			}
		}
	}

	if p.sec.has("orders") {
		if _, ok := p.b["orders"].([]any); ok {
			if err := d.OrdersRepo.ReplaceAll(p.validOrders); err != nil {
				return err
			}
		}
	}

	if p.wantsMachines {
		if _, err := d.Registry.RestoreMachines(p.restoredMachines); err != nil {
			return err
		}
	}

	if p.wantsSettings {
		if kv, ok := p.b["kv"].(map[string]any); ok {
			if err := h.applyKVSettings(kv); err != nil {
				return err
			}
		}
	}

	if mqtt, ok := p.decryptedSecrets["mqtt"].(map[string]any); ok {
		username, _ := mqtt["username"].(string)
		password, _ := mqtt["password"].(string)
		if err := saveMqttSettings(d.DB, map[string]any{
			"username": truncateRunes(username, 200), "password": truncateRunes(password, 500),
		}); err != nil {
			return err
		}
	}

	return nil
}

func formatBlocklistValue(n float64) string {
	if n == float64(int64(n)) {
		return strconv.FormatInt(int64(n), 10)
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

func (h *Handlers) applyKVSettings(kv map[string]any) error {
	d := h.deps
	if arr, ok := kv["menu"].([]any); ok {
		menu := make([]orders.MenuItem, 0, len(arr))
		for _, v := range arr {
			if m, ok := v.(map[string]any); ok {
				menu = append(menu, orders.MenuItem(m))
			}
		}
		if err := d.OrdersRepo.SaveMenu(menu); err != nil {
			return err
		}
	}
	if s, ok := kv["orders_settings"].(map[string]any); ok {
		if err := d.OrdersRepo.SaveSettings(orders.Settings(s)); err != nil {
			return err
		}
	}
	if m, ok := kv["notify_mapping"].(map[string]any); ok {
		mapping := orders.NotifyMapping{}
		for k, v := range m {
			if s, ok := v.(string); ok {
				mapping[k] = s
			}
		}
		if err := d.OrdersRepo.SaveNotifyMapping(mapping); err != nil {
			return err
		}
	}
	if s, ok := kv["import_settings"].(map[string]any); ok {
		if err := saveImportSettings(d.DB, s); err != nil {
			return err
		}
	}
	if s, ok := kv["mqtt_settings"].(map[string]any); ok {
		rest := map[string]any{}
		for k, v := range s {
			if k == "username" || k == "password" {
				continue
			}
			rest[k] = v
		}
		if err := saveMqttSettings(d.DB, rest); err != nil {
			return err
		}
	}
	return nil
}

// mapToLibrary converts a generic decoded coffee_library object into a
// typed library.Library — see restore.go's header comment on reDecode for
// why a typed destination is used here, and library.Entity's `= map[string]
// any` alias definition (library/model.go) for why the []any -> []Entity
// element conversion below needs no per-element type conversion syntax.
// mapToLibrary converts the generic decoded coffee_library object into a
// typed library.Library, THEN re-sanitizes every entity's fields via
// SanitizeLibraryForRestore — routes/backup.js's sanitizeRestoredLibrary()
// call, which must run on every restored library regardless of section
// scope, since a restored library bypasses the regular POST/PUT bean/
// grinder/recipe routes entirely (see restore_sanitize.go's doc comment).
func mapToLibrary(m map[string]any) library.Library {
	raw := library.Library{
		Beans: entityList(m["beans"]), Grinders: entityList(m["grinders"]),
		Recipes: entityList(m["recipes"]), Milks: entityList(m["milks"]),
		Baskets: entityList(m["baskets"]), PuckScreens: entityList(m["puckScreens"]),
	}
	return library.SanitizeLibraryForRestore(raw)
}

// entityList converts a generic decoded JSON array (`[]any` of
// `map[string]any` elements) into `[]library.Entity` — no per-element
// conversion needed since `library.Entity = map[string]any` is a type
// alias, not a distinct named type.
func entityList(v any) []library.Entity {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]library.Entity, 0, len(arr))
	for _, item := range arr {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// applyRestoredToken persists a restored API token to disk. See
// Dependencies.Token's doc comment: this does NOT take effect in the
// already-running process (internal/auth.RequireToken closes over a fixed
// token string at startup) until the process restarts — a documented,
// deliberate gap from Node's live state.apiToken.
func (h *Handlers) applyRestoredToken(token string) {
	if token == "" {
		return
	}
	tmp := h.deps.TokenFile + ".tmp"
	if err := os.WriteFile(tmp, []byte(token), 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, h.deps.TokenFile)
}

// writePendingImages streams each validated image from the restore image
// source to its final path after the DB tx has committed (unchanged
// ordering). The bytes are re-read from the zip entry here, one at a time,
// rather than held in the plan since a heavily-illustrated library would
// otherwise sum every image body in memory (#959).
func (h *Handlers) writePendingImages(imgs restoreImages, pending []pendingImageWrite) {
	for _, w := range pending {
		buf, ok := imgs.getForWrite(w.srcName)
		if !ok || len(buf) == 0 || len(buf) > imageMaxBytes {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(w.path), 0o755); err != nil {
			continue
		}
		_ = os.WriteFile(w.path, buf, 0o644)
	}
}
