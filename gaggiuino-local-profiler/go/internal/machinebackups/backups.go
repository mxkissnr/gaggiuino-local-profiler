// Package machinebackups keeps a versioned list of Gaggiuino machine settings
// backups (#1878). The machine's secrets are removed before anything is stored
// (see secretPaths), so no Wi-Fi, MQTT or visualizer credential ever reaches the
// database; entries live in the machine_backups table keyed by machine id.
//
// This slice adds the automatic backup (Scheduler): the first time a Gaggiuino
// machine is reachable in a given local day or ISO week, per its schedule, its
// settings backup is fetched and stored as a new entry, but only when the
// content differs from the newest stored backup of that machine. It also adds
// the list, back up now and delete routes (handlers.go). Each machine has its
// own schedule (off/daily/weekly) and retention of automatic backups
// (settings.go). handlers.go also serves one stored document, the download (the
// machine's current secrets are merged into the response only, see
// mergeSecrets) and the upload (prepare strips the secrets before the insert).
// The restore path follows in a later slice.
package machinebackups

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/redact"
)

// Backup kinds; must match the CHECK constraint on machine_backups.kind.
const (
	KindManual    = "manual"
	KindScheduled = "scheduled"
	KindPreUpdate = "pre_update"
	KindUploaded  = "uploaded"
)

// documentFormat is the format field every Gaggiuino settings backup carries.
const documentFormat = "gaggiuino-settings"

// knownVersions lists the document versions GLP has checked for secret fields.
// A version missing here is rejected: GLP fails closed rather than storing a
// document whose new fields might carry a secret.
var knownVersions = map[string]bool{"1": true}

// secretPaths is THE one list of machine secrets GLP never stores (maintainer
// decision on #1878). The whole wifi block is a secret, so a restore never
// changes any network setting, whatever fields future firmware adds there.
// Every store path goes through prepare, so adding a path here is enough to
// keep it out of every backup.
var secretPaths = [][]string{
	{"wifi"},
	{"settings", "system", "mqttUsername"},
	{"settings", "system", "mqttPassword"},
	{"settings", "system", "visualizerToken"},
	{"settings", "system", "sprofilerToken"},
}

// ErrInvalidDocument reports a document GLP cannot store. Every rejection wraps
// it with a fixed reason string; the underlying json error is never wrapped,
// because its text can quote the input.
var ErrInvalidDocument = errors.New("not a Gaggiuino settings backup GLP can store")

// parseDocument decodes raw and checks it is a settings backup whose secret
// paths are structurally sane.
func parseDocument(raw []byte) (map[string]any, error) {
	if len(raw) == 0 || len(raw) > machines.MaxSettingsBackupBytes {
		return nil, fmt.Errorf("%w: empty or larger than 256 KiB", ErrInvalidDocument)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, fmt.Errorf("%w: not valid JSON", ErrInvalidDocument)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: trailing data after the document", ErrInvalidDocument)
	}
	doc, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%w: not a JSON object", ErrInvalidDocument)
	}
	if format, ok := doc["format"].(string); !ok || format != documentFormat {
		return nil, fmt.Errorf("%w: unknown format", ErrInvalidDocument)
	}
	version, ok := doc["version"].(json.Number)
	if !ok || !knownVersions[version.String()] {
		return nil, fmt.Errorf("%w: unknown version", ErrInvalidDocument)
	}
	for _, path := range secretPaths {
		if !parentsAreObjects(doc, path) {
			return nil, fmt.Errorf("%w: unexpected structure", ErrInvalidDocument)
		}
	}
	// The wifi block is stripped whole, so one that is not an object would
	// silently change the document's meaning.
	if wifi, ok := doc["wifi"]; ok {
		if _, isObject := wifi.(map[string]any); !isObject {
			return nil, fmt.Errorf("%w: unexpected structure", ErrInvalidDocument)
		}
	}
	return doc, nil
}

// parentsAreObjects reports whether every existing parent on path is a JSON
// object. A missing parent is fine: that secret simply is not in the document.
func parentsAreObjects(doc map[string]any, path []string) bool {
	current := any(doc)
	for _, key := range path[:len(path)-1] {
		obj, ok := current.(map[string]any)
		if !ok {
			return false
		}
		next, ok := obj[key]
		if !ok {
			return true
		}
		current = next
	}
	_, ok := current.(map[string]any)
	return ok
}

// stripSecrets deletes every secret path from doc; missing paths are fine.
func stripSecrets(doc map[string]any) {
	for _, path := range secretPaths {
		parent := doc
		found := true
		for _, key := range path[:len(path)-1] {
			next, ok := parent[key].(map[string]any)
			if !ok {
				found = false
				break
			}
			parent = next
		}
		if found {
			delete(parent, path[len(path)-1])
		}
	}
}

// mergeSecrets copies every secret path that exists in current, a fresh
// document from the machine, into stored and returns how many it copied.
// Missing parents are created; parseDocument already refused a document whose
// existing parent is not an object, so nothing is overwritten by a parent.
func mergeSecrets(stored, current map[string]any) int {
	copied := 0
	for _, path := range secretPaths {
		value, ok := valueAt(current, path)
		if !ok {
			continue
		}
		setValueAt(stored, path, value)
		copied++
	}
	return copied
}

func valueAt(doc map[string]any, path []string) (any, bool) {
	current := any(doc)
	for _, key := range path {
		obj, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		next, ok := obj[key]
		if !ok {
			return nil, false
		}
		current = next
	}
	return current, true
}

func setValueAt(doc map[string]any, path []string, value any) {
	parent := doc
	for _, key := range path[:len(path)-1] {
		next, ok := parent[key].(map[string]any)
		if !ok {
			next = map[string]any{}
			parent[key] = next
		}
		parent = next
	}
	parent[path[len(path)-1]] = value
}

// mergeDocuments returns the stored document with current's secrets, as
// canonical JSON. The result carries secrets: it goes to the response and
// nowhere else, never to the database or a log.
func mergeDocuments(storedData, currentRaw []byte) (merged []byte, copied int, err error) {
	stored, err := parseDocument(storedData)
	if err != nil {
		return nil, 0, err
	}
	current, err := parseDocument(currentRaw)
	if err != nil {
		return nil, 0, err
	}
	copied = mergeSecrets(stored, current)
	merged, err = encodeCanonical(stored)
	if err != nil {
		return nil, 0, err
	}
	return merged, copied, nil
}

// encodeCanonical renders doc as compact JSON. Map keys come out sorted and
// json.Number keeps the machine's number literals, so equal content always
// gives equal bytes; HTML escaping is off so the stored document stays exactly
// what the machine's parser expects.
func encodeCanonical(doc map[string]any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(doc); err != nil {
		return nil, fmt.Errorf("%w: unexpected structure", ErrInvalidDocument)
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// prepared is a document ready to be stored: secret-free canonical bytes plus
// the columns derived from them.
type prepared struct {
	Data             []byte
	Hash             string
	FirmwareCore     string
	FirmwareFrontend string
	ProfileCount     int
}

// prepare turns a raw machine document into its stored form. Every write path
// must go through it. The hash covers the whole secret-free document; no
// volatile fields are known (PLAN-1878.md open question 3).
func prepare(raw []byte) (prepared, error) {
	doc, err := parseDocument(raw)
	if err != nil {
		return prepared{}, err
	}
	stripSecrets(doc)
	data, err := encodeCanonical(doc)
	if err != nil {
		return prepared{}, err
	}
	// Canonical JSON can be larger than its input (encoding/json always writes
	// U+2028 and U+2029 as six-byte escapes), so the cap is checked again: GLP
	// never stores a document the machine could not take back.
	if len(data) > machines.MaxSettingsBackupBytes {
		return prepared{}, fmt.Errorf("%w: empty or larger than 256 KiB", ErrInvalidDocument)
	}
	sum := sha256.Sum256(data)
	p := prepared{Data: data, Hash: hex.EncodeToString(sum[:])}
	p.FirmwareCore, p.FirmwareFrontend = firmwareVersions(doc)
	if profiles, ok := doc["profiles"].([]any); ok {
		p.ProfileCount = len(profiles)
	}
	return p, nil
}

// firmwareVersions reads firmware.core and firmware.frontend, trimmed and cut
// to 64 runes; anything that is not a string becomes "".
func firmwareVersions(doc map[string]any) (core, frontend string) {
	firmware, ok := doc["firmware"].(map[string]any)
	if !ok {
		return "", ""
	}
	return shortString(firmware["core"]), shortString(firmware["frontend"])
}

func shortString(value any) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	runes := []rune(strings.TrimSpace(s))
	if len(runes) > 64 {
		runes = runes[:64]
	}
	return string(runes)
}

// Repository reads and writes machine backup rows.
type Repository struct {
	db *sql.DB

	// locks serializes all backup work on one machine (the scheduler,
	// Back up now and, from slice 5b, restore), keyed by machine id. It lives
	// here because main shares one Repository between the scheduler and the
	// handlers, the same way ProfilesRepository.MachineLock is shared.
	locks sync.Map // map[int64]*sync.Mutex

	// settingsMu serializes saveSettings' read-modify-write of the one kv row.
	settingsMu sync.Mutex
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

// machineLock returns the mutex for one machine's backup work. Callers
// TryLock: the scheduler skips a busy machine until the next tick, the
// handlers answer 409 operation_running.
func (r *Repository) machineLock(machineID int64) *sync.Mutex {
	mu, _ := r.locks.LoadOrStore(machineID, &sync.Mutex{})
	return mu.(*sync.Mutex)
}

// Entry is the metadata of one stored backup, the JSON shape of the API's
// MachineBackup. The stored document is deliberately not a field, so no list or
// create response can carry it.
type Entry struct {
	ID               int64  `json:"id"`
	MachineID        int64  `json:"machineId"`
	CreatedAt        int64  `json:"createdAt"` // Unix ms in the API, stored as Unix seconds
	Kind             string `json:"kind"`
	FirmwareCore     string `json:"firmwareCore"`
	FirmwareFrontend string `json:"firmwareFrontend"`
	ProfileCount     int    `json:"profileCount"`
	SizeBytes        int    `json:"sizeBytes"`
	ContentHash      string `json:"contentHash"`
	Note             string `json:"note"`
}

// insert stores one backup row and returns it in the API's shape, so a create
// response equals the later list row exactly.
func (r *Repository) insert(machineID int64, kind, note string, p prepared, at time.Time) (Entry, error) {
	res, err := r.db.Exec(`INSERT INTO machine_backups (
		machine_id, created_at, kind, firmware_core, firmware_frontend,
		profile_count, size_bytes, content_hash, note, data
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		machineID, at.Unix(), kind, p.FirmwareCore, p.FirmwareFrontend,
		p.ProfileCount, len(p.Data), p.Hash, note, string(p.Data))
	if err != nil {
		return Entry{}, fmt.Errorf("machinebackups: storing backup of machine %d: %w", machineID, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Entry{}, fmt.Errorf("machinebackups: storing backup of machine %d: %w", machineID, err)
	}
	return Entry{
		ID:               id,
		MachineID:        machineID,
		CreatedAt:        at.Unix() * 1000,
		Kind:             kind,
		FirmwareCore:     p.FirmwareCore,
		FirmwareFrontend: p.FirmwareFrontend,
		ProfileCount:     p.ProfileCount,
		SizeBytes:        len(p.Data),
		ContentHash:      p.Hash,
		Note:             note,
	}, nil
}

// list returns the metadata of the stored backups, newest first. machineID 0
// means every machine, including ones deleted from the registry: their backups
// stay listable.
func (r *Repository) list(machineID int64) ([]Entry, error) {
	rows, err := r.db.Query(`SELECT id, machine_id, created_at, kind, firmware_core,
		firmware_frontend, profile_count, size_bytes, content_hash, note
		FROM machine_backups WHERE (? = 0 OR machine_id = ?)
		ORDER BY created_at DESC, id DESC`, machineID, machineID)
	if err != nil {
		return nil, fmt.Errorf("machinebackups: listing backups: %w", err)
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.MachineID, &e.CreatedAt, &e.Kind, &e.FirmwareCore,
			&e.FirmwareFrontend, &e.ProfileCount, &e.SizeBytes, &e.ContentHash, &e.Note); err != nil {
			return nil, fmt.Errorf("machinebackups: listing backups: %w", err)
		}
		e.CreatedAt *= 1000
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("machinebackups: listing backups: %w", err)
	}
	return out, nil
}

// get reads one stored backup, with its stored document. found is false when no
// row has that id. The document is secret-free by construction (every write goes
// through prepare).
func (r *Repository) get(id int64) (e Entry, data string, found bool, err error) {
	err = r.db.QueryRow(`SELECT id, machine_id, created_at, kind, firmware_core,
		firmware_frontend, profile_count, size_bytes, content_hash, note, data
		FROM machine_backups WHERE id = ?`, id).Scan(&e.ID, &e.MachineID, &e.CreatedAt, &e.Kind,
		&e.FirmwareCore, &e.FirmwareFrontend, &e.ProfileCount, &e.SizeBytes, &e.ContentHash, &e.Note, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return Entry{}, "", false, nil
	}
	if err != nil {
		return Entry{}, "", false, fmt.Errorf("machinebackups: reading backup %d: %w", id, err)
	}
	e.CreatedAt *= 1000
	return e, data, true, nil
}

// remove deletes one backup row, of any kind and also one of a deleted machine.
// found is false when no row has that id.
func (r *Repository) remove(id int64) (bool, error) {
	res, err := r.db.Exec(`DELETE FROM machine_backups WHERE id = ?`, id)
	if err != nil {
		return false, fmt.Errorf("machinebackups: deleting backup %d: %w", id, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("machinebackups: deleting backup %d: %w", id, err)
	}
	return n == 1, nil
}

// pruneScheduled deletes the oldest automatic (scheduled) backups of
// machineID beyond keep. Manual, pre-update and uploaded backups are never
// touched. keep below 1 is refused, so a bug can never delete every automatic
// backup.
func (r *Repository) pruneScheduled(machineID int64, keep int) (int64, error) {
	if keep < minKeepAutomatic {
		return 0, fmt.Errorf("machinebackups: refusing to keep %d automatic backups", keep)
	}
	res, err := r.db.Exec(`DELETE FROM machine_backups WHERE id IN (
		SELECT id FROM machine_backups WHERE machine_id = ? AND kind = 'scheduled'
		ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)`, machineID, keep)
	if err != nil {
		return 0, fmt.Errorf("machinebackups: removing old automatic backups of machine %d: %w", machineID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("machinebackups: removing old automatic backups of machine %d: %w", machineID, err)
	}
	return n, nil
}

// newestHash returns the content hash of the newest backup of machineID, of any
// kind except uploaded. An uploaded file does not describe what is on the
// machine (maintainer decision), so the next automatic backup compares against
// the newest entry that does, and an unchanged machine stores no extra row
// after an upload. found is false when no such backup exists.
func (r *Repository) newestHash(machineID int64) (hash string, found bool, err error) {
	err = r.db.QueryRow(`SELECT content_hash FROM machine_backups
		WHERE machine_id = ? AND kind != 'uploaded'
		ORDER BY created_at DESC, id DESC LIMIT 1`, machineID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("machinebackups: reading newest backup hash of machine %d: %w", machineID, err)
	}
	return hash, true, nil
}

// Client is the subset of a machine adapter the scheduler needs.
type Client interface {
	GetStatus(ctx context.Context, m *machines.Machine) (machines.Status, error)
	GetSettingsBackup(ctx context.Context, m *machines.Machine) ([]byte, error)
}

var _ Client = (*machines.GaggiuinoAdapter)(nil)

// AdapterProvider is the machine handler surface that resolves an adapter for a
// machine (machines.Handlers.GetAdapter).
type AdapterProvider interface {
	GetAdapter(m *machines.Machine) (machines.Adapter, error)
}

// ClientFor turns p into the scheduler's per-machine client lookup. Only a
// Gaggiuino machine whose adapter implements Client gets one.
func ClientFor(p AdapterProvider) func(m *machines.Machine) (Client, bool) {
	return func(m *machines.Machine) (Client, bool) {
		if p == nil || m == nil || m.Type != "gaggiuino" {
			return nil, false
		}
		adapter, err := p.GetAdapter(m)
		if err != nil {
			return nil, false
		}
		c, ok := adapter.(Client)
		return c, ok
	}
}

const (
	schedulerStartDelay = 2 * time.Minute
	schedulerInterval   = 5 * time.Minute
	schedulerRetryAfter = 30 * time.Minute
)

var (
	errMachineOffline = errors.New("machine did not answer the status request")
	errMachineBusy    = errors.New("machine is brewing or steaming")
)

// fetchPrepared fetches the machine's settings backup and prepares it for
// storing, unless the machine is off or busy. The scheduler and Back up now both
// use it, so they follow the same rules (never load the machine during a shot or
// while steaming).
func fetchPrepared(ctx context.Context, c Client, m *machines.Machine) (prepared, error) {
	raw, err := fetchDocument(ctx, c, m)
	if err != nil {
		return prepared{}, err
	}
	return prepare(raw)
}

// fetchDocument reads the machine's raw settings backup, unless the machine is
// off or busy. The returned bytes still carry the machine's secrets, so a caller
// must never store or log them. The status error is dropped on purpose: it can
// carry the machine's host.
func fetchDocument(ctx context.Context, c Client, m *machines.Machine) ([]byte, error) {
	status, err := c.GetStatus(ctx, m)
	if err != nil {
		return nil, errMachineOffline
	}
	if status.Brewing || (status.SteamOn != nil && *status.SteamOn) {
		return nil, errMachineBusy
	}
	return c.GetSettingsBackup(ctx, m)
}

// MachineLister lists the machines the scheduler should consider.
type MachineLister interface {
	ListMachines() ([]machines.Machine, error)
}

// SchedulerDeps are the scheduler's collaborators. KnownOffline and Now are
// optional.
type SchedulerDeps struct {
	Repo         *Repository
	Machines     MachineLister
	Client       func(*machines.Machine) (Client, bool)
	KnownOffline func(machineID int64) bool
	Now          func() time.Time
}

// Scheduler takes one automatic settings backup per machine per local day or ISO
// week, per that machine's Settings; off machines are never contacted. The
// in-memory checked map means a GLP restart re-checks once per period, and change
// detection keeps that a no-op unless the content changed. checked, retryAt and
// unsupportedLogged are keyed by machine id and only ever touched by the
// scheduler goroutine, so there is no mutex here; the per-machine
// Repository.machineLock serializes its machine calls with Back up now.
type Scheduler struct {
	deps              SchedulerDeps
	checked           map[int64]time.Time
	retryAt           map[int64]time.Time
	unsupportedLogged map[int64]bool
}

func NewScheduler(d SchedulerDeps) *Scheduler {
	return &Scheduler{
		deps:              d,
		checked:           map[int64]time.Time{},
		retryAt:           map[int64]time.Time{},
		unsupportedLogged: map[int64]bool{},
	}
}

// Start runs the scheduler loop in the background until ctx is done: a short
// start delay, then one tick every schedulerInterval.
func (s *Scheduler) Start(ctx context.Context) {
	httputil.SafeGo("machinebackups: scheduler", func() {
		timer := time.NewTimer(schedulerStartDelay)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
			s.tick(ctx)
			timer.Reset(schedulerInterval)
		}
	})
}

// tick considers every registered machine. One machine's failure never stops
// the others.
func (s *Scheduler) tick(ctx context.Context) {
	list, err := s.deps.Machines.ListMachines()
	if err != nil {
		log.Printf("machinebackups: listing machines: %s", redact.Redact(err.Error()))
		return
	}
	settings, err := s.deps.Repo.allSettings()
	if err != nil {
		// Never guess: the default retention could prune rows a user chose to keep.
		log.Printf("machinebackups: reading backup settings: %s", redact.Redact(err.Error()))
		return
	}
	for i := range list {
		s.backupIfDue(ctx, &list[i], settings.forMachine(list[i].ID))
	}
}

func (s *Scheduler) backupIfDue(ctx context.Context, m *machines.Machine, set Settings) {
	if m == nil || !m.Enabled || m.Type != "gaggiuino" || strings.TrimSpace(m.Host) == "" {
		return
	}
	if set.Schedule == ScheduleOff {
		return
	}
	now := s.now()
	if at, ok := s.checked[m.ID]; ok && checkedThisPeriod(set.Schedule, at, now) {
		return
	}
	if at, ok := s.retryAt[m.ID]; ok && now.Before(at) {
		return
	}
	if s.deps.KnownOffline != nil && s.deps.KnownOffline(m.ID) {
		return
	}
	c, ok := s.deps.Client(m)
	if !ok || c == nil {
		return
	}
	mu := s.deps.Repo.machineLock(m.ID)
	if !mu.TryLock() {
		return // Back up now (or a restore) is busy with this machine: try next tick
	}
	defer mu.Unlock()
	p, err := fetchPrepared(ctx, c, m)
	switch {
	case errors.Is(err, errMachineOffline), errors.Is(err, errMachineBusy):
		// A machine being off is the normal case for most of the day, and a busy
		// one is left alone: try again on the next tick, with no backoff and no log.
		return
	case errors.Is(err, machines.ErrSettingsBackupUnsupported):
		s.checked[m.ID] = now
		if !s.unsupportedLogged[m.ID] {
			s.unsupportedLogged[m.ID] = true
			log.Printf("machinebackups: machine %d firmware has no settings backup (needs Gaggiuino main-8aaf6f0 or later)", m.ID)
		}
		return
	case errors.Is(err, ErrInvalidDocument):
		// A document GLP cannot read will not become readable today.
		s.checked[m.ID] = now
		log.Printf("machinebackups: machine %d sent a settings backup GLP cannot store: %s", m.ID, redact.Redact(err.Error()))
		return
	case err != nil:
		s.failed(m.ID, now, err)
		return
	}
	hash, found, err := s.deps.Repo.newestHash(m.ID)
	if err != nil {
		s.failed(m.ID, now, err)
		return
	}
	if found && hash == p.Hash {
		s.checked[m.ID] = now
		return
	}
	if _, err := s.deps.Repo.insert(m.ID, KindScheduled, "", p, now); err != nil {
		s.failed(m.ID, now, err)
		return
	}
	s.checked[m.ID] = now
	log.Printf("machinebackups: stored automatic backup of machine %d (%d profiles, %d bytes)", m.ID, p.ProfileCount, len(p.Data))
	if removed, err := s.deps.Repo.pruneScheduled(m.ID, set.KeepAutomatic); err != nil {
		log.Printf("machinebackups: removing old automatic backups of machine %d failed: %s", m.ID, redact.Redact(err.Error()))
	} else if removed > 0 {
		log.Printf("machinebackups: removed %d old automatic backups of machine %d (keeping %d)", removed, m.ID, set.KeepAutomatic)
	}
}

// failed backs the machine off for schedulerRetryAfter and logs the redacted
// reason.
func (s *Scheduler) failed(machineID int64, now time.Time, err error) {
	s.retryAt[machineID] = now.Add(schedulerRetryAfter)
	log.Printf("machinebackups: automatic backup of machine %d failed: %s", machineID, redact.Redact(err.Error()))
}

func (s *Scheduler) now() time.Time {
	if s.deps.Now != nil {
		return s.deps.Now()
	}
	return time.Now()
}

// sameLocalDay compares the app's local day, so a machine that is off at night
// is backed up the first time it is on the next day.
func sameLocalDay(a, b time.Time) bool {
	a, b = a.Local(), b.Local()
	return a.Year() == b.Year() && a.YearDay() == b.YearDay()
}

// checkedThisPeriod reports whether a check at `at` already covers now under
// schedule: the same local day for daily, the same local ISO week for weekly.
func checkedThisPeriod(schedule string, at, now time.Time) bool {
	if schedule == ScheduleWeekly {
		return sameISOWeek(at, now)
	}
	return sameLocalDay(at, now)
}

// sameISOWeek compares the local ISO week, so a weekly schedule resets on Monday
// rather than on the first of the month.
func sameISOWeek(a, b time.Time) bool {
	ay, aw := a.Local().ISOWeek()
	by, bw := b.Local().ISOWeek()
	return ay == by && aw == bw
}
