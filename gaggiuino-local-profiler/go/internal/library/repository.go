package library

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
)

// Repository ports lib/repositories/LibraryRepository.js's getLibrary()/
// saveLibrary() — the only two LibraryRepository methods this phase needs.
// Every other LibraryRepository method (getMaintenance/saveMaintenance/
// getMaintenanceLog/addMaintenanceLogEntry/the raw maintenance backup
// round-trip) belongs to the maintenance domain (routes/maintenance.js),
// still a Phase 0 placeholder (internal/maintenance) — see doc.go and
// handlers.go's deleteGrinder doc comment for the one place this package
// would otherwise need them.
type Repository struct {
	db *sql.DB
}

// NewRepository wraps an already-open *sql.DB (see internal/db.Open).
func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

// libraryRow mirrors the JSON shape stored under library.key = 'main' —
// decoded leniently (a stored blob predating a given collection simply
// leaves that Go slice nil, cleaned up to [] by GetLibrary below), not
// necessarily the same shape as the Library struct's own json tags (kept
// identical here deliberately, but decoded into its own type to keep the
// "raw stored shape" and "always-non-nil public shape" concerns separate).
type libraryRow struct {
	Beans       []Entity `json:"beans"`
	Grinders    []Entity `json:"grinders"`
	Recipes     []Entity `json:"recipes"`
	Milks       []Entity `json:"milks"`
	Baskets     []Entity `json:"baskets"`
	PuckScreens []Entity `json:"puckScreens"`
}

// GetLibrary ports LibraryRepository.js's getLibrary(): reads the single
// `library` row (key='main'), falling back to an empty Library (every
// collection []) when no row exists yet — a fresh install's first read.
func (r *Repository) GetLibrary() (Library, error) {
	var raw string
	err := r.db.QueryRow(`SELECT data FROM library WHERE key = 'main'`).Scan(&raw)
	if err == sql.ErrNoRows {
		return newLibrary(), nil
	}
	if err != nil {
		return Library{}, fmt.Errorf("library: reading library: %w", err)
	}
	var row libraryRow
	if err := json.Unmarshal([]byte(raw), &row); err != nil {
		return Library{}, fmt.Errorf("library: decoding library: %w", err)
	}
	lib := Library{
		Beans:       row.Beans,
		Grinders:    row.Grinders,
		Recipes:     row.Recipes,
		Milks:       row.Milks,
		Baskets:     row.Baskets,
		PuckScreens: row.PuckScreens,
	}
	if lib.Beans == nil {
		lib.Beans = []Entity{}
	}
	if lib.Grinders == nil {
		lib.Grinders = []Entity{}
	}
	if lib.Recipes == nil {
		lib.Recipes = []Entity{}
	}
	if lib.Milks == nil {
		lib.Milks = []Entity{}
	}
	if lib.Baskets == nil {
		lib.Baskets = []Entity{}
	}
	if lib.PuckScreens == nil {
		lib.PuckScreens = []Entity{}
	}
	return lib, nil
}

// SaveLibrary ports LibraryRepository.js's saveLibrary(lib): an
// INSERT-OR-REPLACE upsert of the whole blob under key='main', same
// whole-document-rewrite semantics as the Node original.
//
// Production writes must NOT call this directly: a bare
// read-mutate-save round trip on the shared blob races every other writer,
// so every read-modify-write goes through Update (below), which takes the
// package write lock first. SaveLibrary remains exported only for tests and
// for seeding a whole Library blob from other packages.
func (r *Repository) SaveLibrary(lib Library) error {
	b, err := json.Marshal(lib)
	if err != nil {
		return fmt.Errorf("library: encoding library: %w", err)
	}
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO library (key, data) VALUES ('main', ?)`, string(b)); err != nil {
		return fmt.Errorf("library: saving library: %w", err)
	}
	return nil
}

// writeMu serialises every read-modify-write of the single library blob
// (key='main', see Update). It is package-level rather than a Repository
// field because callers in other packages hold their own *Repository over
// the same *sql.DB, and a per-value mutex would not cover them. GetLibrary
// and SaveLibrary stay unlocked so read-only callers never block.
var writeMu sync.Mutex

// ErrSkipSave is a sentinel an Update callback returns to abort the write
// without turning it into a failure: Update returns it unchanged so a
// caller can map "nothing matched / nothing to change" onto its own no-op
// result.
var ErrSkipSave = errors.New("library: update skipped")

// Update serialises a read-modify-write of the whole library: it takes the
// package write lock, loads the library, hands it to fn, and — only when fn
// returns nil — saves the result. An error from fn aborts the save and is
// returned as-is (ErrSkipSave is the conventional "nothing to change"
// abort).
//
// fn must not call GetLibrary, SaveLibrary or Update: the lock is not
// re-entrant and fn runs while it is held, so keep fn pure — no network or
// Home Assistant calls inside.
func (r *Repository) Update(fn func(lib *Library) error) error {
	writeMu.Lock()
	defer writeMu.Unlock()

	lib, err := r.GetLibrary()
	if err != nil {
		return err
	}
	if err := fn(&lib); err != nil {
		return err
	}
	return r.SaveLibrary(lib)
}
