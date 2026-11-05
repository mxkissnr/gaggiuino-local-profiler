package machinebackups

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/redact"
)

const (
	backUpNowPerMinute = 10
	maxRequestBytes    = 4 << 10
	maxNoteRunes       = 200

	downloadPerMinute = 10
	uploadPerMinute   = 10
	// maxUploadRequestBytes is the machine's own document limit plus the
	// envelope (machineId and note).
	maxUploadRequestBytes = machines.MaxSettingsBackupBytes + maxRequestBytes

	// secretsHeader tells a client whether a downloaded file holds the
	// machine's secrets in plain text; the client must warn accordingly.
	secretsHeader  = "X-GLP-Secrets"
	secretsMerged  = "merged"
	secretsMissing = "missing"

	codeUnsupportedMachine  = "unsupported_machine"
	codeUnsupportedFirmware = "unsupported_firmware"
	codeMachineUnreachable  = "machine_unreachable"
	codeInvalidBackup       = "invalid_backup"
	codeMachineBusy         = "machine_busy"
	codeOperationRunning    = "operation_running"
)

// MachineGetter is the registry surface the handlers need.
type MachineGetter interface {
	GetMachine(id int64) (*machines.Machine, error)
}

// HandlerDeps are the handlers' collaborators. Now is optional.
type HandlerDeps struct {
	Repo     *Repository
	Machines MachineGetter
	Client   func(*machines.Machine) (Client, bool)
	Now      func() time.Time
}

// Handlers serves the settings backup routes of #1878.
type Handlers struct {
	deps HandlerDeps
	rl   *ratelimit.KeyedLimiter
}

func NewHandlers(d HandlerDeps) *Handlers {
	return &Handlers{deps: d, rl: ratelimit.NewKeyed()}
}

// RegisterRoutes mounts the eight machine settings backup routes. They sit
// behind the global token/ingress auth and are not on the kiosk allow-list.
func (h *Handlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/machine/backups", h.list)
	mux.HandleFunc("POST /api/machine/backups", h.backUpNow)
	mux.HandleFunc("POST /api/machine/backups/upload", h.upload)
	mux.HandleFunc("GET /api/machine/backups/{id}", h.document)
	mux.HandleFunc("GET /api/machine/backups/{id}/download", h.download)
	mux.HandleFunc("DELETE /api/machine/backups/{id}", h.remove)
	mux.HandleFunc("GET /api/machine/backups/settings", h.getSettings)
	mux.HandleFunc("PUT /api/machine/backups/settings", h.putSettings)
}

func (h *Handlers) now() time.Time {
	if h.deps.Now != nil {
		return h.deps.Now()
	}
	return time.Now()
}

func writeCodeError(w http.ResponseWriter, status int, code, message string) {
	httputil.WriteJSON(w, status, map[string]string{"error": message, "code": code})
}

// cleanNote drops control characters and cuts the note to maxNoteRunes. The note
// is user text: the frontend renders it only through escapeHtml/html, and it is
// never used in a header, a path or a log line.
func cleanNote(s string) string {
	cleaned := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	runes := []rune(strings.TrimSpace(cleaned))
	if len(runes) > maxNoteRunes {
		runes = runes[:maxNoteRunes]
	}
	return strings.TrimSpace(string(runes))
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) {
	machineID := int64(0)
	if raw := r.URL.Query().Get("machineId"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 1 {
			httputil.WriteError(w, http.StatusBadRequest, "Invalid machineId")
			return
		}
		machineID = parsed
	}
	entries, err := h.deps.Repo.list(machineID)
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, entries)
}

func (h *Handlers) backUpNow(w http.ResponseWriter, r *http.Request) {
	if !h.rl.Allow("machine-backup:"+auth.RemoteIP(r), backUpNowPerMinute) {
		httputil.WriteError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}
	var body struct {
		MachineID *int64 `json:"machineId"`
		Note      string `json:"note"`
	}
	if !httputil.DecodeJSONBodyInto(w, r, maxRequestBytes, &body) {
		return
	}
	if body.MachineID == nil || *body.MachineID < 1 {
		httputil.WriteError(w, http.StatusBadRequest, "machineId required")
		return
	}
	m, err := h.deps.Machines.GetMachine(*body.MachineID)
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return
	}
	if m == nil {
		httputil.WriteError(w, http.StatusNotFound, "Unknown machine")
		return
	}
	c, ok := h.deps.Client(m)
	if !ok || c == nil {
		writeCodeError(w, http.StatusNotImplemented, codeUnsupportedMachine,
			"Settings backups are only available for Gaggiuino machines")
		return
	}
	mu := h.deps.Repo.machineLock(m.ID)
	if !mu.TryLock() {
		writeCodeError(w, http.StatusConflict, codeOperationRunning,
			"Another backup or restore of this machine is running")
		return
	}
	defer mu.Unlock()

	p, err := fetchPrepared(r.Context(), c, m)
	switch {
	case errors.Is(err, errMachineBusy):
		writeCodeError(w, http.StatusConflict, codeMachineBusy, "The machine is brewing or steaming")
		return
	case errors.Is(err, machines.ErrSettingsBackupUnsupported):
		writeCodeError(w, http.StatusNotImplemented, codeUnsupportedFirmware,
			"The machine's firmware has no settings backup (needs Gaggiuino main-8aaf6f0 or later)")
		return
	case errors.Is(err, ErrInvalidDocument), errors.Is(err, machines.ErrSettingsBackupTooLarge):
		log.Printf("machinebackups: machine %d sent a settings backup GLP cannot store: %s", m.ID, redact.Redact(err.Error()))
		writeCodeError(w, http.StatusBadGateway, codeInvalidBackup,
			"The machine sent a settings backup GLP cannot store")
		return
	case errors.Is(err, errMachineOffline):
		writeCodeError(w, http.StatusBadGateway, codeMachineUnreachable, "The machine did not answer")
		return
	case err != nil:
		log.Printf("machinebackups: back up now for machine %d failed: %s", m.ID, redact.Redact(err.Error()))
		writeCodeError(w, http.StatusBadGateway, codeMachineUnreachable, "The machine did not answer")
		return
	}

	entry, err := h.deps.Repo.insert(m.ID, KindManual, cleanNote(body.Note), p, h.now())
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return
	}
	log.Printf("machinebackups: stored manual backup of machine %d (%d profiles, %d bytes)",
		entry.MachineID, entry.ProfileCount, entry.SizeBytes)
	httputil.WriteJSON(w, http.StatusCreated, entry)
}

func (h *Handlers) remove(w http.ResponseWriter, r *http.Request) {
	id, ok := parseBackupID(r)
	if !ok {
		httputil.WriteError(w, http.StatusNotFound, "Backup not found")
		return
	}
	found, err := h.deps.Repo.remove(id)
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return
	}
	if !found {
		httputil.WriteError(w, http.StatusNotFound, "Backup not found")
		return
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// parseBackupID reads the {id} path value; false means no usable id.
func parseBackupID(r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		return 0, false
	}
	return id, true
}

// storedBackup loads the row behind {id}; it answers 404 for a bad or unknown id
// and 500 for a database error, and reports false in both cases.
func (h *Handlers) storedBackup(w http.ResponseWriter, r *http.Request) (Entry, string, bool) {
	id, ok := parseBackupID(r)
	if !ok {
		httputil.WriteError(w, http.StatusNotFound, "Backup not found")
		return Entry{}, "", false
	}
	entry, data, found, err := h.deps.Repo.get(id)
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return Entry{}, "", false
	}
	if !found {
		httputil.WriteError(w, http.StatusNotFound, "Backup not found")
		return Entry{}, "", false
	}
	return entry, data, true
}

// entryDocument is the answer of GET /api/machine/backups/{id}. The document is
// the stored one, secret-free by construction (every write goes through
// prepare).
type entryDocument struct {
	Entry
	Document json.RawMessage `json:"document"`
}

// document serves one stored backup with its document. It never contacts the
// machine, so a deleted machine's backup stays readable.
func (h *Handlers) document(w http.ResponseWriter, r *http.Request) {
	entry, data, ok := h.storedBackup(w, r)
	if !ok {
		return
	}
	httputil.WriteJSON(w, http.StatusOK, entryDocument{Entry: entry, Document: json.RawMessage(data)})
}

// download answers the stored backup in the machine's native format. The
// machine's rule from fetchPrepared applies (never load it during a shot or
// while steaming), and only an unreachable or unusable source falls back to the
// secret-free file.
func (h *Handlers) download(w http.ResponseWriter, r *http.Request) {
	if !h.rl.Allow("machine-backup-download:"+auth.RemoteIP(r), downloadPerMinute) {
		httputil.WriteError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}
	entry, data, ok := h.storedBackup(w, r)
	if !ok {
		return
	}
	body, secrets, ok := h.downloadBody(w, r, entry, []byte(data))
	if !ok {
		return
	}
	created := time.UnixMilli(entry.CreatedAt).Local().Format("2006-01-02_1504")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set(secretsHeader, secrets)
	w.Header().Set("Content-Disposition", fmt.Sprintf(
		`attachment; filename="gaggiuino-backup-m%d-%s.json"`, entry.MachineID, created))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// downloadBody merges the machine's current secrets into the stored document.
// ok is false after an answer has already been written.
func (h *Handlers) downloadBody(w http.ResponseWriter, r *http.Request, entry Entry, data []byte) (body []byte, secrets string, ok bool) {
	withoutSecrets := func(reason string) ([]byte, string, bool) {
		log.Printf("machinebackups: backup %d of machine %d downloaded without secrets: %s",
			entry.ID, entry.MachineID, redact.Redact(reason))
		return data, secretsMissing, true
	}
	m, err := h.deps.Machines.GetMachine(entry.MachineID)
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return nil, "", false
	}
	if m == nil {
		return withoutSecrets("the machine is no longer registered")
	}
	c, found := h.deps.Client(m)
	if !found || c == nil {
		return withoutSecrets("the machine has no settings backup")
	}
	mu := h.deps.Repo.machineLock(m.ID)
	if !mu.TryLock() {
		writeCodeError(w, http.StatusConflict, codeOperationRunning,
			"Another backup or restore of this machine is running")
		return nil, "", false
	}
	defer mu.Unlock()
	current, err := fetchDocument(r.Context(), c, m)
	if errors.Is(err, errMachineBusy) {
		writeCodeError(w, http.StatusConflict, codeMachineBusy, "The machine is brewing or steaming")
		return nil, "", false
	}
	if err != nil {
		return withoutSecrets(err.Error())
	}
	merged, copied, err := mergeDocuments(data, current)
	if err != nil {
		return withoutSecrets(err.Error())
	}
	if copied == 0 {
		return withoutSecrets("the machine's backup carries no secret")
	}
	log.Printf("machinebackups: backup %d of machine %d downloaded with the machine's current secrets",
		entry.ID, entry.MachineID)
	return merged, secretsMerged, true
}

// upload stores one uploaded settings backup file. The raw document stays in
// memory only; prepare is the only way to the database, and it strips the
// secrets before the insert. Upload never contacts the machine, so it needs no
// client and no machine lock.
func (h *Handlers) upload(w http.ResponseWriter, r *http.Request) {
	if !h.rl.Allow("machine-backup-upload:"+auth.RemoteIP(r), uploadPerMinute) {
		httputil.WriteError(w, http.StatusTooManyRequests, "Rate limit exceeded")
		return
	}
	var body struct {
		MachineID *int64          `json:"machineId"`
		Note      string          `json:"note"`
		Document  json.RawMessage `json:"document"`
	}
	if !httputil.DecodeJSONBodyInto(w, r, maxUploadRequestBytes, &body) {
		return
	}
	if body.MachineID == nil || *body.MachineID < 1 {
		httputil.WriteError(w, http.StatusBadRequest, "machineId required")
		return
	}
	id := *body.MachineID
	if !h.requireGaggiuino(w, id) {
		return
	}
	p, err := prepare(body.Document)
	if err != nil {
		log.Printf("machinebackups: rejected an uploaded settings backup for machine %d: %s",
			id, redact.Redact(err.Error()))
		writeCodeError(w, http.StatusBadRequest, codeInvalidBackup,
			"The file is not a Gaggiuino settings backup GLP can store")
		return
	}
	entry, err := h.deps.Repo.insert(id, KindUploaded, cleanNote(body.Note), p, h.now())
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return
	}
	log.Printf("machinebackups: stored uploaded backup of machine %d (%d profiles, %d bytes)",
		entry.MachineID, entry.ProfileCount, entry.SizeBytes)
	httputil.WriteJSON(w, http.StatusCreated, entry)
}

// requireGaggiuino answers 404/501/500 and returns false when the machine cannot
// have settings backups. It checks the type, not the Client lookup: a Gaggiuino
// machine without a host may still be configured.
func (h *Handlers) requireGaggiuino(w http.ResponseWriter, id int64) bool {
	m, err := h.deps.Machines.GetMachine(id)
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return false
	}
	if m == nil {
		httputil.WriteError(w, http.StatusNotFound, "Unknown machine")
		return false
	}
	if m.Type != "gaggiuino" {
		writeCodeError(w, http.StatusNotImplemented, codeUnsupportedMachine,
			"Settings backups are only available for Gaggiuino machines")
		return false
	}
	return true
}

func (h *Handlers) getSettings(w http.ResponseWriter, r *http.Request) {
	machineID, err := strconv.ParseInt(r.URL.Query().Get("machineId"), 10, 64)
	if err != nil || machineID < 1 {
		httputil.WriteError(w, http.StatusBadRequest, "Invalid machineId")
		return
	}
	if !h.requireGaggiuino(w, machineID) {
		return
	}
	s, err := h.deps.Repo.settingsFor(machineID)
	if err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return
	}
	httputil.WriteJSON(w, http.StatusOK, machineSettings{MachineID: machineID, Settings: s})
}

func (h *Handlers) putSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MachineID     *int64  `json:"machineId"`
		Schedule      *string `json:"schedule"`
		KeepAutomatic *int    `json:"keepAutomatic"`
	}
	if !httputil.DecodeJSONBodyInto(w, r, maxRequestBytes, &body) {
		return
	}
	if body.MachineID == nil || *body.MachineID < 1 {
		httputil.WriteError(w, http.StatusBadRequest, "machineId required")
		return
	}
	if body.Schedule == nil || !validSchedule(*body.Schedule) {
		httputil.WriteError(w, http.StatusBadRequest, "schedule must be off, daily or weekly")
		return
	}
	if body.KeepAutomatic == nil || !validKeepAutomatic(*body.KeepAutomatic) {
		httputil.WriteError(w, http.StatusBadRequest, "keepAutomatic must be a whole number from 1 to 100")
		return
	}
	id := *body.MachineID
	if !h.requireGaggiuino(w, id) {
		return
	}
	s := Settings{Schedule: *body.Schedule, KeepAutomatic: *body.KeepAutomatic}
	if err := h.deps.Repo.saveSettings(id, s); err != nil {
		httputil.InternalError(w, "machinebackups", err)
		return
	}
	log.Printf("machinebackups: machine %d automatic backups set to %s, keep %d", id, s.Schedule, s.KeepAutomatic)
	httputil.WriteJSON(w, http.StatusOK, machineSettings{MachineID: id, Settings: s})
}
