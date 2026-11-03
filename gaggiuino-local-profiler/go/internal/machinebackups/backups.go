// Package machinebackups keeps a versioned list of Gaggiuino machine settings
// backups (#1878). The machine's secrets are removed before anything is stored
// (see secretPaths), so no Wi-Fi, MQTT or visualizer credential ever reaches the
// database; entries live in the machine_backups table keyed by machine id.
//
// This slice adds the automatic daily backup: the first time a Gaggiuino
// machine is reachable on a given local day, its settings backup is fetched and
// stored as a new entry, but only when the content differs from the newest
// stored backup of that machine. Later slices add the routes, the restore path
// and the GLP backup bundle.
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
type Repository struct{ db *sql.DB }

func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

// insert stores one backup row and returns its id.
func (r *Repository) insert(machineID int64, kind, note string, p prepared, at time.Time) (int64, error) {
	res, err := r.db.Exec(`INSERT INTO machine_backups (
		machine_id, created_at, kind, firmware_core, firmware_frontend,
		profile_count, size_bytes, content_hash, note, data
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		machineID, at.Unix(), kind, p.FirmwareCore, p.FirmwareFrontend,
		p.ProfileCount, len(p.Data), p.Hash, note, string(p.Data))
	if err != nil {
		return 0, fmt.Errorf("machinebackups: storing backup of machine %d: %w", machineID, err)
	}
	return res.LastInsertId()
}

// newestHash returns the content hash of the newest backup of machineID, of any
// kind. found is false when the machine has no backup yet.
func (r *Repository) newestHash(machineID int64) (hash string, found bool, err error) {
	err = r.db.QueryRow(`SELECT content_hash FROM machine_backups
		WHERE machine_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, machineID).Scan(&hash)
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

// Scheduler takes one automatic settings backup per machine per local day.
// checked, retryAt and unsupportedLogged are keyed by machine id and only ever
// touched by the scheduler goroutine, so there is no mutex in this slice.
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
	for i := range list {
		s.backupIfDue(ctx, &list[i])
	}
}

func (s *Scheduler) backupIfDue(ctx context.Context, m *machines.Machine) {
	if m == nil || !m.Enabled || m.Type != "gaggiuino" || strings.TrimSpace(m.Host) == "" {
		return
	}
	now := s.now()
	if at, ok := s.checked[m.ID]; ok && sameLocalDay(at, now) {
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
	// A machine being off is the normal case for most of the day: try again on
	// the next tick, with no backoff and no log line.
	status, err := c.GetStatus(ctx, m)
	if err != nil {
		return
	}
	if status.Brewing || (status.SteamOn != nil && *status.SteamOn) {
		return
	}
	raw, err := c.GetSettingsBackup(ctx, m)
	if err != nil {
		if errors.Is(err, machines.ErrSettingsBackupUnsupported) {
			s.checked[m.ID] = now
			if !s.unsupportedLogged[m.ID] {
				s.unsupportedLogged[m.ID] = true
				log.Printf("machinebackups: machine %d firmware has no settings backup (needs Gaggiuino main-8aaf6f0 or later)", m.ID)
			}
			return
		}
		s.failed(m.ID, now, err)
		return
	}
	p, err := prepare(raw)
	if err != nil {
		// A document GLP cannot read will not become readable today.
		s.checked[m.ID] = now
		log.Printf("machinebackups: machine %d sent a settings backup GLP cannot store: %s", m.ID, redact.Redact(err.Error()))
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
